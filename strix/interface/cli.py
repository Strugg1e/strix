import asyncio
import atexit
import contextlib
import json
import logging
import signal
import sys
import threading
import time
from pathlib import Path
from typing import Any

from rich.console import Console
from rich.live import Live
from rich.panel import Panel
from rich.text import Text

from strix.config import load_settings
from strix.core.agents import AgentCoordinator
from strix.core.inputs import DEFAULT_MAX_TURNS
from strix.core.paths import run_dir_for, runtime_state_dir
from strix.core.runner import run_strix_scan
from strix.report.state import ReportState, set_global_report_state
from strix.runtime import session_manager

from .utils import (
    build_live_stats_text,
    format_vulnerability_report,
)


logger = logging.getLogger(__name__)


async def _watch_console_commands(
    coordinator: AgentCoordinator,
    command_path: Path,
) -> None:
    """Deliver local-console JSONL commands into live SDK sessions."""
    try:
        offset = command_path.stat().st_size
    except OSError:
        offset = 0
    pending = b""
    while True:
        await asyncio.sleep(0.25)
        try:
            with command_path.open("rb") as handle:
                handle.seek(offset)
                chunk = handle.read()
        except OSError:
            continue
        if not chunk:
            continue
        offset += len(chunk)
        lines = (pending + chunk).split(b"\n")
        pending = lines.pop()
        for raw in lines:
            if not raw.strip():
                continue
            try:
                command = json.loads(raw)
            except (UnicodeDecodeError, json.JSONDecodeError):
                logger.warning("ignored malformed local-console command")
                continue
            agent_id = command.get("agent_id") if isinstance(command, dict) else None
            message = command.get("message") if isinstance(command, dict) else None
            if not isinstance(agent_id, str) or not isinstance(message, str):
                continue
            delivered = await coordinator.send(
                agent_id,
                {"from": "user", "content": message, "type": "instruction"},
            )
            if not delivered:
                logger.warning("local-console command was not delivered to agent %s", agent_id)


def _resolve_sandbox_image() -> str:
    image = load_settings().runtime.image
    if not image:
        raise RuntimeError(
            "strix_image is not configured. Set it in ~/.strix/cli-config.json.",
        )
    return image


async def run_cli(args: Any) -> None:  # noqa: PLR0915
    console = Console()

    start_text = Text()
    start_text.append("Penetration test initiated", style="bold #22c55e")

    target_text = Text()
    target_text.append("Target", style="dim")
    target_text.append("  ")
    if len(args.targets_info) == 1:
        target_text.append(args.targets_info[0]["original"], style="bold white")
    else:
        target_text.append(f"{len(args.targets_info)} targets", style="bold white")
        for target_info in args.targets_info:
            target_text.append("\n        ")
            target_text.append(target_info["original"], style="white")

    results_text = Text()
    results_text.append("Output", style="dim")
    results_text.append("  ")
    results_text.append(f"strix_runs/{args.run_name}", style="#60a5fa")

    note_text = Text()
    note_text.append("\n\n", style="dim")
    note_text.append("Vulnerabilities will be displayed in real-time.", style="dim")

    startup_panel = Panel(
        Text.assemble(
            start_text,
            "\n\n",
            target_text,
            "\n",
            results_text,
            note_text,
        ),
        title="[bold white]STRIX",
        title_align="left",
        border_style="#22c55e",
        padding=(1, 2),
    )

    console.print("\n")
    console.print(startup_panel)
    console.print()

    scan_mode = getattr(args, "scan_mode", "deep")

    scan_config: dict[str, Any] = {
        "scan_id": args.run_name,
        "targets": args.targets_info,
        "user_instructions": args.instruction or "",
        "run_name": args.run_name,
        "diff_scope": getattr(args, "diff_scope", {"active": False}),
        "scan_mode": scan_mode,
        "report_language": getattr(args, "report_language", "zh-CN"),
        "non_interactive": bool(getattr(args, "non_interactive", False)),
        "local_sources": getattr(args, "local_sources", None) or [],
        "scope_mode": getattr(args, "scope_mode", "auto"),
        "diff_base": getattr(args, "diff_base", None),
        "resume_instruction": getattr(args, "user_explicit_instruction", None) or "",
        "console_managed": bool(getattr(args, "console_managed", False)),
    }

    report_state = ReportState(args.run_name)
    report_state.hydrate_from_run_dir()
    report_state.set_scan_config(scan_config)
    report_state.save_run_data()

    def display_vulnerability(report: dict[str, Any]) -> None:
        report_id = report.get("id", "unknown")

        vuln_text = format_vulnerability_report(report)

        vuln_panel = Panel(
            vuln_text,
            title=f"[bold red]{report_id.upper()}",
            title_align="left",
            border_style="red",
            padding=(1, 2),
        )

        console.print(vuln_panel)
        console.print()

    report_state.vulnerability_found_callback = display_vulnerability

    def cleanup_on_exit() -> None:
        report_state.cleanup()

    def signal_handler(_signum: int, _frame: Any) -> None:
        report_state.cleanup(status="interrupted")
        sys.exit(1)

    atexit.register(cleanup_on_exit)
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, signal_handler)

    set_global_report_state(report_state)

    def create_live_status() -> Panel:
        status_text = Text()
        status_text.append("Penetration test in progress", style="bold #22c55e")
        status_text.append("\n\n")

        stats_text = build_live_stats_text(report_state)
        if stats_text:
            status_text.append(stats_text)

        return Panel(
            status_text,
            title="[bold white]STRIX",
            title_align="left",
            border_style="#22c55e",
            padding=(1, 2),
        )

    console_managed = bool(getattr(args, "console_managed", False))
    coordinator = AgentCoordinator() if console_managed else None
    command_task: asyncio.Task[None] | None = None
    if coordinator is not None:
        command_path = runtime_state_dir(run_dir_for(args.run_name)) / "console-commands.jsonl"
        command_task = asyncio.create_task(
            _watch_console_commands(coordinator, command_path),
            name=f"console-commands-{args.run_name}",
        )

    try:
        console.print()

        with Live(
            create_live_status(), console=console, refresh_per_second=2, transient=False
        ) as live:
            stop_updates = threading.Event()

            def update_status() -> None:
                while not stop_updates.is_set():
                    try:
                        live.update(create_live_status())
                        time.sleep(2)
                    except Exception:
                        break

            update_thread = threading.Thread(target=update_status, daemon=True)
            update_thread.start()

            try:
                logger.info(
                    "CLI launching scan: run_name=%s targets=%d interactive=%s",
                    args.run_name,
                    len(scan_config.get("targets") or []),
                    console_managed,
                )
                await run_strix_scan(
                    scan_config=scan_config,
                    scan_id=args.run_name,
                    image=_resolve_sandbox_image(),
                    local_sources=getattr(args, "local_sources", None) or [],
                    coordinator=coordinator,
                    interactive=console_managed,
                    max_budget_usd=getattr(args, "max_budget_usd", None),
                    max_turns=getattr(args, "max_turns", DEFAULT_MAX_TURNS),
                )
            finally:
                stop_updates.set()
                update_thread.join(timeout=1)
                with contextlib.suppress(Exception):
                    await session_manager.cleanup(args.run_name)

    except Exception as e:
        console.print(f"[bold red]Error during penetration test:[/] {e}")
        raise
    finally:
        if command_task is not None:
            command_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await command_task

    if report_state.final_scan_result:
        console.print()

        final_report_text = Text()
        final_report_text.append("Penetration test summary", style="bold #60a5fa")

        final_report_panel = Panel(
            Text.assemble(
                final_report_text,
                "\n\n",
                report_state.final_scan_result,
            ),
            title="[bold white]STRIX",
            title_align="left",
            border_style="#60a5fa",
            padding=(1, 2),
        )

        console.print(final_report_panel)
        console.print()
