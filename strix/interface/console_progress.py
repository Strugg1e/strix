"""Small, read-only projections for the local console run dashboard.

The console needs a useful snapshot while a scan is still writing its state.  A
full transcript replay is deliberately not used here: the agent graph is read
from ``agents.json`` and SQLite is queried only for a bounded count and a small
tail of activity rows.  Every source is best-effort so a half-written artifact
cannot turn a polling request into a 500 response.
"""
# ruff: noqa: RUF001

from __future__ import annotations

import json
import logging
import re
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

from strix.core.paths import run_record_path, runtime_state_dir
from strix.interface.viewer.transcript import severity_counts


logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from collections.abc import Mapping

_TERMINAL_STATUSES = frozenset({"completed", "stopped", "failed", "interrupted"})
_AGENT_STATUS_KEYS = ("running", "waiting", "completed", "failed", "stopped", "crashed")
_FINDINGS_LIMIT = 8
_ACTIVITY_LIMIT = 10
_TITLE_LIMIT = 240
_VALUE_LIMIT = 512
_LOG_TAIL_BYTES = 128 * 1024
_MAX_DIAGNOSTIC_AGENTS = 100


def build_run_snapshot(
    run_dir: Path,
    job: Mapping[str, Any] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Build a compact, safe-to-serialize snapshot for one run directory.

    ``job`` is the in-memory console job when the run is active.  Its process
    timestamps and status take precedence over a stale ``run.json`` record.
    Historical snapshots use the record on disk.  Missing or malformed files
    contribute empty fields instead of raising.
    """

    run_dir = Path(run_dir)
    record = _read_object(run_record_path(run_dir))
    run_name = _safe_text(
        (job or {}).get("run_name") if job else None,
        fallback=_safe_text(record.get("run_name"), fallback=run_dir.name),
        limit=80,
    )

    job_status = _safe_text((job or {}).get("status"), fallback="")
    status = job_status or _safe_text(record.get("status"), fallback="unknown")
    if status == "interrupted":
        status = "stopped"

    start_time = _safe_timestamp(
        (job or {}).get("started_at") if job else None,
        record.get("start_time"),
    )
    end_time = _safe_timestamp(
        (job or {}).get("finished_at") if job else None,
        record.get("end_time"),
    )
    clock = _as_utc(now) if now is not None else datetime.now(UTC)
    elapsed_seconds = _elapsed_seconds(start_time, end_time, clock)

    agents = _read_agent_snapshot(run_dir)
    agent_stats = _agent_stats(agents.get("statuses"))
    agent_rows = _agent_rows(agents)
    event_count, db_last_activity, activities = _read_activity(run_dir, agents)

    vulnerabilities = _read_list(run_dir / "vulnerabilities.json")
    findings = _finding_summaries(vulnerabilities)
    counts = severity_counts(vulnerabilities)
    findings_total = len(findings["all"])
    report_exists = (run_dir / "penetration_test_report.md").is_file()

    completion_evidence = _completion_evidence(run_dir)
    error_counts = _error_counts(run_dir, agents)
    completion_state = _completion_state(
        status=status,
        end_time=end_time,
        finish_scan=completion_evidence["finish_scan"],
        report_exists=report_exists,
        error_counts=error_counts,
    )
    completion_signal = completion_state == "completed"
    termination_reason = _termination_reason(
        status=status,
        completion_state=completion_state,
        completion_signal=completion_signal,
        finish_scan=completion_evidence["finish_scan"],
        report_exists=report_exists,
        error_counts=error_counts,
    )
    artifacts = _artifact_state(run_dir, report_exists, findings_total)
    config = _config_summary(run_dir, run_name, record, job)

    stage = _stage(
        status=status,
        completion_state=completion_state,
        event_count=event_count,
        agent_stats=agent_stats,
        findings_total=findings_total,
        reporting_started=report_exists
        or completion_evidence["finish_scan"],
    )
    last_activity_at = _latest_timestamp(
        db_last_activity,
        *(_safe_timestamp(item.get("timestamp")) for item in findings["all"]),
        start_time,
        end_time,
    )

    return {
        "run_name": run_name,
        "status": status,
        "finished": completion_state == "completed",
        "completion_state": completion_state,
        "completion_signal": completion_signal,
        "completion_evidence": completion_evidence,
        "termination_reason": termination_reason,
        "error_counts": error_counts,
        "report_available": report_exists,
        "artifacts": artifacts,
        "config": config,
        "start_time": start_time,
        "end_time": end_time,
        "started_at": start_time,
        "finished_at": end_time,
        "elapsed_seconds": elapsed_seconds,
        "stage": stage,
        "agent_stats": agent_stats,
        "agents": agent_rows,
        "event_count": event_count,
        "last_activity_at": last_activity_at,
        "severity_counts": counts,
        "findings_total": findings_total,
        "findings": findings["recent"],
        "recent_activity": activities,
        "result_url": f"/?run={quote(run_name, safe='')}",
    }


def _read_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def _read_list(path: Path) -> list[dict[str, Any]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return []
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _read_agent_snapshot(run_dir: Path) -> dict[str, Any]:
    return _read_object(runtime_state_dir(run_dir) / "agents.json")


def _agent_stats(raw_statuses: Any) -> dict[str, int]:
    statuses = raw_statuses if isinstance(raw_statuses, dict) else {}
    stats = dict.fromkeys(_AGENT_STATUS_KEYS, 0)
    stats["budget_paused"] = 0
    stats["other"] = 0
    for raw_status in statuses.values():
        status = _safe_text(raw_status, fallback="other")
        if status not in stats:
            stats["other"] += 1
        else:
            stats[status] += 1
    stats["total"] = len(statuses)
    return stats


def _agent_rows(snapshot: Mapping[str, Any]) -> list[dict[str, Any]]:
    statuses = snapshot.get("statuses")
    names = snapshot.get("names")
    parents = snapshot.get("parent_of")
    if not isinstance(statuses, dict):
        return []
    rows: list[dict[str, Any]] = []
    for agent_id, raw_status in list(statuses.items())[:64]:
        if not isinstance(agent_id, str):
            continue
        row = {
            "id": agent_id[:80],
            "name": _safe_text(
                names.get(agent_id) if isinstance(names, dict) else None,
                fallback=agent_id,
            ),
            "status": _safe_text(raw_status, fallback="other"),
            "parent_id": parents.get(agent_id) if isinstance(parents, dict) else None,
        }
        rows.append(row)
    return rows


def _read_activity(
    run_dir: Path,
    snapshot: Mapping[str, Any],
) -> tuple[int, str | None, list[dict[str, str]]]:
    db_path = runtime_state_dir(run_dir) / "agents.db"
    if not db_path.is_file():
        return 0, None, []

    names = snapshot.get("names")
    activities: list[dict[str, str]] = []
    conn: sqlite3.Connection | None = None
    try:
        # mode=ro allows WAL readers to observe committed rows without creating
        # or mutating a database while the scan process is writing it.
        conn = sqlite3.connect(
            f"file:{db_path}?mode=ro",
            uri=True,
            timeout=0.2,
            check_same_thread=False,
        )
        count_row = conn.execute(
            "select count(*), max(created_at) from agent_messages",
        ).fetchone()
        count = int(count_row[0] or 0) if count_row else 0
        latest = _safe_timestamp(count_row[1] if count_row else None)
        rows = conn.execute(
            "select session_id, message_data, created_at "
            "from agent_messages order by id desc limit ?",
            (_ACTIVITY_LIMIT,),
        ).fetchall()
    except (sqlite3.Error, OSError, TypeError, ValueError):
        logger.debug("Unable to read console activity from %s", db_path, exc_info=True)
        return 0, None, []
    finally:
        if conn is not None:
            conn.close()

    for session_id, raw_message, created_at in reversed(rows):
        item = _json_object(raw_message)
        if not item:
            continue
        agent_id = _safe_text(session_id, fallback="unknown", limit=80)
        name = _safe_text(
            names.get(agent_id) if isinstance(names, dict) else None,
            fallback=agent_id,
        )
        kind, tool = _activity_kind(item)
        activity = {
            "timestamp": _safe_timestamp(created_at) or "",
            "agent_id": agent_id,
            "agent": name[:_TITLE_LIMIT],
            "kind": kind,
        }
        if tool:
            activity["tool"] = tool[:_TITLE_LIMIT]
        activities.append(activity)
    return count, latest, activities[-_ACTIVITY_LIMIT:]


def _activity_kind(item: Mapping[str, Any]) -> tuple[str, str | None]:
    item_type = _safe_text(item.get("type"), fallback="event")
    if item_type == "function_call":
        return "tool_call", _safe_text(item.get("name"), fallback="tool")
    if item_type == "function_call_output":
        return "tool_result", _safe_text(item.get("name"), fallback="") or None
    if item_type in {"message", "response_item"}:
        return _safe_text(item.get("role"), fallback="message"), None
    return item_type[:40], None


def _finding_summaries(vulnerabilities: list[dict[str, Any]]) -> dict[str, Any]:
    all_items: list[dict[str, str]] = []
    for index, vuln in enumerate(vulnerabilities):
        finding_id = _safe_text(vuln.get("id"), fallback=f"finding-{index + 1}", limit=80)
        all_items.append(
            {
                "id": finding_id,
                "title": _safe_text(vuln.get("title"), fallback="未命名发现", limit=_TITLE_LIMIT),
                "severity": _safe_text(vuln.get("severity"), fallback="low", limit=40).lower(),
                "target": _safe_text(vuln.get("target"), fallback="", limit=_VALUE_LIMIT),
                "endpoint": _safe_text(vuln.get("endpoint"), fallback="", limit=_VALUE_LIMIT),
                "timestamp": _safe_timestamp(vuln.get("timestamp")) or "",
            },
        )
    return {"all": all_items, "recent": list(reversed(all_items[-_FINDINGS_LIMIT:]))}


def _completion_evidence(run_dir: Path) -> dict[str, Any]:
    """Read durable completion evidence without exposing transcript contents."""

    db_path = runtime_state_dir(run_dir) / "agents.db"
    finish_scan_calls = 0
    conn: sqlite3.Connection | None = None
    try:
        if not db_path.is_file():
            return {"finish_scan": False, "finish_scan_calls": 0}
        conn = sqlite3.connect(
            f"file:{db_path}?mode=ro",
            uri=True,
            timeout=0.2,
            check_same_thread=False,
        )
        # Search the complete persisted message set, rather than the ten-row
        # activity tail used for the live timeline.  Parse each candidate so a
        # prompt mentioning finish_scan cannot become a false completion signal.
        rows = conn.execute(
            "select message_data from agent_messages "
            "where lower(message_data) like '%finish_scan%'",
        ).fetchall()
    except (sqlite3.Error, OSError, TypeError, ValueError):
        logger.debug("Unable to read completion evidence from %s", db_path, exc_info=True)
        return {"finish_scan": False, "finish_scan_calls": 0}
    finally:
        if conn is not None:
            conn.close()

    for (raw_message,) in rows:
        item = _json_object(raw_message)
        if _function_call_name(item) == "finish_scan":
            finish_scan_calls += 1
    return {
        "finish_scan": finish_scan_calls > 0,
        "finish_scan_calls": finish_scan_calls,
    }


def _function_call_name(item: Mapping[str, Any]) -> str:
    if _safe_text(item.get("type"), fallback="") != "function_call":
        return ""
    name = item.get("name")
    if not isinstance(name, str):
        function = item.get("function")
        name = function.get("name") if isinstance(function, dict) else ""
    return _safe_text(name, fallback="").lower()


def _error_counts(run_dir: Path, snapshot: Mapping[str, Any]) -> dict[str, int]:
    """Classify persisted agent errors and a bounded log tail into safe counts."""

    errors = snapshot.get("errors")
    statuses = snapshot.get("statuses")
    status_values = statuses.items() if isinstance(statuses, dict) else ()

    max_turn_agents = {
        str(agent_id)
        for agent_id, error in (errors.items() if isinstance(errors, dict) else ())
        if _contains_max_turns(error)
    }
    timeout_agents = {
        str(agent_id)
        for agent_id, error in (errors.items() if isinstance(errors, dict) else ())
        if _contains_read_timeout(error)
    }
    crashed_agents = {
        str(agent_id)
        for agent_id, status in status_values
        if _safe_text(status, fallback="").lower() == "crashed"
    }

    log_text = _read_log_tail(run_dir / "strix.log")
    log_max_agents, log_timeout_agents, log_crashed_agents = _classify_log_tail(log_text)
    max_turn_agents.update(log_max_agents)
    timeout_agents.update(log_timeout_agents)
    crashed_agents.update(log_crashed_agents)

    # If an older run has only an unstructured log line, preserve a conservative
    # one-event signal without counting repeated traceback lines as new agents.
    max_turn_count = len(max_turn_agents)
    if max_turn_count == 0 and re.search(r"max\s+turns?\b", log_text, re.IGNORECASE):
        max_turn_count = 1
    timeout_count = len(timeout_agents)
    if timeout_count == 0 and re.search(r"(?:httpx|httpcore)\.ReadTimeout", log_text):
        timeout_count = 1

    return {
        "max_turns": min(max_turn_count, _MAX_DIAGNOSTIC_AGENTS),
        "read_timeout": min(timeout_count, _MAX_DIAGNOSTIC_AGENTS),
        "crashed_agents": min(len(crashed_agents), _MAX_DIAGNOSTIC_AGENTS),
        "failed_agents": min(
            sum(
                1
                for _agent_id, status in (statuses.items() if isinstance(statuses, dict) else ())
                if _safe_text(status, fallback="").lower() == "failed"
            ),
            _MAX_DIAGNOSTIC_AGENTS,
        ),
    }


def _contains_max_turns(value: Any) -> bool:
    return bool(re.search(r"max\s+turns?\b", _safe_text(value, fallback=""), re.IGNORECASE))


def _contains_read_timeout(value: Any) -> bool:
    return bool(
        re.search(
            r"(?:httpx|httpcore)\.ReadTimeout|read\s*timeout",
            _safe_text(value, fallback=""),
            re.IGNORECASE,
        )
    )


def _read_log_tail(path: Path) -> str:
    try:
        with path.open("rb") as handle:
            handle.seek(0, 2)
            size = handle.tell()
            handle.seek(max(0, size - _LOG_TAIL_BYTES))
            return handle.read(_LOG_TAIL_BYTES).decode("utf-8", errors="replace")
    except OSError:
        return ""


def _classify_log_tail(text: str) -> tuple[set[str], set[str], set[str]]:
    max_turn_agents: set[str] = set()
    timeout_agents: set[str] = set()
    crashed_agents: set[str] = set()
    current_agent: str | None = None
    for line in text.splitlines():
        match = re.search(
            r"agent run failed for ([^;\s]+); parking as ([a-z_]+)",
            line,
            re.IGNORECASE,
        )
        if match:
            current_agent = match.group(1)[:80]
            if match.group(2).lower() == "crashed":
                crashed_agents.add(current_agent)
        if current_agent is None:
            continue
        if re.search(r"max\s+turns?\b", line, re.IGNORECASE):
            max_turn_agents.add(current_agent)
        if re.search(r"(?:httpx|httpcore)\.ReadTimeout|read\s*timeout", line, re.IGNORECASE):
            timeout_agents.add(current_agent)
    return max_turn_agents, timeout_agents, crashed_agents


def _completion_state(
    *,
    status: str,
    end_time: str | None,
    finish_scan: bool,
    report_exists: bool,
    error_counts: Mapping[str, int],
) -> str:
    if status in {"running", "stopping"} and not end_time:
        return "running"
    if status == "completed":
        return "completed" if finish_scan or report_exists else "unknown"
    if status in {"stopped", "failed", "interrupted"}:
        return "incomplete"
    if status == "running":
        return "running"
    if any(
        error_counts.get(key, 0)
        for key in ("max_turns", "read_timeout", "crashed_agents", "failed_agents")
    ):
        return "incomplete"
    return "unknown"


def _termination_reason(
    *,
    status: str,
    completion_state: str,
    completion_signal: bool,
    finish_scan: bool,
    report_exists: bool,
    error_counts: Mapping[str, int],
) -> dict[str, str]:
    if completion_state == "running":
        return {"kind": "running", "label": "进行中", "detail": "Agent 仍在执行扫描"}
    if completion_signal:
        return {"kind": "completed", "label": "已完成", "detail": "检测到完成信号与结果产物"}

    causes: list[str] = []
    if error_counts.get("max_turns", 0):
        causes.append(f"达到最大轮次 {error_counts['max_turns']} 个 Agent")
    if error_counts.get("read_timeout", 0):
        causes.append(f"模型请求超时 {error_counts['read_timeout']} 个 Agent")
    if error_counts.get("crashed_agents", 0):
        causes.append(f"崩溃 Agent {error_counts['crashed_agents']} 个")
    if not finish_scan:
        causes.append("未检测到 finish_scan")
    if not report_exists:
        causes.append("未生成最终报告")
    detail = "；".join(causes) or "缺少可确认的完成证据"

    if completion_state == "incomplete":
        kind = (
            "agent_error"
            if error_counts.get("max_turns", 0) or error_counts.get("read_timeout", 0)
            else status
        )
        return {"kind": kind, "label": "异常未完整完成", "detail": detail}
    return {"kind": "unknown", "label": "状态证据不足", "detail": detail}


def _artifact_state(run_dir: Path, report_exists: bool, findings_total: int) -> dict[str, Any]:
    vulnerabilities_available = (run_dir / "vulnerabilities.json").is_file()
    sarif_available = (run_dir / "findings.sarif").is_file()
    if report_exists:
        state = "complete"
    elif vulnerabilities_available or findings_total or sarif_available:
        state = "partial"
    else:
        state = "missing"
    return {
        "state": state,
        "report_available": report_exists,
        "vulnerabilities_available": vulnerabilities_available,
        "sarif_available": sarif_available,
        "findings_count": findings_total,
    }


def _config_summary(
    run_dir: Path,
    run_name: str,
    record: Mapping[str, Any],
    job: Mapping[str, Any] | None,
) -> dict[str, Any]:
    settings_root = _read_object(run_dir.parent / ".console" / "run-settings.json")
    settings = settings_root.get(run_name)
    settings = settings if isinstance(settings, dict) else {}

    def value(key: str) -> Any:
        if job and key in job and job.get(key) not in (None, ""):
            return job.get(key)
        if settings.get(key) not in (None, ""):
            return settings.get(key)
        return record.get(key)

    profile_id = _safe_config_text(value("profile_id"))
    profile_name = _safe_config_text(value("profile_name"))
    return {
        "scan_mode": _safe_config_text(value("scan_mode")),
        "scope_mode": _safe_config_text(value("scope_mode")),
        "max_turns": _safe_config_number(value("max_turns"), integer=True),
        "max_budget_usd": _safe_config_number(value("max_budget_usd")),
        "profile_id": profile_id,
        "profile_name": profile_name,
        "profile": {"id": profile_id, "name": profile_name},
        "model": _safe_config_text(value("model")),
        "use_proxy": value("use_proxy") if isinstance(value("use_proxy"), bool) else None,
        "report_language": _safe_config_text(value("report_language")),
    }


def _safe_config_text(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()[:_VALUE_LIMIT]
    return re.sub(
        r"(?i)(api[_ -]?key|access[_ -]?token|secret|password)\s*[:=]\s*[^\s,;]+",
        r"\1=[REDACTED]",
        text,
    )


def _safe_config_number(value: Any, *, integer: bool = False) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    if integer:
        return max(0, int(value))
    return max(0.0, float(value))


def _stage(
    *,
    status: str,
    completion_state: str,
    event_count: int,
    agent_stats: Mapping[str, int],
    findings_total: int,
    reporting_started: bool,
) -> dict[str, Any]:
    if completion_state == "completed":
        key = "completed"
    elif status == "failed":
        key = "failed"
    elif status == "stopping":
        key = "stopping"
    elif status in {"stopped", "interrupted"}:
        key = "stopped"
    elif reporting_started:
        key = "reporting"
    elif findings_total and (agent_stats.get("running", 0) or agent_stats.get("waiting", 0)):
        key = "validating"
    elif event_count or agent_stats.get("total", 0):
        key = "exploring"
    else:
        key = "preparing"

    stages = {
        "preparing": (1, "准备环境", "正在建立 Agent 图与运行上下文"),
        "exploring": (2, "探索目标", "Agent 正在执行侦察与测试步骤"),
        "validating": (3, "验证发现", "已记录发现，Agent 正在确认影响范围"),
        "reporting": (4, "整理结果", "正在生成最终报告与结果文件"),
        "completed": (5, "已完成", "运行已结束，结果可以查看"),
        "stopping": (5, "停止中", "正在中断 Agent，已写入的结果会保留"),
        "stopped": (5, "已停止", "运行已停止，已写入的结果仍然保留"),
        "failed": (5, "执行失败", "运行异常结束，请查看日志与已写入结果"),
    }
    ordinal, label, detail = stages[key]
    return {"key": key, "label": label, "detail": detail, "ordinal": ordinal, "total": 5}


def _elapsed_seconds(start: str | None, end: str | None, now: datetime) -> int:
    start_dt = _parse_timestamp(start)
    if start_dt is None:
        return 0
    end_dt = _parse_timestamp(end) or now
    return max(0, int((end_dt - start_dt).total_seconds()))


def _latest_timestamp(*values: str | None) -> str | None:
    parsed: list[tuple[datetime, str]] = []
    for value in values:
        timestamp = _parse_timestamp(value)
        if timestamp is not None:
            parsed.append((timestamp, timestamp.isoformat()))
    return max(parsed, default=(None, None))[1]


def _safe_timestamp(*values: Any) -> str | None:
    for value in values:
        parsed = _parse_timestamp(value)
        if parsed is not None:
            return parsed.isoformat()
    return None


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)).astimezone(UTC)


def _as_utc(value: datetime) -> datetime:
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).astimezone(UTC)


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return {}
    try:
        parsed = json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _safe_text(value: Any, *, fallback: str = "", limit: int = _VALUE_LIMIT) -> str:
    text = value.strip() if isinstance(value, str) else ""
    return (text or fallback)[:limit]


__all__ = ["build_run_snapshot"]
