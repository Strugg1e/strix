"""Tests for the local scan console."""

from __future__ import annotations

import json
import signal
import threading
import time
import urllib.error
import urllib.request
from typing import TYPE_CHECKING, Any

import pytest

from strix.core.paths import runtime_state_dir
from strix.interface.console import ConsoleRequestError, ProfileStore, RunManager
from strix.interface.console_projects import ProjectStore
from strix.interface.viewer.server import authorized_url, run_list_entry, serve


if TYPE_CHECKING:
    from pathlib import Path


class _FakeProcess:
    pid = 4242
    returncode: int | None = None

    def __init__(self) -> None:
        self.done = threading.Event()

    def poll(self) -> int | None:
        return self.returncode

    def wait(self, timeout: float | None = None) -> int:
        if not self.done.wait(timeout):
            raise TimeoutError
        return self.returncode or 0


class _FakeProfileStore:
    def list_profiles(self) -> list[dict[str, Any]]:
        return []

    def resolve(self, profile_id: str) -> tuple[dict[str, Any], str]:
        return (
            {
                "id": profile_id,
                "name": "Test profile",
                "model": "openai/test-model",
                "api_base": "https://llm.example/v1",
            },
            "secret-value",
        )


def test_run_manager_builds_safe_command_without_secret(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    process = _FakeProcess()
    captured: dict[str, Any] = {}

    def fake_popen(command: list[str], **kwargs: Any) -> _FakeProcess:
        captured["command"] = command
        captured["kwargs"] = kwargs
        return process

    monkeypatch.setattr("strix.interface.console.subprocess.Popen", fake_popen)
    monkeypatch.setenv("LLM_API_KEY", "secret-value")
    monkeypatch.setenv("HTTP_PROXY", "http://proxy.example:8080")
    monkeypatch.setenv("https_proxy", "http://proxy.example:8080")
    monkeypatch.setenv("NO_PROXY", "localhost")
    manager = RunManager(tmp_path, profile_store=_FakeProfileStore())  # type: ignore[arg-type]
    job = manager.start(
        {
            "target": "https://example.com",
            "confirmation": "https://example.com",
            "target_kind": "remote",
            "scan_mode": "quick",
            "scope_mode": "auto",
            "max_turns": 12,
            "instruction": "Focus on auth",
            "profile_id": "test",
        }
    )

    command = captured["command"]
    assert command[:3] == [command[0], "-m", "strix.interface.main"]
    assert "--run-name" in command
    assert command[command.index("--report-language") + 1] == "zh-CN"
    assert command[-2:] == ["--instruction", "Focus on auth"]
    assert "secret-value" not in command
    assert captured["kwargs"]["start_new_session"] is True
    assert captured["kwargs"]["stdin"] is not None
    assert captured["kwargs"]["env"]["STRIX_LLM"] == "openai/test-model"
    assert captured["kwargs"]["env"]["LLM_API_BASE"] == "https://llm.example/v1"
    assert captured["kwargs"]["env"]["LLM_API_KEY"] == "secret-value"
    assert all(
        key.upper() not in {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"}
        for key in captured["kwargs"]["env"]
    )
    assert job["use_proxy"] is False
    assert job["report_language"] == "zh-CN"
    assert job["status"] == "running"

    process.returncode = 0
    process.done.set()


def test_run_manager_requires_exact_target_confirmation(tmp_path: Path) -> None:
    manager = RunManager(tmp_path)
    with pytest.raises(ConsoleRequestError, match="目标确认"):
        manager.start(
            {
                "target": "https://example.com",
                "confirmation": "example.com",
                "max_turns": 10,
            }
        )


def test_run_manager_can_inherit_terminal_proxy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    process = _FakeProcess()
    captured: dict[str, Any] = {}

    def fake_popen(command: list[str], **kwargs: Any) -> _FakeProcess:
        captured["command"] = command
        captured["kwargs"] = kwargs
        return process

    monkeypatch.setattr("strix.interface.console.subprocess.Popen", fake_popen)
    monkeypatch.setenv("HTTP_PROXY", "http://proxy.example:8080")
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example:8080")
    monkeypatch.setenv("ALL_PROXY", "socks5://proxy.example:1080")
    monkeypatch.setenv("NO_PROXY", "localhost")
    manager = RunManager(tmp_path, profile_store=_FakeProfileStore())  # type: ignore[arg-type]
    job = manager.start(
        {
            "target": "https://example.com",
            "confirmation": "https://example.com",
            "max_turns": 10,
            "profile_id": "test",
            "use_proxy": True,
        }
    )

    child_env = captured["kwargs"]["env"]
    assert child_env["HTTP_PROXY"] == "http://proxy.example:8080"
    assert child_env["HTTPS_PROXY"] == "http://proxy.example:8080"
    assert child_env["ALL_PROXY"] == "socks5://proxy.example:1080"
    assert child_env["NO_PROXY"] == "localhost"
    assert job["use_proxy"] is True
    process.returncode = 0
    process.done.set()


def test_run_manager_rejects_non_boolean_proxy_policy(tmp_path: Path) -> None:
    manager = RunManager(tmp_path)
    with pytest.raises(ConsoleRequestError, match="代理策略必须是布尔值"):
        manager.start(
            {
                "target": "https://example.com",
                "confirmation": "https://example.com",
                "max_turns": 10,
                "use_proxy": "false",
            }
        )


def test_run_manager_rejects_unknown_report_language(tmp_path: Path) -> None:
    manager = RunManager(tmp_path)
    with pytest.raises(ConsoleRequestError, match="报告语言"):
        manager.start(
            {
                "target": "https://example.com",
                "confirmation": "https://example.com",
                "max_turns": 10,
                "report_language": "fr",
            }
        )


def test_run_manager_rejects_missing_mount(tmp_path: Path) -> None:
    manager = RunManager(tmp_path)
    missing = str(tmp_path / "missing")
    with pytest.raises(ConsoleRequestError, match="本地目录不存在"):
        manager.start(
            {
                "target": missing,
                "confirmation": missing,
                "target_kind": "mount",
                "max_turns": 10,
            }
        )


class _StubManager:
    profile_store = _FakeProfileStore()

    def __init__(self, project_store: ProjectStore) -> None:
        self.project_store = project_store
        self.resume_payload: dict[str, Any] | None = None

    def status_payload(self) -> dict[str, Any]:
        return {
            "active_job": None,
            "model": "test",
            "provider": "local",
            "work_dir": "test-workspace",
        }

    def start(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {"id": "job", "target": payload["target"], "status": "running"}

    def resume(self, run_name: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.resume_payload = payload
        return {"id": run_name, "run_name": run_name, "status": "running"}


def _request(
    url: str,
    *,
    method: str = "GET",
    cookie: str | None = None,
    body: dict[str, Any] | None = None,
) -> tuple[int, Any, str | None]:
    headers: dict[str, str] = {}
    data = None
    if cookie:
        headers["Cookie"] = cookie
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    request = urllib.request.Request(  # noqa: S310 - localhost test server
        url, data=data, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(request) as response:  # noqa: S310
            raw = response.read()
            try:
                payload = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                payload = raw.decode()
            return response.status, payload, response.headers.get("Set-Cookie")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}"), exc.headers.get("Set-Cookie")


def test_console_api_requires_session_cookie(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assets = tmp_path / "bundle"
    assets.mkdir()
    (assets / "index.html").write_text("<div>console</div>", encoding="utf-8")
    monkeypatch.setattr("strix.interface.viewer.server.bundle_dir", lambda: assets)

    manager = _StubManager(ProjectStore(tmp_path / "projects.json"))
    httpd, url, token = serve(
        None,
        open_browser=False,
        base_dir=tmp_path / "strix_runs",
        console_manager=manager,
    )
    try:
        status, _, _ = _request(f"{url}/api/console/status")
        assert status == 403

        status, _, set_cookie = _request(authorized_url(url, token, extra_query={"console": "1"}))
        assert status == 200
        assert set_cookie
        cookie = set_cookie.split(";", 1)[0]

        status, payload, _ = _request(f"{url}/api/console/status", cookie=cookie)
        assert status == 200
        assert payload["model"] == "test"

        status, payload, _ = _request(
            f"{url}/api/console/jobs",
            method="POST",
            cookie=cookie,
            body={"target": "https://example.com"},
        )
        assert status == 201
        assert payload["status"] == "running"

        status, project, _ = _request(
            f"{url}/api/console/projects",
            method="POST",
            cookie=cookie,
            body={
                "name": "API SRC",
                "authorization": "Authorized scope",
                "assets": [{"kind": "target", "value": "api.example.com"}],
            },
        )
        assert status == 200
        status, payload, _ = _request(f"{url}/api/console/projects", cookie=cookie)
        assert status == 200
        assert [item["id"] for item in payload["projects"]] == [project["id"]]

        status, payload, _ = _request(
            f"{url}/api/console/runs/previous/resume",
            method="POST",
            cookie=cookie,
            body={"profile_id": "test", "model": "openai/resume-model"},
        )
        assert status == 201
        assert manager.resume_payload == {
            "profile_id": "test",
            "model": "openai/resume-model",
        }

        status, payload, _ = _request(
            f"{url}/api/console/projects/{project['id']}",
            method="DELETE",
            cookie=cookie,
        )
        assert status == 200
        assert payload == {"ok": True}
        assert manager.project_store.list_projects() == []
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_viewer_run_link_keeps_all_data_and_steering_on_selected_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A run-B deep link must never fall back to the launched run-A data."""
    base_dir = tmp_path / "strix_runs"
    for run_name, marker in (("run-a", "A"), ("run-b", "B")):
        run_dir = base_dir / run_name
        run_dir.mkdir(parents=True)
        (run_dir / "run.json").write_text(
            json.dumps(
                {
                    "run_name": run_name,
                    "status": "running",
                    "start_time": "2026-08-02T00:00:00+00:00",
                    "targets_info": [{"original": f"https://{marker.lower()}.example"}],
                }
            ),
            encoding="utf-8",
        )
        (run_dir / "vulnerabilities.json").write_text(
            json.dumps([{"id": f"finding-{marker}", "title": f"Finding {marker}"}]),
            encoding="utf-8",
        )
        (run_dir / "penetration_test_report.md").write_text(
            f"# REPORT-{marker}", encoding="utf-8"
        )

    assets = tmp_path / "bundle"
    assets.mkdir()
    (assets / "index.html").write_text("<div>viewer</div>", encoding="utf-8")
    monkeypatch.setattr("strix.interface.viewer.server.bundle_dir", lambda: assets)
    monkeypatch.setattr(
        "strix.interface.viewer.server.build_run_state",
        lambda run_dir: {"agents": [{"id": run_dir.name}], "events": []},
    )
    steer_calls: list[tuple[str, str, str | None]] = []

    def steer(agent_id: str, message: str, run_name: str | None = None) -> bool:
        steer_calls.append((agent_id, message, run_name))
        return run_name == "run-b"

    httpd, url, token = serve(
        base_dir / "run-a",
        open_browser=False,
        base_dir=base_dir,
        console_manager=object(),
        steer_handler=steer,
    )
    try:
        status, _, set_cookie = _request(
            authorized_url(url, token, extra_query={"run": "run-b"})
        )
        assert status == 200
        assert set_cookie
        cookie = set_cookie.split(";", 1)[0]

        status, summary, _ = _request(f"{url}/api/run?run=run-b", cookie=cookie)
        assert status == 200
        assert summary["run_name"] == "run-b"

        status, vulnerabilities, _ = _request(
            f"{url}/api/vulnerabilities?run=run-b", cookie=cookie
        )
        assert status == 200
        assert vulnerabilities == [{"id": "finding-B", "title": "Finding B"}]

        status, report, _ = _request(f"{url}/api/report?run=run-b", cookie=cookie)
        assert status == 200
        assert report["markdown"] == "# REPORT-B"

        status, transcript, _ = _request(f"{url}/api/transcript?run=run-b", cookie=cookie)
        assert status == 200
        assert transcript == {"agents": [{"id": "run-b"}], "events": []}

        status, steer_result, _ = _request(
            f"{url}/api/agents/steer",
            method="POST",
            cookie=cookie,
            body={"agent_id": "root", "message": "focus B", "run_name": "run-b"},
        )
        assert status == 200
        assert steer_result == {"ok": True}
        assert steer_calls == [("root", "focus B", "run-b")]
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_profile_store_saves_metadata_without_api_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ProfileStore(tmp_path / "profiles.json")
    saved_keys: dict[str, str] = {}
    monkeypatch.setattr(
        store,
        "_write_key",
        lambda profile_id, key: saved_keys.update({profile_id: key}),
    )

    profile = store.save(
        {
            "name": "Private gateway",
            "model": "auto",
            "api_base": "https://api.example.com/v1/",
            "api_key": "sk-private",
        }
    )

    assert profile["api_base"] == "https://api.example.com/v1"
    assert saved_keys[profile["id"]] == "sk-private"
    contents = (tmp_path / "profiles.json").read_text(encoding="utf-8")
    assert "sk-private" not in contents
    assert json.loads(contents)["profiles"][0]["has_api_key"] is True


def test_profile_store_rejects_insecure_remote_base_url(tmp_path: Path) -> None:
    store = ProfileStore(tmp_path / "profiles.json")
    with pytest.raises(ConsoleRequestError, match="HTTPS"):
        store.save(
            {
                "name": "Unsafe",
                "model": "auto",
                "api_base": "http://api.example.com/v1",
                "api_key": "secret",
            }
        )


def test_project_store_round_trip_and_run_attachment(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path / "projects.json")
    project = store.save(
        {
            "name": "SRC 夏季范围",
            "description": "外部资产与代码联合测试",
            "authorization": "仅测试列出的生产域名和只读源码。",
            "assets": [
                {"kind": "target", "value": "https://app.example.com", "label": "主站"},
                {"kind": "target", "value": "api.example.com", "label": "API"},
            ],
            "defaults": {
                "scan_mode": "standard",
                "scope_mode": "full",
                "max_turns": 88,
                "max_budget_usd": 12.5,
                "use_proxy": True,
                "profile_id": "test",
                "model": "openai/test-model",
            },
        }
    )

    attached = store.attach_run(project["id"], "console_20260801_test")
    assert attached["run_names"] == ["console_20260801_test"]
    loaded = store.get(project["id"])
    assert loaded["assets"][0]["label"] == "主站"
    assert loaded["defaults"]["max_budget_usd"] == 12.5
    assert loaded["defaults"]["use_proxy"] is True
    assert loaded["defaults"]["report_language"] == "zh-CN"


def test_project_store_defaults_legacy_proxy_to_direct_and_rejects_strings(tmp_path: Path) -> None:
    path = tmp_path / "projects.json"
    path.write_text(
        json.dumps(
            {
                "projects": [
                    {
                        "id": "legacy",
                        "name": "Legacy",
                        "description": "",
                        "authorization": "scope",
                        "assets": [{"id": "asset_1", "kind": "target", "value": "example.com"}],
                        "defaults": {},
                        "run_names": [],
                        "created_at": "2026-01-01T00:00:00+00:00",
                        "updated_at": "2026-01-01T00:00:00+00:00",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    store = ProjectStore(path)
    assert store.get("legacy")["defaults"]["use_proxy"] is False
    assert store.get("legacy")["defaults"]["report_language"] == "zh-CN"
    with pytest.raises(ValueError, match="代理策略必须是布尔值"):
        store.save(
            {
                "name": "Invalid",
                "authorization": "scope",
                "assets": [{"kind": "target", "value": "example.com"}],
                "defaults": {"use_proxy": "false"},
            }
        )
    with pytest.raises(ValueError, match="报告语言"):
        store.save(
            {
                "name": "Invalid language",
                "authorization": "scope",
                "assets": [{"kind": "target", "value": "example.com"}],
                "defaults": {"report_language": "fr"},
            }
        )


def test_project_launch_compiles_all_cli_scan_options(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mount = tmp_path / "source"
    mount.mkdir()
    target_list = tmp_path / "targets.txt"
    target_list.write_text("api.example.com\n", encoding="utf-8")
    instruction_file = tmp_path / "instructions.md"
    instruction_file.write_text("Focus on access control", encoding="utf-8")
    config_file = tmp_path / "config.json"
    config_file.write_text("{}", encoding="utf-8")

    store = ProjectStore(tmp_path / "projects.json")
    project = store.save(
        {
            "name": "Authorized SRC",
            "authorization": "Bug bounty scope",
            "assets": [
                {"kind": "target", "value": "https://app.example.com"},
                {"kind": "mount", "value": str(mount)},
                {"kind": "target_list", "value": str(target_list)},
            ],
            "defaults": {
                "scan_mode": "deep",
                "scope_mode": "diff",
                "diff_base": "origin/main",
                "max_turns": 77,
                "max_budget_usd": 9.75,
                "instruction_file": str(instruction_file),
                "config_path": str(config_file),
                "profile_id": "test",
                "model": "openai/test-model",
            },
        }
    )
    process = _FakeProcess()
    captured: dict[str, Any] = {}

    def fake_popen(command: list[str], **kwargs: Any) -> _FakeProcess:
        captured["command"] = command
        captured["kwargs"] = kwargs
        return process

    monkeypatch.setattr("strix.interface.console.subprocess.Popen", fake_popen)
    manager = RunManager(
        tmp_path,
        profile_store=_FakeProfileStore(),  # type: ignore[arg-type]
        project_store=store,
    )
    job = manager.start(
        {
            "project_id": project["id"],
            "confirmation": "Authorized SRC",
        }
    )

    command = captured["command"]
    assert "--console-managed" in command
    assert [command[index + 1] for index, value in enumerate(command) if value == "--target"] == [
        "https://app.example.com"
    ]
    assert str(mount) in command
    target_lists = [
        command[index + 1] for index, value in enumerate(command) if value == "--target-list"
    ]
    assert target_lists == [str(target_list)]
    assert command[command.index("--diff-base") + 1] == "origin/main"
    assert command[command.index("--max-budget") + 1] == "9.75"
    assert command[command.index("--instruction-file") + 1] == str(instruction_file)
    assert command[command.index("--config") + 1] == str(config_file)
    assert job["project_id"] == project["id"]
    assert job["max_budget_usd"] == 9.75
    assert store.get(project["id"])["run_names"] == [job["run_name"]]

    process.returncode = 0
    process.done.set()


def test_project_launch_cannot_expand_saved_scope(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path / "projects.json")
    project = store.save(
        {
            "name": "Bounded scope",
            "authorization": "Only one host",
            "assets": [{"kind": "target", "value": "https://allowed.example"}],
        }
    )
    manager = RunManager(tmp_path, project_store=store)
    with pytest.raises(ConsoleRequestError, match="不属于该项目"):
        manager.start(
            {
                "project_id": project["id"],
                "asset_ids": ["asset_outside_scope"],
                "confirmation": "Bounded scope",
            }
        )


def test_resume_applies_saved_profile_and_task_overrides(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_name = "console_20260801_resume"
    run_dir = tmp_path / "strix_runs" / run_name
    state_dir = runtime_state_dir(run_dir)
    state_dir.mkdir(parents=True)
    (run_dir / "run.json").write_text(
        json.dumps(
            {
                "run_name": run_name,
                "targets_info": [{"original": "https://app.example.com"}],
                "max_turns": 40,
            }
        ),
        encoding="utf-8",
    )
    (state_dir / "agents.json").write_text(
        json.dumps({"statuses": {"root": "waiting"}}),
        encoding="utf-8",
    )
    settings_dir = tmp_path / "strix_runs" / ".console"
    settings_dir.mkdir()
    (settings_dir / "run-settings.json").write_text(
        json.dumps(
            {
                run_name: {
                    "profile_id": "test",
                    "model": "openai/saved-model",
                    "max_turns": 60,
                    "max_budget_usd": 5,
                    "use_proxy": True,
                    "report_language": "en",
                    "project_id": "project_123",
                    "project_name": "Saved SRC",
                }
            }
        ),
        encoding="utf-8",
    )

    process = _FakeProcess()
    captured: dict[str, Any] = {}

    def fake_popen(command: list[str], **kwargs: Any) -> _FakeProcess:
        captured["command"] = command
        captured["kwargs"] = kwargs
        return process

    monkeypatch.setattr("strix.interface.console.subprocess.Popen", fake_popen)
    monkeypatch.setenv("HTTP_PROXY", "http://proxy.example:8080")
    manager = RunManager(tmp_path, profile_store=_FakeProfileStore())  # type: ignore[arg-type]
    job = manager.resume(
        run_name,
        {
            "model": "openai/resume-model",
            "max_turns": 90,
            "max_budget_usd": 7.5,
            "instruction": "Retest the authorization boundary",
        },
    )

    command = captured["command"]
    assert "--console-managed" in command
    assert command[command.index("--max-turns") + 1] == "90"
    assert command[command.index("--max-budget") + 1] == "7.5"
    assert command[command.index("--instruction") + 1] == ("Retest the authorization boundary")
    assert command[command.index("--report-language") + 1] == "en"
    assert captured["kwargs"]["env"]["STRIX_LLM"] == "openai/resume-model"
    assert captured["kwargs"]["env"]["LLM_API_KEY"] == "secret-value"
    assert captured["kwargs"]["env"]["HTTP_PROXY"] == "http://proxy.example:8080"
    assert job["use_proxy"] is True
    assert job["report_language"] == "en"
    assert job["project_id"] == "project_123"
    assert job["project_name"] == "Saved SRC"

    process.returncode = 0
    process.done.set()

    overridden = manager.resume(run_name, {"use_proxy": False, "report_language": "zh-CN"})
    assert overridden["use_proxy"] is False
    assert overridden["report_language"] == "zh-CN"
    assert all(
        key.upper() not in {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"}
        for key in captured["kwargs"]["env"]
    )

    with pytest.raises(ConsoleRequestError, match="代理策略必须是布尔值"):
        manager.resume(run_name, {"use_proxy": "false"})


def test_run_manager_queues_instruction_only_for_active_agent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    process = _FakeProcess()
    monkeypatch.setattr(
        "strix.interface.console.subprocess.Popen",
        lambda _command, **_kwargs: process,
    )
    manager = RunManager(tmp_path, profile_store=_FakeProfileStore())  # type: ignore[arg-type]
    job = manager.start(
        {
            "target": "https://example.com",
            "confirmation": "https://example.com",
            "max_turns": 10,
            "profile_id": "test",
        }
    )
    state_dir = runtime_state_dir(tmp_path / "strix_runs" / job["run_name"])
    state_dir.mkdir(parents=True)
    (state_dir / "agents.json").write_text(
        json.dumps({"statuses": {"root": "running", "done": "completed"}}),
        encoding="utf-8",
    )

    assert manager.steer("done", "This should be rejected") is False
    assert manager.steer("root", "Focus on tenant isolation") is True
    command = json.loads((state_dir / "console-commands.jsonl").read_text(encoding="utf-8"))
    assert command["agent_id"] == "root"
    assert command["message"] == "Focus on tenant isolation"

    process.returncode = 0
    process.done.set()


class _ParallelProcess:
    """Controllable Popen seam for lifecycle tests."""

    def __init__(self, pid: int) -> None:
        self.pid = pid
        self.returncode: int | None = None
        self.done = threading.Event()
        self.signals: list[int] = []
        self.kills = 0

    def poll(self) -> int | None:
        return self.returncode

    def wait(self, timeout: float | None = None) -> int:
        if not self.done.wait(timeout):
            raise TimeoutError
        return self.returncode or 0

    def send_signal(self, value: int) -> None:
        self.signals.append(value)

    def kill(self) -> None:
        self.kills += 1
        self.returncode = -9
        self.done.set()

    def finish(self, returncode: int = 0) -> None:
        self.returncode = returncode
        self.done.set()


def _parallel_payload(target: str) -> dict[str, Any]:
    return {
        "target": target,
        "confirmation": target,
        "target_kind": "remote",
        "max_turns": 10,
        "profile_id": "test",
    }


def _write_run_artifacts(
    base_dir: Path,
    run_name: str,
    *,
    status: str = "completed",
    target: str | None = None,
    report: bool = False,
    agents: dict[str, str] | None = None,
) -> Path:
    run_dir = base_dir / run_name
    state_dir = runtime_state_dir(run_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "run.json").write_text(
        json.dumps(
            {
                "run_name": run_name,
                "status": status,
                "start_time": "2026-08-02T00:00:00+00:00",
                "end_time": "2026-08-02T00:01:00+00:00" if status != "running" else None,
                "scan_mode": "quick",
                "targets_info": [{"original": target or run_name}],
            }
        ),
        encoding="utf-8",
    )
    if agents is not None:
        (state_dir / "agents.json").write_text(
            json.dumps({"statuses": agents}),
            encoding="utf-8",
        )
    if report:
        (run_dir / "penetration_test_report.md").write_text("# report", encoding="utf-8")
    return run_dir


def test_run_manager_supports_parallel_jobs_and_accurate_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    processes: list[_ParallelProcess] = []

    def fake_popen(_command: list[str], **_kwargs: Any) -> _ParallelProcess:
        process = _ParallelProcess(10_000 + len(processes))
        processes.append(process)
        return process

    monkeypatch.setattr("strix.interface.console.subprocess.Popen", fake_popen)
    manager = RunManager(tmp_path, profile_store=_FakeProfileStore())  # type: ignore[arg-type]

    first = manager.start(_parallel_payload("parallel-a"))
    second = manager.start(_parallel_payload("parallel-b"))

    status = manager.status_payload()
    assert {job["id"] for job in status["active_jobs"]} == {first["id"], second["id"]}
    assert status["running_count"] == 2
    assert status["single_run_only"] is False
    for process in processes:
        process.finish()


def test_stop_one_parallel_job_does_not_signal_sibling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    processes: list[_ParallelProcess] = []
    killpg_calls: list[tuple[int, int]] = []

    def fake_popen(_command: list[str], **_kwargs: Any) -> _ParallelProcess:
        process = _ParallelProcess(20_000 + len(processes))
        processes.append(process)
        return process

    monkeypatch.setattr("strix.interface.console.subprocess.Popen", fake_popen)
    monkeypatch.setattr(
        "strix.interface.console.os.killpg",
        lambda pid, value: killpg_calls.append((pid, value)),
    )
    manager = RunManager(tmp_path, profile_store=_FakeProfileStore())  # type: ignore[arg-type]
    first = manager.start(_parallel_payload("stop-a"))
    second = manager.start(_parallel_payload("stop-b"))

    manager.stop(first["id"])
    assert killpg_calls == [(processes[0].pid, signal.SIGINT)]
    assert processes[1].signals == []

    processes[0].finish()
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline and manager.status_payload()["running_count"] != 1:
        time.sleep(0.01)
    status = manager.status_payload()
    assert status["running_count"] == 1
    assert [job["id"] for job in status["active_jobs"]] == [second["id"]]
    processes[1].finish()


def test_resume_conflicts_only_with_same_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base_dir = tmp_path / "strix_runs"
    _write_run_artifacts(base_dir, "resume-a", status="stopped", agents={"root": "waiting"})
    _write_run_artifacts(base_dir, "resume-b", status="stopped", agents={"root": "waiting"})
    processes: list[_ParallelProcess] = []

    def fake_popen(_command: list[str], **_kwargs: Any) -> _ParallelProcess:
        process = _ParallelProcess(30_000 + len(processes))
        processes.append(process)
        return process

    monkeypatch.setattr("strix.interface.console.subprocess.Popen", fake_popen)
    manager = RunManager(tmp_path, profile_store=_FakeProfileStore())  # type: ignore[arg-type]

    manager.resume("resume-a", {"profile_id": "test"})
    with pytest.raises(ConsoleRequestError, match="已经在运行"):
        manager.resume("resume-a", {"profile_id": "test"})
    resumed_other = manager.resume("resume-b", {"profile_id": "test"})
    assert resumed_other["run_name"] == "resume-b"
    assert len(processes) == 2
    for process in processes:
        process.finish()


def test_run_projection_prefers_task_settings_and_handles_legacy_unassigned(
    tmp_path: Path,
) -> None:
    base_dir = tmp_path / "strix_runs"
    settings_run = _write_run_artifacts(
        base_dir,
        "settings-run",
        target="settings.example",
        report=True,
    )
    legacy_run = _write_run_artifacts(base_dir, "legacy-run", target="legacy.example")
    unassigned_run = _write_run_artifacts(base_dir, "cli-run", target="cli.example")
    store = ProjectStore(tmp_path / "projects.json")
    legacy_project = store.save(
        {
            "name": "Legacy Project",
            "authorization": "scope",
            "assets": [{"kind": "target", "value": "legacy.example"}],
        }
    )
    settings_project = store.save(
        {
            "name": "Settings Project",
            "authorization": "scope",
            "assets": [{"kind": "target", "value": "settings.example"}],
        }
    )
    store.attach_run(legacy_project["id"], "settings-run")
    store.attach_run(legacy_project["id"], "legacy-run")
    settings_path = base_dir / ".console" / "run-settings.json"
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(
        json.dumps(
            {
                "settings-run": {
                    "project_id": settings_project["id"],
                    "project_name": "Task-side Settings Project",
                }
            }
        ),
        encoding="utf-8",
    )
    manager = RunManager(tmp_path, project_store=store)

    settings_entry = run_list_entry(settings_run, console_manager=manager)
    legacy_entry = run_list_entry(legacy_run, console_manager=manager)
    unassigned_entry = run_list_entry(unassigned_run, console_manager=manager)
    assert settings_entry["project_id"] == settings_project["id"]
    assert settings_entry["project_name"] == "Task-side Settings Project"
    assert settings_entry["managed"] is False
    assert settings_entry["report_available"] is True
    assert legacy_entry["project_id"] == legacy_project["id"]
    assert legacy_entry["project_name"] == legacy_project["name"]
    assert unassigned_entry["project_id"] == ""
    assert unassigned_entry["project_name"] == "未分配项目"
    assert unassigned_entry["managed"] is False


def test_run_projection_marks_live_console_job_managed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    process = _ParallelProcess(40_000)
    monkeypatch.setattr("strix.interface.console.subprocess.Popen", lambda *_a, **_k: process)
    store = ProjectStore(tmp_path / "projects.json")
    project = store.save(
        {
            "name": "Managed Project",
            "authorization": "scope",
            "assets": [{"kind": "target", "value": "managed.example"}],
        }
    )
    manager = RunManager(
        tmp_path,
        profile_store=_FakeProfileStore(),  # type: ignore[arg-type]
        project_store=store,
    )
    job = manager.start(
        {
            "project_id": project["id"],
            "confirmation": project["name"],
            "profile_id": "test",
        }
    )
    run_dir = _write_run_artifacts(tmp_path / "strix_runs", job["run_name"], status="running")
    entry = run_list_entry(run_dir, console_manager=manager)
    assert entry["project_id"] == project["id"]
    assert entry["project_name"] == project["name"]
    assert entry["managed"] is True
    process.finish()


def test_steer_uses_run_context_and_rejects_ambiguous_legacy_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    processes: list[_ParallelProcess] = []

    def fake_popen(_command: list[str], **_kwargs: Any) -> _ParallelProcess:
        process = _ParallelProcess(50_000 + len(processes))
        processes.append(process)
        return process

    monkeypatch.setattr("strix.interface.console.subprocess.Popen", fake_popen)
    manager = RunManager(tmp_path, profile_store=_FakeProfileStore())  # type: ignore[arg-type]
    first = manager.start(_parallel_payload("steer-a"))
    second = manager.start(_parallel_payload("steer-b"))
    for job in (first, second):
        state_dir = runtime_state_dir(tmp_path / "strix_runs" / job["run_name"])
        state_dir.mkdir(parents=True, exist_ok=True)
        (state_dir / "agents.json").write_text(
            json.dumps({"statuses": {"root": "running"}}),
            encoding="utf-8",
        )

    assert manager.steer("root", "ambiguous") is False
    assert manager.steer("root", "targeted", first["run_name"]) is True
    command = json.loads(
        (
            runtime_state_dir(tmp_path / "strix_runs" / first["run_name"])
            / "console-commands.jsonl"
        ).read_text(encoding="utf-8")
    )
    assert command["run_name"] == first["run_name"]
    assert command["message"] == "targeted"
    assert not (
        runtime_state_dir(tmp_path / "strix_runs" / second["run_name"])
        / "console-commands.jsonl"
    ).exists()
    for process in processes:
        process.finish()


def test_run_snapshot_is_scoped_to_requested_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    processes: list[_ParallelProcess] = []

    def fake_popen(_command: list[str], **_kwargs: Any) -> _ParallelProcess:
        process = _ParallelProcess(60_000 + len(processes))
        processes.append(process)
        return process

    monkeypatch.setattr("strix.interface.console.subprocess.Popen", fake_popen)
    manager = RunManager(tmp_path, profile_store=_FakeProfileStore())  # type: ignore[arg-type]
    first = manager.start(_parallel_payload("snapshot-a"))
    second = manager.start(_parallel_payload("snapshot-b"))
    for job, target in ((first, "a.example"), (second, "b.example")):
        _write_run_artifacts(
            tmp_path / "strix_runs",
            job["run_name"],
            status="running",
            target=target,
            agents={"root": "running"},
        )

    first_snapshot = manager.run_snapshot(first["run_name"])
    second_snapshot = manager.run_snapshot(second["run_name"])
    assert first_snapshot["run_name"] == first["run_name"]
    assert second_snapshot["run_name"] == second["run_name"]
    assert first_snapshot["run_name"] != second_snapshot["run_name"]
    for process in processes:
        process.finish()
