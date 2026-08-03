"""Tests for the bounded console run snapshot projection."""

from __future__ import annotations

import json
import sqlite3
import urllib.error
import urllib.request
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import pytest

from strix.interface.console import ConsoleRequestError, RunManager
from strix.interface.console_progress import build_run_snapshot
from strix.interface.viewer.server import authorized_url, serve


if TYPE_CHECKING:
    from pathlib import Path


def _write_run(
    tmp_path: Path,
    *,
    status: str = "running",
    end_time: str | None = None,
    findings: list[dict[str, Any]] | None = None,
) -> Path:
    run_dir = tmp_path / "strix_runs" / "console_snapshot"
    state_dir = run_dir / ".state"
    state_dir.mkdir(parents=True)
    (run_dir / "run.json").write_text(
        json.dumps(
            {
                "run_name": "console_snapshot",
                "status": status,
                "start_time": "2026-01-01T00:00:00Z",
                "end_time": end_time,
                "targets_info": [{"original": "https://example.com"}],
            }
        ),
        encoding="utf-8",
    )
    (state_dir / "agents.json").write_text(
        json.dumps(
            {
                "statuses": {"root": "running", "done": "completed"},
                "names": {"root": "Strix", "done": "Recon"},
                "parent_of": {"root": None, "done": "root"},
            }
        ),
        encoding="utf-8",
    )
    if findings is not None:
        (run_dir / "vulnerabilities.json").write_text(
            json.dumps(findings),
            encoding="utf-8",
        )
    return run_dir


def _write_db(run_dir: Path) -> None:
    db_path = run_dir / ".state" / "agents.db"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "create table agent_messages ("
            "id integer primary key, session_id text not null, "
            "message_data text not null, created_at text not null)"
        )
        conn.execute(
            "insert into agent_messages(session_id, message_data, created_at) "
            "values (?, ?, ?)",
            (
                "root",
                json.dumps({"type": "function_call", "name": "shell"}),
                "2026-01-01T00:02:00Z",
            ),
        )


def _append_tool_call(run_dir: Path, name: str, created_at: str) -> None:
    with sqlite3.connect(run_dir / ".state" / "agents.db") as conn:
        conn.execute(
            "insert into agent_messages(session_id, message_data, created_at) "
            "values (?, ?, ?)",
            ("root", json.dumps({"type": "function_call", "name": name}), created_at),
        )


def test_snapshot_running_reads_bounded_activity_and_milestones(tmp_path: Path) -> None:
    run_dir = _write_run(
        tmp_path,
        findings=[
            {
                "id": "vuln-0001",
                "title": "Access control issue",
                "severity": "high",
                "target": "https://example.com",
                "endpoint": "/admin",
                "timestamp": "2026-01-01T00:03:00Z",
            }
        ],
    )
    _write_db(run_dir)

    snapshot = build_run_snapshot(
        run_dir,
        now=datetime(2026, 1, 1, 0, 4, tzinfo=UTC),
    )

    assert snapshot["status"] == "running"
    assert snapshot["elapsed_seconds"] == 240
    assert snapshot["stage"]["key"] == "validating"
    assert snapshot["agent_stats"]["total"] == 2
    assert snapshot["event_count"] == 1
    assert snapshot["recent_activity"][0]["tool"] == "shell"
    assert snapshot["severity_counts"]["high"] == 1
    assert snapshot["findings_total"] == 1
    assert snapshot["findings"][0]["endpoint"] == "/admin"


def test_snapshot_completed_uses_terminal_stage_and_finish_time(tmp_path: Path) -> None:
    run_dir = _write_run(
        tmp_path,
        status="completed",
        end_time="2026-01-01T00:05:00Z",
        findings=[],
    )
    snapshot = build_run_snapshot(
        run_dir,
        now=datetime(2026, 1, 1, 0, 10, tzinfo=UTC),
    )

    assert snapshot["finished"] is True
    assert snapshot["stage"]["key"] == "completed"
    assert snapshot["elapsed_seconds"] == 300


def test_snapshot_uses_job_state_and_finish_tool_as_authoritative_progress(tmp_path: Path) -> None:
    run_dir = _write_run(tmp_path, findings=[])
    _write_db(run_dir)
    _append_tool_call(run_dir, "finish_scan", "2026-01-01T00:04:00Z")

    reporting = build_run_snapshot(
        run_dir,
        now=datetime(2026, 1, 1, 0, 5, tzinfo=UTC),
    )
    assert reporting["stage"]["key"] == "reporting"

    stopped = build_run_snapshot(
        run_dir,
        job={
            "run_name": "console_snapshot",
            "status": "stopped",
            "started_at": "2026-01-01T00:01:00Z",
            "finished_at": "2026-01-01T00:06:00Z",
        },
        now=datetime(2026, 1, 1, 0, 10, tzinfo=UTC),
    )
    assert stopped["status"] == "stopped"
    assert stopped["stage"]["key"] == "stopped"
    assert stopped["elapsed_seconds"] == 300


def test_snapshot_degrades_for_missing_or_corrupt_artifacts(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "run.json").write_text("{broken", encoding="utf-8")
    (run_dir / "vulnerabilities.json").write_text("[]", encoding="utf-8")

    snapshot = build_run_snapshot(run_dir, now=datetime(2026, 1, 1, tzinfo=UTC))

    assert snapshot["run_name"] == "run"
    assert snapshot["status"] == "unknown"
    assert snapshot["agent_stats"]["total"] == 0
    assert snapshot["event_count"] == 0
    assert snapshot["findings"] == []


def test_run_manager_snapshot_rejects_invalid_and_unknown_names(tmp_path: Path) -> None:
    manager = RunManager(tmp_path)
    with pytest.raises(ConsoleRequestError) as invalid:
        manager.run_snapshot("../outside")
    assert invalid.value.status.value == 400

    with pytest.raises(ConsoleRequestError) as missing:
        manager.run_snapshot("console_missing")
    assert missing.value.status.value == 404


def test_snapshot_api_requires_session_and_handles_404(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run_dir = _write_run(tmp_path, findings=[])
    assets = tmp_path / "bundle"
    assets.mkdir()
    (assets / "index.html").write_text("<div>console</div>", encoding="utf-8")
    monkeypatch.setattr("strix.interface.viewer.server.bundle_dir", lambda: assets)
    manager = RunManager(tmp_path)
    httpd, url, token = serve(
        None,
        open_browser=False,
        base_dir=tmp_path / "strix_runs",
        console_manager=manager,
    )
    try:
        request = urllib.request.Request(  # noqa: S310 - localhost test server
            f"{url}/api/console/runs/{run_dir.name}/snapshot"
        )
        with pytest.raises(urllib.error.HTTPError) as forbidden:
            urllib.request.urlopen(request)  # noqa: S310 - local test server
        assert forbidden.value.code == 403

        page = urllib.request.urlopen(  # noqa: S310 - local test server
            authorized_url(url, token, extra_query={"console": "1"})
        )
        cookie = page.headers["Set-Cookie"].split(";", 1)[0]
        headers = {"Cookie": cookie}
        request = urllib.request.Request(  # noqa: S310 - localhost test server
            f"{url}/api/console/runs/{run_dir.name}/snapshot",
            headers=headers,
        )
        with urllib.request.urlopen(request) as response:  # noqa: S310 - local test server
            payload = json.loads(response.read())
        assert payload["run_name"] == run_dir.name

        missing = urllib.request.Request(  # noqa: S310 - localhost test server
            f"{url}/api/console/runs/console_missing/snapshot",
            headers=headers,
        )
        with pytest.raises(urllib.error.HTTPError) as not_found:
            urllib.request.urlopen(missing)  # noqa: S310 - local test server
        assert not_found.value.code == 404
    finally:
        httpd.shutdown()
        httpd.server_close()
