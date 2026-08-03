"""Report-language defaults and prompt directives."""

# Chinese UI copy and runtime pytest/path annotations are intentional here.
# ruff: noqa: RUF001, TC003

from __future__ import annotations

import json
import sys
from importlib import import_module
from pathlib import Path

import pytest

from strix.agents.prompt import render_system_prompt
from strix.core.inputs import build_scope_context


cli_main = import_module("strix.interface.main")


def test_report_prompt_defaults_to_simplified_chinese() -> None:
    rendered = render_system_prompt(system_prompt_context={})
    assert "报告语言：简体中文（zh-CN）" in rendered
    assert "所有面向用户的漏洞 finding 字段" in rendered
    assert "REPORT LANGUAGE: English" not in rendered


def test_report_prompt_can_be_explicitly_english() -> None:
    rendered = render_system_prompt(system_prompt_context={"report_language": "en"})
    assert "REPORT LANGUAGE: English" in rendered
    assert "Write every user-facing vulnerability finding field" in rendered
    assert "报告语言：简体中文（zh-CN）" not in rendered


def test_scope_context_carries_report_language_default_and_override() -> None:
    assert build_scope_context({})["report_language"] == "zh-CN"
    assert build_scope_context({"report_language": "en"})["report_language"] == "en"


def test_cli_report_language_defaults_and_accepts_english(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "argv", ["strix", "--target", "example.com", "--non-interactive"])
    assert cli_main.parse_arguments().report_language == "zh-CN"

    monkeypatch.setattr(
        sys,
        "argv",
        ["strix", "--target", "example.com", "--non-interactive", "--report-language", "en"],
    )
    assert cli_main.parse_arguments().report_language == "en"


def test_cli_resume_inherits_saved_language_and_allows_override(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run_name = "resume_language"
    run_dir = tmp_path / run_name
    run_dir.mkdir()
    (run_dir / "run.json").write_text(
        json.dumps(
            {
                "run_name": run_name,
                "targets_info": [{"type": "web_application", "original": "example.com"}],
                "report_language": "en",
            }
        ),
        encoding="utf-8",
    )
    state_dir = run_dir / "state"
    state_dir.mkdir()
    (state_dir / "agents.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(cli_main, "run_dir_for", lambda _name: run_dir)
    monkeypatch.setattr(cli_main, "runtime_state_dir", lambda _path: state_dir)

    monkeypatch.setattr(sys, "argv", ["strix", "--resume", run_name, "--non-interactive"])
    assert cli_main.parse_arguments().report_language == "en"

    monkeypatch.setattr(
        sys,
        "argv",
        [
            "strix",
            "--resume",
            run_name,
            "--non-interactive",
            "--report-language",
            "zh-CN",
        ],
    )
    assert cli_main.parse_arguments().report_language == "zh-CN"

    (run_dir / "run.json").write_text(
        json.dumps(
            {
                "run_name": run_name,
                "targets_info": [{"type": "web_application", "original": "example.com"}],
                "report_language": "fr",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(sys, "argv", ["strix", "--resume", run_name, "--non-interactive"])
    with pytest.raises(SystemExit):
        cli_main.parse_arguments()
