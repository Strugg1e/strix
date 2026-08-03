"""Local-only scan console and subprocess lifecycle management."""
# ruff: noqa: RUF001

from __future__ import annotations

import argparse
import json
import math
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from rich.console import Console

from strix.config.loader import load_settings
from strix.core.inputs import DEFAULT_REPORT_LANGUAGE, REPORT_LANGUAGES
from strix.core.paths import latest_run_dir, run_record_path, runs_base_dir, runtime_state_dir
from strix.interface.console_progress import build_run_snapshot
from strix.interface.console_projects import ProjectStore, ProjectValidationError
from strix.interface.viewer.server import authorized_url, bundle_is_built, open_browser, serve


_RUN_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$")
_SCAN_MODES = frozenset({"quick", "standard", "deep"})
_SCOPE_MODES = frozenset({"auto", "diff", "full"})
_MAX_INSTRUCTION_LENGTH = 20_000
_MAX_LOG_BYTES = 2_000_000
_PROFILES_PATH = Path.home() / ".strix" / "console-profiles.json"
_KEYCHAIN_SERVICE_PREFIX = "strix-console-profile:"
_PROXY_ENV_NAMES = frozenset({"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"})


class ConsoleRequestError(ValueError):
    """A client-visible validation or lifecycle error."""

    def __init__(self, message: str, status: HTTPStatus = HTTPStatus.BAD_REQUEST) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class ConsoleJob:
    id: str
    run_name: str
    target: str
    target_kind: str
    scan_mode: str
    scope_mode: str
    max_turns: int
    status: str
    started_at: str
    finished_at: str | None = None
    returncode: int | None = None
    pid: int | None = None
    resumed: bool = False
    profile_id: str = "environment"
    profile_name: str = "当前环境"
    model: str = ""
    targets: list[dict[str, str]] = field(default_factory=list)
    project_id: str = ""
    project_name: str = ""
    max_budget_usd: float | None = None
    use_proxy: bool = False
    report_language: str = DEFAULT_REPORT_LANGUAGE


@dataclass(frozen=True)
class LLMProfile:
    id: str
    name: str
    model: str
    api_base: str
    has_api_key: bool
    readonly: bool = False


class ProfileStore:
    """Persist non-secret profile metadata and keep API keys in macOS Keychain."""

    def __init__(self, path: Path = _PROFILES_PATH) -> None:
        self.path = path
        self._lock = threading.RLock()

    def list_profiles(self) -> list[dict[str, Any]]:
        settings = load_settings()
        environment = LLMProfile(
            id="environment",
            name="当前环境",
            model=settings.llm.model or "",
            api_base=settings.llm.api_base or "",
            has_api_key=bool(settings.llm.api_key),
            readonly=True,
        )
        with self._lock:
            saved = self._read()
        return [asdict(environment), *saved]

    def resolve(self, profile_id: str) -> tuple[dict[str, Any], str]:
        if profile_id == "environment":
            settings = load_settings()
            if not settings.llm.model:
                raise ConsoleRequestError("当前环境没有配置模型")
            return (
                {
                    "id": "environment",
                    "name": "当前环境",
                    "model": settings.llm.model,
                    "api_base": settings.llm.api_base or "",
                },
                settings.llm.api_key or "",
            )
        with self._lock:
            profile = next((item for item in self._read() if item["id"] == profile_id), None)
        if profile is None:
            raise ConsoleRequestError("找不到该 LLM 配置", HTTPStatus.NOT_FOUND)
        return profile, self._read_key(profile_id)

    def save(self, payload: dict[str, Any]) -> dict[str, Any]:
        profile_id = str(payload.get("id") or "").strip()
        name = str(payload.get("name") or "").strip()
        model = str(payload.get("model") or "").strip()
        api_base = str(payload.get("api_base") or "").strip().rstrip("/")
        api_key = str(payload.get("api_key") or "").strip()

        if profile_id == "environment":
            raise ConsoleRequestError("当前环境配置为只读，请新建配置档")
        if not name or len(name) > 80:
            raise ConsoleRequestError("配置名称长度必须在 1 到 80 个字符之间")
        if not model or len(model) > 200:
            raise ConsoleRequestError("模型名称长度必须在 1 到 200 个字符之间")
        self._validate_api_base(api_base)
        if api_key and len(api_key) > 4096:
            raise ConsoleRequestError("API Key 过长")

        with self._lock:
            profiles = self._read()
            existing = next((item for item in profiles if item["id"] == profile_id), None)
            if not profile_id:
                profile_id = f"profile_{os.urandom(6).hex()}"
            elif not _RUN_NAME_RE.fullmatch(profile_id):
                raise ConsoleRequestError("无效的配置 ID")
            if existing is None and not api_key:
                raise ConsoleRequestError("新配置必须提供 API Key")
            if api_key:
                self._write_key(profile_id, api_key)
            has_api_key = bool(api_key) or (existing is not None and existing["has_api_key"])
            record = asdict(
                LLMProfile(
                    id=profile_id,
                    name=name,
                    model=model,
                    api_base=api_base,
                    has_api_key=has_api_key,
                )
            )
            profiles = [record if item["id"] == profile_id else item for item in profiles]
            if existing is None:
                profiles.append(record)
            self._write(profiles)
        return record

    def delete(self, profile_id: str) -> None:
        if profile_id == "environment":
            raise ConsoleRequestError("当前环境配置不能删除")
        with self._lock:
            profiles = self._read()
            if not any(item["id"] == profile_id for item in profiles):
                raise ConsoleRequestError("找不到该 LLM 配置", HTTPStatus.NOT_FOUND)
            self._write([item for item in profiles if item["id"] != profile_id])
            self._delete_key(profile_id)

    def test(self, profile_id: str) -> dict[str, Any]:
        profile, api_key = self.resolve(profile_id)
        if not api_key:
            raise ConsoleRequestError("该配置没有可用的 API Key")
        endpoint = f"{profile['api_base'].rstrip('/')}/models"
        request = urllib.request.Request(  # noqa: S310
            endpoint,
            headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
        )
        started = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=12) as response:  # noqa: S310
                status = response.status
        except urllib.error.HTTPError as exc:
            if exc.code in {401, 403}:
                raise ConsoleRequestError(
                    "认证失败，请检查 API Key",
                    HTTPStatus.BAD_REQUEST,
                ) from exc
            if exc.code == 404:
                return {
                    "ok": True,
                    "latency_ms": round((time.monotonic() - started) * 1000),
                    "message": "服务可访问，但未提供 /models 接口",
                }
            raise ConsoleRequestError(f"服务返回 HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            reason = exc.reason if hasattr(exc, "reason") else exc
            raise ConsoleRequestError(f"连接失败：{reason}") from exc
        return {
            "ok": 200 <= status < 300,
            "latency_ms": round((time.monotonic() - started) * 1000),
            "message": "连接与认证正常",
        }

    def _read(self) -> list[dict[str, Any]]:
        if not self.path.is_file():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        profiles = data.get("profiles") if isinstance(data, dict) else None
        if not isinstance(profiles, list):
            return []
        valid: list[dict[str, Any]] = []
        for item in profiles:
            if not isinstance(item, dict):
                continue
            if not all(
                isinstance(item.get(field), str) for field in ("id", "name", "model", "api_base")
            ):
                continue
            valid.append(
                {
                    "id": item["id"],
                    "name": item["name"],
                    "model": item["model"],
                    "api_base": item["api_base"],
                    "has_api_key": item.get("has_api_key") is True,
                    "readonly": False,
                }
            )
        return valid

    def _write(self, profiles: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps({"profiles": profiles}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        self.path.chmod(0o600)

    @staticmethod
    def _validate_api_base(api_base: str) -> None:
        parts = urlsplit(api_base)
        local_hosts = {"127.0.0.1", "localhost", "::1"}
        valid = parts.scheme == "https" or (
            parts.scheme == "http" and parts.hostname in local_hosts
        )
        if not valid or not parts.netloc or parts.username or parts.password:
            raise ConsoleRequestError("Base URL 必须是 HTTPS，或本机 HTTP 地址")

    @staticmethod
    def _service(profile_id: str) -> str:
        return f"{_KEYCHAIN_SERVICE_PREFIX}{profile_id}"

    def _write_key(self, profile_id: str, api_key: str) -> None:
        if sys.platform != "darwin":
            raise ConsoleRequestError("当前系统暂不支持安全保存 API Key")
        result = subprocess.run(  # noqa: S603
            [
                "/usr/bin/security",
                "add-generic-password",
                "-U",
                "-a",
                os.environ.get("USER", "strix"),
                "-s",
                self._service(profile_id),
                "-w",
                api_key,
            ],
            capture_output=True,
            check=False,
        )
        if result.returncode != 0:
            raise ConsoleRequestError("无法将 API Key 保存到 macOS Keychain")

    def _read_key(self, profile_id: str) -> str:
        if sys.platform != "darwin":
            return ""
        result = subprocess.run(  # noqa: S603
            [
                "/usr/bin/security",
                "find-generic-password",
                "-a",
                os.environ.get("USER", "strix"),
                "-s",
                self._service(profile_id),
                "-w",
            ],
            capture_output=True,
            check=False,
            text=True,
        )
        return result.stdout.strip() if result.returncode == 0 else ""

    def _delete_key(self, profile_id: str) -> None:
        if sys.platform != "darwin":
            return
        subprocess.run(  # noqa: S603
            [
                "/usr/bin/security",
                "delete-generic-password",
                "-a",
                os.environ.get("USER", "strix"),
                "-s",
                self._service(profile_id),
            ],
            capture_output=True,
            check=False,
        )


class RunManager:
    """Coordinate independently managed Strix subprocesses.

    The console used to keep one ``_active``/``_process`` pair.  Keeping the
    lifecycle in two keyed maps makes the public operations still small while
    allowing each run to be stopped, snapshotted, logged, or steered without
    affecting another run.  The maps intentionally remain in-memory: run
    directories and ``.console/run-settings.json`` are the durable projection,
    and a manager created after a service restart must not pretend it can own
    an external process.
    """

    def __init__(
        self,
        work_dir: Path,
        profile_store: ProfileStore | None = None,
        project_store: ProjectStore | None = None,
    ) -> None:
        self.work_dir = work_dir.resolve()
        self.runs_dir = runs_base_dir(cwd=self.work_dir)
        self.log_dir = self.runs_dir / ".console"
        self._lock = threading.RLock()
        self._jobs: dict[str, ConsoleJob] = {}
        self._processes: dict[str, subprocess.Popen[bytes]] = {}
        self._log_handles: dict[str, Any] = {}
        self.profile_store = profile_store or ProfileStore()
        self.project_store = project_store or ProjectStore(self.log_dir / "projects.json")

    def status_payload(self) -> dict[str, Any]:
        with self._lock:
            active_jobs = self._active_jobs_locked()
            # ``active_job`` is retained as a compatibility projection for the
            # original single-run consumers.  New consumers should use the
            # complete ``active_jobs`` list and ``running_count``.
            active: dict[str, Any] | None
            if active_jobs:
                active = active_jobs[0]
            else:
                latest = max(
                    self._jobs.values(),
                    key=lambda item: (item.started_at, item.id),
                    default=None,
                )
                active = asdict(latest) if latest is not None else None
        profiles = self.profile_store.list_profiles()
        return {
            "active_job": active,
            "active_jobs": active_jobs,
            "running_count": len(active_jobs),
            "profiles": profiles,
            "default_profile_id": "environment",
            "work_dir": str(self.work_dir),
            "single_run_only": False,
        }

    def run_snapshot(self, run_name: str) -> dict[str, Any]:
        """Return a safe progress snapshot for an active or historical run."""
        if not _RUN_NAME_RE.fullmatch(run_name):
            raise ConsoleRequestError("无效的任务名称")
        base = self.runs_dir.resolve()
        candidate = (base / run_name).resolve()
        if candidate.parent != base:
            raise ConsoleRequestError("无效的任务路径")
        with self._lock:
            job = next(
                (candidate for candidate in self._jobs.values() if candidate.run_name == run_name),
                None,
            )
            active = asdict(job) if job else None
        if active is None and not run_record_path(candidate).is_file():
            raise ConsoleRequestError("找不到该任务", HTTPStatus.NOT_FOUND)
        return build_run_snapshot(candidate, job=active)

    def _active_jobs_locked(self) -> list[dict[str, Any]]:
        """Return jobs whose process is still alive, in start order.

        ``Popen.poll`` is consulted in addition to the watcher state.  This
        keeps the count accurate during the small interval between process exit
        and the watcher acquiring the manager lock.
        """
        active: list[ConsoleJob] = []
        for job_id, process in list(self._processes.items()):
            if process.poll() is None:
                job = self._jobs.get(job_id)
                if job is not None:
                    active.append(job)
        active.sort(key=lambda item: (item.started_at, item.id))
        return [asdict(job) for job in active]

    def enrich_run_entry(self, entry: dict[str, Any], run_dir: Path) -> dict[str, Any]:
        """Add console/project facts to a history entry.

        The run's own settings (or the in-memory job while it is live) are the
        authoritative association.  ``ProjectStore.run_names`` is consulted
        only as a compatibility fallback for projects written by older
        console versions.
        """
        run_name = str(entry.get("name") or run_dir.name)
        settings = self._load_run_settings(run_name)
        record: dict[str, Any] = {}
        try:
            raw = json.loads(run_record_path(run_dir).read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                record = raw
        except (OSError, json.JSONDecodeError):
            pass

        with self._lock:
            job = self._jobs.get(run_name)
            process = self._processes.get(run_name)
            managed = bool(job is not None and process is not None and process.poll() is None)
            if job is not None:
                project_id = job.project_id
                project_name = job.project_name
            else:
                project_id = str(settings.get("project_id") or record.get("project_id") or "")
                project_name = str(settings.get("project_name") or record.get("project_name") or "")

        if not project_id:
            # Compatibility for project files created before project metadata
            # was persisted with each run.  Never use this as the primary
            # filter/count source when task-side metadata is available.
            try:
                for project in self.project_store.list_projects():
                    if run_name in project.get("run_names", []):
                        project_id = str(project.get("id") or "")
                        project_name = str(project.get("name") or "")
                        break
            except (OSError, ValueError):
                pass

        entry.update(
            {
                "project_id": project_id,
                "project_name": project_name or "未分配项目",
                "managed": managed,
                "report_available": (run_dir / "penetration_test_report.md").is_file(),
            }
        )
        return entry

    def start(self, payload: dict[str, Any]) -> dict[str, Any]:  # noqa: PLR0912, PLR0915
        project_id = str(payload.get("project_id") or "").strip()
        project: dict[str, Any] | None = None
        defaults: dict[str, Any] = {}
        if project_id:
            try:
                project = self.project_store.get(project_id)
            except ProjectValidationError as exc:
                raise ConsoleRequestError(str(exc), HTTPStatus.NOT_FOUND) from exc
            defaults = project["defaults"]
            requested_ids = payload.get("asset_ids")
            selected_ids = (
                {str(value) for value in requested_ids}
                if isinstance(requested_ids, list) and requested_ids
                else {item["id"] for item in project["assets"] if item.get("enabled", True)}
            )
            assets = [item for item in project["assets"] if item["id"] in selected_ids]
            if selected_ids - {item["id"] for item in assets}:
                raise ConsoleRequestError("选择的资产不属于该项目")
            confirmation = str(payload.get("confirmation") or "").strip()
            if confirmation != project["name"]:
                raise ConsoleRequestError("项目名称确认不一致，请重新确认")
        else:
            assets = self._legacy_assets(payload)
            target = assets[0]["value"] if assets else ""
            confirmation = str(payload.get("confirmation") or "").strip()
            if confirmation != target:
                raise ConsoleRequestError("目标确认内容不一致，请重新确认")

        if not assets:
            raise ConsoleRequestError("请至少选择一个扫描资产")
        scan_mode = str(payload.get("scan_mode") or defaults.get("scan_mode") or "quick")
        scope_mode = str(payload.get("scope_mode") or defaults.get("scope_mode") or "auto")
        instruction = str(
            payload.get("instruction")
            if "instruction" in payload
            else defaults.get("instruction") or ""
        ).strip()
        instruction_file = str(
            payload.get("instruction_file")
            if "instruction_file" in payload
            else defaults.get("instruction_file") or ""
        ).strip()
        diff_base = str(
            payload.get("diff_base") if "diff_base" in payload else defaults.get("diff_base") or ""
        ).strip()
        config_path = str(
            payload.get("config_path")
            if "config_path" in payload
            else defaults.get("config_path") or ""
        ).strip()
        max_turns = payload.get("max_turns", defaults.get("max_turns", 40))
        max_budget_usd = payload.get(
            "max_budget_usd",
            defaults.get("max_budget_usd"),
        )
        profile_id = str(payload.get("profile_id") or defaults.get("profile_id") or "environment")
        profile, api_key = self.profile_store.resolve(profile_id)
        model = str(payload.get("model") or defaults.get("model") or profile["model"]).strip()
        if not model or len(model) > 200:
            raise ConsoleRequestError("任务模型长度必须在 1 到 200 个字符之间")

        if scan_mode not in _SCAN_MODES:
            raise ConsoleRequestError("不支持的扫描模式")
        if scope_mode not in _SCOPE_MODES:
            raise ConsoleRequestError("不支持的范围模式")
        if len(instruction) > _MAX_INSTRUCTION_LENGTH:
            raise ConsoleRequestError("补充指令不能超过 20,000 个字符")
        if instruction and instruction_file:
            raise ConsoleRequestError("补充指令与指令文件只能选择一种")
        if isinstance(max_turns, bool) or not isinstance(max_turns, int):
            raise ConsoleRequestError("最大轮次必须是整数")
        if not 1 <= max_turns <= 500:
            raise ConsoleRequestError("最大轮次必须在 1 到 500 之间")
        budget = self._validate_budget(max_budget_usd)
        use_proxy = self._resolve_bool_option(
            payload,
            defaults,
            "use_proxy",
            default=False,
            label="代理策略",
        )
        report_language = self._resolve_report_language(payload, defaults)
        assets = [self._resolve_asset(item) for item in assets]
        instruction_file = self._resolve_file(instruction_file, "指令文件")
        config_path = self._resolve_file(config_path, "配置文件")

        with self._lock:
            run_name = self._new_run_name()
            command = [
                sys.executable,
                "-m",
                "strix.interface.main",
                "--run-name",
                run_name,
                "--non-interactive",
                "--console-managed",
                "--scan-mode",
                scan_mode,
                "--scope-mode",
                scope_mode,
                "--report-language",
                report_language,
                "--max-turns",
                str(max_turns),
            ]
            for asset in assets:
                option = {
                    "target": "--target",
                    "mount": "--mount",
                    "target_list": "--target-list",
                }[asset["kind"]]
                command.extend([option, asset["value"]])
            if instruction:
                command.extend(["--instruction", instruction])
            if instruction_file:
                command.extend(["--instruction-file", instruction_file])
            if diff_base:
                command.extend(["--diff-base", diff_base])
            if config_path:
                command.extend(["--config", config_path])
            if budget is not None:
                command.extend(["--max-budget", str(budget)])
            child_env = self._build_child_env(
                model=model,
                api_base=profile["api_base"],
                api_key=api_key,
                use_proxy=use_proxy,
            )
            primary_target = assets[0]["value"]
            result = self._spawn(
                command,
                ConsoleJob(
                    id=run_name,
                    run_name=run_name,
                    target=(
                        primary_target
                        if len(assets) == 1
                        else f"{primary_target} 等 {len(assets)} 个资产"
                    ),
                    target_kind=assets[0]["kind"] if len(assets) == 1 else "multiple",
                    scan_mode=scan_mode,
                    scope_mode=scope_mode,
                    max_turns=max_turns,
                    status="running",
                    started_at=datetime.now(UTC).isoformat(),
                    profile_id=profile["id"],
                    profile_name=profile["name"],
                    model=model,
                    targets=assets,
                    project_id=project_id,
                    project_name=project["name"] if project else "",
                    max_budget_usd=budget,
                    use_proxy=use_proxy,
                    report_language=report_language,
                ),
                append=False,
                env=child_env,
            )
            self._save_run_settings(
                run_name,
                {
                    "profile_id": profile["id"],
                    "profile_name": profile["name"],
                    "model": model,
                    "max_turns": max_turns,
                    "max_budget_usd": budget,
                    "project_id": project_id,
                    "project_name": project["name"] if project else "",
                    "use_proxy": use_proxy,
                    "report_language": report_language,
                },
            )
            if project_id:
                self.project_store.attach_run(project_id, run_name)
            return result

    def stop(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            job, process = self._require_active(job_id)
            job.status = "stopping"
            if os.name == "posix":
                try:
                    os.killpg(process.pid, signal.SIGINT)
                except ProcessLookupError:
                    # A test seam or a very short-lived child may not expose a
                    # process group by the time stop is requested.  Signalling
                    # the child still preserves the per-job stop contract.
                    process.send_signal(signal.SIGINT)
            else:
                process.send_signal(signal.SIGINT)
            threading.Thread(
                target=self._force_stop_after_timeout,
                args=(process,),
                name=f"strix-console-stop-{job_id}",
                daemon=True,
            ).start()
            return asdict(job)

    def resume(self, run_name: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if not _RUN_NAME_RE.fullmatch(run_name):
            raise ConsoleRequestError("无效的任务名称")
        run_dir = self.runs_dir / run_name
        if not run_record_path(run_dir).is_file():
            raise ConsoleRequestError("找不到该任务", HTTPStatus.NOT_FOUND)
        if not (runtime_state_dir(run_dir) / "agents.json").is_file():
            raise ConsoleRequestError("该任务尚未保存可继续的 Agent 状态")

        payload = payload or {}
        saved = self._load_run_settings(run_name)
        try:
            persisted_record = json.loads(run_record_path(run_dir).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            persisted_record = {}
        inherited_settings = {
            **(persisted_record if isinstance(persisted_record, dict) else {}),
            **saved,
        }
        profile_id = str(payload.get("profile_id") or saved.get("profile_id") or "environment")
        profile, api_key = self.profile_store.resolve(profile_id)
        model = str(payload.get("model") or saved.get("model") or profile["model"]).strip()
        instruction = str(payload.get("instruction") or "").strip()
        max_turns = payload.get(
            "max_turns",
            saved.get("max_turns", self._resume_max_turns(run_dir)),
        )
        budget = self._validate_budget(payload.get("max_budget_usd", saved.get("max_budget_usd")))
        use_proxy = self._resolve_bool_option(
            payload,
            saved,
            "use_proxy",
            default=False,
            label="代理策略",
        )
        report_language = self._resolve_report_language(payload, inherited_settings)
        if not model or len(model) > 200:
            raise ConsoleRequestError("任务模型长度必须在 1 到 200 个字符之间")
        invalid_turns = isinstance(max_turns, bool) or not isinstance(max_turns, int)
        if invalid_turns or not 1 <= max_turns <= 500:
            raise ConsoleRequestError("最大轮次必须在 1 到 500 之间")
        if len(instruction) > _MAX_INSTRUCTION_LENGTH:
            raise ConsoleRequestError("补充指令不能超过 20,000 个字符")

        with self._lock:
            existing_process = self._processes.get(run_name)
            if existing_process is not None and existing_process.poll() is None:
                raise ConsoleRequestError(
                    "该任务已经在运行，不能重复恢复",
                    HTTPStatus.CONFLICT,
                )
            command = [
                sys.executable,
                "-m",
                "strix.interface.main",
                "--resume",
                run_name,
                "--non-interactive",
                "--console-managed",
                "--report-language",
                report_language,
                "--max-turns",
                str(max_turns),
            ]
            if instruction:
                command.extend(["--instruction", instruction])
            if budget is not None:
                command.extend(["--max-budget", str(budget)])
            job = ConsoleJob(
                id=run_name,
                run_name=run_name,
                target=self._target_from_record(run_dir),
                target_kind="resume",
                scan_mode="resume",
                scope_mode="resume",
                max_turns=max_turns,
                status="running",
                started_at=datetime.now(UTC).isoformat(),
                resumed=True,
                profile_id=profile["id"],
                profile_name=profile["name"],
                model=model,
                project_id=str(saved.get("project_id") or ""),
                project_name=str(saved.get("project_name") or ""),
                max_budget_usd=budget,
                use_proxy=use_proxy,
                report_language=report_language,
            )
            child_env = self._build_child_env(
                model=model,
                api_base=profile["api_base"],
                api_key=api_key,
                use_proxy=use_proxy,
            )
            result = self._spawn(command, job, append=True, env=child_env)
            self._save_run_settings(
                run_name,
                {
                    **saved,
                    "profile_id": profile["id"],
                    "profile_name": profile["name"],
                    "model": model,
                    "max_turns": max_turns,
                    "max_budget_usd": budget,
                    "use_proxy": use_proxy,
                    "report_language": report_language,
                },
            )
            return result

    def steer(self, agent_id: str, message: str, run_name: str | None = None) -> bool:
        """Queue an instruction for an Agent in a managed run.

        A run name is preferred and makes the target unambiguous when several
        scans are live.  For compatibility with the old viewer payload,
        omitting it is accepted only when exactly one live run contains the
        requested Agent.
        """
        agent_id = agent_id.strip()
        message = message.strip()
        if not agent_id or not message or len(message) > 4_000:
            return False
        with self._lock:
            candidates: list[tuple[ConsoleJob, subprocess.Popen[bytes]]] = []
            for job_id, process in self._processes.items():
                if process.poll() is None:
                    job = self._jobs.get(job_id)
                    if job is not None and (not run_name or job.run_name == run_name):
                        candidates.append((job, process))
            if run_name and not _RUN_NAME_RE.fullmatch(run_name):
                return False
            matching: list[tuple[ConsoleJob, Path]] = []
            for job, _process in candidates:
                state_path = runtime_state_dir(self.runs_dir / job.run_name) / "agents.json"
                try:
                    snapshot = json.loads(state_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                statuses = snapshot.get("statuses") if isinstance(snapshot, dict) else None
                if isinstance(statuses, dict) and statuses.get(agent_id) in {
                    "running",
                    "waiting",
                    "budget_paused",
                }:
                    matching.append((job, state_path))
            if len(matching) != 1:
                return False
            job, state_path = matching[0]
            command_path = state_path.parent / "console-commands.jsonl"
            command_path.parent.mkdir(parents=True, exist_ok=True)
            record = {
                "id": os.urandom(8).hex(),
                "agent_id": agent_id,
                "message": message,
                "run_name": job.run_name,
                "created_at": datetime.now(UTC).isoformat(),
            }
            with command_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
                handle.flush()
            command_path.chmod(0o600)
            return True

    def _legacy_assets(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        raw_assets = payload.get("assets")
        if isinstance(raw_assets, list):
            assets: list[dict[str, Any]] = []
            for item in raw_assets:
                if not isinstance(item, dict):
                    raise ConsoleRequestError("资产格式无效")
                assets.append(
                    {
                        "id": str(item.get("id") or ""),
                        "kind": str(item.get("kind") or "target"),
                        "value": str(item.get("value") or "").strip(),
                        "label": str(item.get("label") or "").strip(),
                    }
                )
            return assets
        target = str(payload.get("target") or "").strip()
        if not target:
            raise ConsoleRequestError("请输入扫描目标")
        target_kind = str(payload.get("target_kind") or "remote")
        if target_kind not in {"remote", "mount", "target"}:
            raise ConsoleRequestError("不支持的目标类型")
        return [
            {
                "id": "",
                "kind": "mount" if target_kind == "mount" else "target",
                "value": target,
                "label": "",
            }
        ]

    def _resolve_asset(self, asset: dict[str, Any]) -> dict[str, str]:
        kind = str(asset.get("kind") or "target")
        value = str(asset.get("value") or "").strip()
        if kind not in {"target", "mount", "target_list"} or not value:
            raise ConsoleRequestError("资产格式无效")
        if kind == "mount":
            path = self._resolve_path(value)
            if not path.is_dir():
                raise ConsoleRequestError(f"本地目录不存在或不是文件夹：{value}")
            value = str(path)
        elif kind == "target_list":
            value = self._resolve_file(value, "目标清单")
        return {
            "id": str(asset.get("id") or ""),
            "kind": kind,
            "value": value,
            "label": str(asset.get("label") or ""),
        }

    def _resolve_path(self, value: str) -> Path:
        path = Path(value).expanduser()
        return (self.work_dir / path).resolve() if not path.is_absolute() else path.resolve()

    def _resolve_file(self, value: str, label: str) -> str:
        if not value:
            return ""
        path = self._resolve_path(value)
        if not path.is_file():
            raise ConsoleRequestError(f"{label}不存在或不是文件：{value}")
        return str(path)

    @staticmethod
    def _validate_budget(value: Any) -> float | None:
        if value is None or value == "":
            return None
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise ConsoleRequestError("最大预算必须是大于 0 的数字")
        budget = float(value)
        if not math.isfinite(budget) or budget <= 0:
            raise ConsoleRequestError("最大预算必须是大于 0 的有限数字")
        return budget

    @staticmethod
    def _resolve_report_language(
        payload: dict[str, Any],
        inherited: dict[str, Any],
    ) -> str:
        if "report_language" in payload:
            value = payload["report_language"]
        else:
            value = inherited.get("report_language", DEFAULT_REPORT_LANGUAGE)
        if not isinstance(value, str) or value not in REPORT_LANGUAGES:
            supported = ", ".join(REPORT_LANGUAGES)
            raise ConsoleRequestError(f"报告语言必须是 {supported} 之一")
        return value

    @staticmethod
    def _resolve_bool_option(
        payload: dict[str, Any],
        inherited: dict[str, Any],
        field: str,
        *,
        default: bool,
        label: str,
    ) -> bool:
        if field in payload:
            value = payload[field]
            if not isinstance(value, bool):
                raise ConsoleRequestError(f"{label}必须是布尔值")
            return value
        value = inherited.get(field, default)
        return value if isinstance(value, bool) else default

    @staticmethod
    def _build_child_env(
        *,
        model: str,
        api_base: str,
        api_key: str,
        use_proxy: bool,
    ) -> dict[str, str]:
        """Build the isolated scan environment with an explicit proxy policy."""
        env = os.environ.copy()
        if not use_proxy:
            for key in tuple(env):
                if key.upper() in _PROXY_ENV_NAMES:
                    del env[key]
        env.update(
            {
                "STRIX_LLM": model,
                "LLM_API_BASE": api_base,
                "LLM_API_KEY": api_key,
            }
        )
        return env

    @property
    def _run_settings_path(self) -> Path:
        return self.log_dir / "run-settings.json"

    def _load_run_settings(self, run_name: str) -> dict[str, Any]:
        try:
            raw = json.loads(self._run_settings_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        settings = raw.get(run_name) if isinstance(raw, dict) else None
        return dict(settings) if isinstance(settings, dict) else {}

    def _save_run_settings(self, run_name: str, settings: dict[str, Any]) -> None:
        self.log_dir.mkdir(parents=True, exist_ok=True)
        try:
            raw = json.loads(self._run_settings_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raw = {}
        if not isinstance(raw, dict):
            raw = {}
        raw[run_name] = settings
        self._run_settings_path.write_text(
            json.dumps(raw, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        self._run_settings_path.chmod(0o600)

    def read_log(self, job_id: str, after: int) -> dict[str, Any]:
        if not _RUN_NAME_RE.fullmatch(job_id):
            raise ConsoleRequestError("无效的任务名称")
        path = self.log_dir / f"{job_id}.log"
        if not path.is_file():
            return {"text": "", "next": 0, "truncated": False}
        size = path.stat().st_size
        after = max(0, min(after, size))
        truncated = size - after > _MAX_LOG_BYTES
        if truncated:
            after = size - _MAX_LOG_BYTES
        with path.open("rb") as handle:
            handle.seek(after)
            raw = handle.read(_MAX_LOG_BYTES)
        return {
            "text": raw.decode("utf-8", errors="replace"),
            "next": after + len(raw),
            "truncated": truncated,
        }

    def _spawn(
        self,
        command: list[str],
        job: ConsoleJob,
        *,
        append: bool,
        env: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        self.log_dir.mkdir(parents=True, exist_ok=True)
        log_path = self.log_dir / f"{job.id}.log"
        log_handle = log_path.open("ab" if append else "wb")
        if append:
            log_handle.write(b"\n\n=== RESUMED FROM LOCAL CONSOLE ===\n")
            log_handle.flush()
        try:
            process = subprocess.Popen(  # noqa: S603
                command,
                cwd=self.work_dir,
                env=env or os.environ.copy(),
                stdin=subprocess.DEVNULL,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        except OSError as exc:
            log_handle.close()
            raise ConsoleRequestError(f"无法启动 Strix：{exc}") from exc
        job.pid = process.pid
        self._jobs[job.id] = job
        self._processes[job.id] = process
        self._log_handles[job.id] = log_handle
        threading.Thread(
            target=self._watch,
            args=(job, process, log_handle),
            name=f"strix-console-watch-{job.id}",
            daemon=True,
        ).start()
        return asdict(job)

    def _watch(
        self,
        job: ConsoleJob,
        process: subprocess.Popen[bytes],
        log_handle: Any,
    ) -> None:
        returncode = process.wait()
        log_handle.close()
        with self._lock:
            was_stopped = job.status == "stopping"
            job.returncode = returncode
            job.finished_at = datetime.now(UTC).isoformat()
            if was_stopped:
                job.status = "stopped"
            elif returncode == 0:
                job.status = "completed"
            elif returncode < 0:
                job.status = "stopped"
            else:
                job.status = "failed"
            # Remove only this run's process.  A sibling scan must remain
            # stoppable and visible while this watcher finalizes its job.
            if self._processes.get(job.id) is process:
                self._processes.pop(job.id, None)
            if self._log_handles.get(job.id) is log_handle:
                self._log_handles.pop(job.id, None)

    def _force_stop_after_timeout(self, process: subprocess.Popen[bytes]) -> None:
        try:
            process.wait(timeout=12)
        except subprocess.TimeoutExpired:
            if os.name == "posix":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    return
            else:
                process.kill()

    def _require_active(self, job_id: str) -> tuple[ConsoleJob, subprocess.Popen[bytes]]:
        job = self._jobs.get(job_id)
        process = self._processes.get(job_id)
        if job is None or process is None or process.poll() is not None:
            raise ConsoleRequestError("该任务当前未运行", HTTPStatus.CONFLICT)
        return job, process

    def _new_run_name(self) -> str:
        for _ in range(20):
            stamp = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
            suffix = os.urandom(2).hex()
            name = f"console_{stamp}_{suffix}"
            if name not in self._jobs and not (self.runs_dir / name).exists():
                return name
        raise ConsoleRequestError("无法分配新的任务名称")

    @staticmethod
    def _target_from_record(run_dir: Path) -> str:
        try:
            record = json.loads(run_record_path(run_dir).read_text(encoding="utf-8"))
            targets = record.get("targets_info") or []
            if targets and isinstance(targets[0], dict):
                return str(targets[0].get("original") or run_dir.name)
        except (OSError, json.JSONDecodeError):
            pass
        return run_dir.name

    @staticmethod
    def _resume_max_turns(run_dir: Path) -> int:
        try:
            record = json.loads(run_record_path(run_dir).read_text(encoding="utf-8"))
            value = record.get("max_turns")
            if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 500:
                return value
        except (OSError, json.JSONDecodeError):
            pass
        return 40


def run_console(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(
        prog="strix console",
        description="启动仅限本机访问的 Strix 中文任务控制台。",
    )
    parser.add_argument("--port", type=int, default=0, help="监听端口，默认自动选择")
    parser.add_argument("--no-open", action="store_true", help="不要自动打开浏览器")
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("--port 必须在 0 到 65535 之间")

    console = Console()
    if not bundle_is_built():
        console.print("[bold red]控制台前端尚未构建。[/]")
        raise SystemExit(1)

    work_dir = Path.cwd()
    manager = RunManager(work_dir)
    default_run = latest_run_dir(cwd=work_dir)
    httpd, url, token = serve(
        default_run,
        host="127.0.0.1",
        port=args.port,
        open_browser=False,
        steer_handler=manager.steer,
        base_dir=runs_base_dir(cwd=work_dir),
        console_manager=manager,
    )
    open_url = authorized_url(url, token, extra_query={"console": "1"})
    if not args.no_open:
        open_browser(open_url)

    console.print()
    console.print("[bold white]Strix 本地控制台已启动：[/]")
    console.print(f"  [#60a5fa]{open_url}[/]", soft_wrap=True)
    console.print("[dim]仅监听 127.0.0.1。API Key 不会发送到浏览器。按 Ctrl-C 停止控制台。[/]")
    console.print()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        console.print("\n[dim]控制台已停止。[/]")
    finally:
        httpd.shutdown()
        httpd.server_close()


__all__ = [
    "ConsoleJob",
    "ConsoleRequestError",
    "LLMProfile",
    "ProfileStore",
    "ProjectStore",
    "RunManager",
    "run_console",
]
