"""Persistent project and authorized asset-scope storage for the local console."""

from __future__ import annotations

import json
import math
import os
import re
import tempfile
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from strix.core.inputs import DEFAULT_REPORT_LANGUAGE, REPORT_LANGUAGES


_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$")
_ASSET_KINDS = frozenset({"target", "mount", "target_list"})
_SCAN_MODES = frozenset({"quick", "standard", "deep"})
_SCOPE_MODES = frozenset({"auto", "diff", "full"})


class ProjectValidationError(ValueError):
    """Raised when a persisted console project would be unsafe or ambiguous."""


class ProjectStore:
    """Own project persistence behind a small CRUD interface.

    Project files contain scope metadata and defaults only. LLM secrets remain in
    the profile store and scan results remain under ``strix_runs``.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()

    def list_projects(self) -> list[dict[str, Any]]:
        with self._lock:
            projects = self._read()
        return sorted(projects, key=lambda item: item["updated_at"], reverse=True)

    def get(self, project_id: str) -> dict[str, Any]:
        if not _ID_RE.fullmatch(project_id):
            raise ProjectValidationError("无效的项目 ID")
        with self._lock:
            project = next(
                (item for item in self._read() if item["id"] == project_id),
                None,
            )
        if project is None:
            raise ProjectValidationError("找不到该项目")
        return project

    def save(self, payload: dict[str, Any]) -> dict[str, Any]:
        project_id = str(payload.get("id") or "").strip()
        if project_id and not _ID_RE.fullmatch(project_id):
            raise ProjectValidationError("无效的项目 ID")

        name = self._text(payload, "name", maximum=80, required=True, label="项目名称")
        description = self._text(payload, "description", maximum=2_000, label="项目说明")
        authorization = self._text(
            payload,
            "authorization",
            maximum=4_000,
            required=True,
            label="授权说明",
        )
        assets = self._validate_assets(payload.get("assets"))
        defaults = self._validate_defaults(payload.get("defaults"))
        now = datetime.now(UTC).isoformat()

        with self._lock:
            projects = self._read()
            existing = next(
                (item for item in projects if item["id"] == project_id),
                None,
            )
            if not project_id:
                project_id = f"project_{os.urandom(6).hex()}"
            record = {
                "id": project_id,
                "name": name,
                "description": description,
                "authorization": authorization,
                "assets": assets,
                "defaults": defaults,
                "run_names": list(existing.get("run_names", [])) if existing else [],
                "created_at": existing.get("created_at", now) if existing else now,
                "updated_at": now,
            }
            if existing is None:
                projects.append(record)
            else:
                projects = [record if item["id"] == project_id else item for item in projects]
            self._write(projects)
        return record

    def delete(self, project_id: str) -> None:
        project = self.get(project_id)
        with self._lock:
            projects = [item for item in self._read() if item["id"] != project["id"]]
            self._write(projects)

    def attach_run(self, project_id: str, run_name: str) -> dict[str, Any]:
        if not _ID_RE.fullmatch(run_name):
            raise ProjectValidationError("无效的任务名称")
        with self._lock:
            projects = self._read()
            project = next((item for item in projects if item["id"] == project_id), None)
            if project is None:
                raise ProjectValidationError("找不到该项目")
            if run_name not in project["run_names"]:
                project["run_names"].append(run_name)
            project["updated_at"] = datetime.now(UTC).isoformat()
            self._write(projects)
            return project

    @staticmethod
    def _text(
        payload: dict[str, Any],
        field: str,
        *,
        maximum: int,
        label: str,
        required: bool = False,
    ) -> str:
        value = payload.get(field, "")
        if not isinstance(value, str):
            raise ProjectValidationError(f"{label}必须是文本")
        value = value.strip()
        if required and not value:
            raise ProjectValidationError(f"请输入{label}")
        if len(value) > maximum:
            raise ProjectValidationError(f"{label}不能超过 {maximum:,} 个字符")
        return value

    @staticmethod
    def _validate_assets(raw: Any) -> list[dict[str, Any]]:
        if not isinstance(raw, list) or not raw:
            raise ProjectValidationError("项目至少需要一个资产")
        if len(raw) > 200:
            raise ProjectValidationError("单个项目最多保存 200 个资产")
        assets: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for item in raw:
            if not isinstance(item, dict):
                raise ProjectValidationError("资产格式无效")
            kind = str(item.get("kind") or "target").strip()
            value = str(item.get("value") or "").strip()
            label = str(item.get("label") or "").strip()
            asset_id = str(item.get("id") or f"asset_{os.urandom(5).hex()}").strip()
            if kind not in _ASSET_KINDS:
                raise ProjectValidationError("不支持的资产类型")
            if not _ID_RE.fullmatch(asset_id):
                raise ProjectValidationError("无效的资产 ID")
            if not value or len(value) > 2_048:
                raise ProjectValidationError("资产内容长度必须在 1 到 2,048 个字符之间")
            if len(label) > 100:
                raise ProjectValidationError("资产名称不能超过 100 个字符")
            identity = (kind, value)
            if identity in seen:
                raise ProjectValidationError(f"资产重复: {value}")
            seen.add(identity)
            assets.append(
                {
                    "id": asset_id,
                    "kind": kind,
                    "value": value,
                    "label": label,
                    "enabled": item.get("enabled") is not False,
                }
            )
        return assets

    @staticmethod
    def _validate_defaults(raw: Any) -> dict[str, Any]:  # noqa: PLR0912
        data = raw if isinstance(raw, dict) else {}
        scan_mode = str(data.get("scan_mode") or "quick")
        scope_mode = str(data.get("scope_mode") or "auto")
        if scan_mode not in _SCAN_MODES:
            raise ProjectValidationError("不支持的扫描模式")
        if scope_mode not in _SCOPE_MODES:
            raise ProjectValidationError("不支持的范围模式")
        report_language = data.get("report_language", DEFAULT_REPORT_LANGUAGE)
        if not isinstance(report_language, str) or report_language not in REPORT_LANGUAGES:
            raise ProjectValidationError("报告语言必须是 zh-CN 或 en")
        use_proxy = data.get("use_proxy", False)
        if not isinstance(use_proxy, bool):
            raise ProjectValidationError("代理策略必须是布尔值")

        max_turns = data.get("max_turns", 40)
        if isinstance(max_turns, bool) or not isinstance(max_turns, int):
            raise ProjectValidationError("最大轮次必须是整数")
        if not 1 <= max_turns <= 500:
            raise ProjectValidationError("最大轮次必须在 1 到 500 之间")

        raw_budget = data.get("max_budget_usd")
        max_budget_usd: float | None
        if raw_budget is None or raw_budget == "":
            max_budget_usd = None
        elif isinstance(raw_budget, bool) or not isinstance(raw_budget, int | float):
            raise ProjectValidationError("预算必须是大于 0 的数字")
        else:
            max_budget_usd = float(raw_budget)
            if not math.isfinite(max_budget_usd) or max_budget_usd <= 0:
                raise ProjectValidationError("预算必须是大于 0 的有限数字")

        strings = {
            "diff_base": 500,
            "instruction": 20_000,
            "instruction_file": 2_048,
            "config_path": 2_048,
            "profile_id": 80,
            "model": 200,
        }
        normalized: dict[str, Any] = {
            "scan_mode": scan_mode,
            "scope_mode": scope_mode,
            "report_language": report_language,
            "max_turns": max_turns,
            "max_budget_usd": max_budget_usd,
            "use_proxy": use_proxy,
        }
        for field, maximum in strings.items():
            value = data.get(field, "")
            if not isinstance(value, str):
                raise ProjectValidationError(f"{field} 必须是文本")
            value = value.strip()
            if len(value) > maximum:
                raise ProjectValidationError(f"{field} 过长")
            normalized[field] = value
        if normalized["instruction"] and normalized["instruction_file"]:
            raise ProjectValidationError("补充指令与指令文件只能选择一种")
        return normalized

    def _read(self) -> list[dict[str, Any]]:
        if not self.path.is_file():
            return []
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        projects = raw.get("projects") if isinstance(raw, dict) else None
        if not isinstance(projects, list):
            return []
        return [self._normalize_record(item) for item in projects if self._is_valid_record(item)]

    @staticmethod
    def _normalize_record(item: dict[str, Any]) -> dict[str, Any]:
        """Add defaults introduced after older project files were written."""
        record = dict(item)
        defaults = dict(record["defaults"])
        defaults["use_proxy"] = ProjectStore._normalize_legacy_bool(defaults.get("use_proxy"))
        if "report_language" not in defaults:
            defaults["report_language"] = DEFAULT_REPORT_LANGUAGE
        record["defaults"] = defaults
        return record

    @staticmethod
    def _normalize_legacy_bool(value: Any) -> bool:
        """Treat missing or legacy malformed values as the safe direct default."""
        return value if isinstance(value, bool) else False

    @staticmethod
    def _is_valid_record(item: Any) -> bool:
        return bool(
            isinstance(item, dict)
            and isinstance(item.get("id"), str)
            and _ID_RE.fullmatch(item["id"])
            and isinstance(item.get("name"), str)
            and isinstance(item.get("authorization"), str)
            and isinstance(item.get("assets"), list)
            and isinstance(item.get("defaults"), dict)
            and isinstance(item.get("run_names"), list)
            and isinstance(item.get("created_at"), str)
            and isinstance(item.get("updated_at"), str)
        )

    def _write(self, projects: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps({"projects": projects}, ensure_ascii=False, indent=2)
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=self.path.parent,
            prefix=f".{self.path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            handle.write(payload)
            temp_path = Path(handle.name)
        temp_path.chmod(0o600)
        temp_path.replace(self.path)


__all__ = ["ProjectStore", "ProjectValidationError"]
