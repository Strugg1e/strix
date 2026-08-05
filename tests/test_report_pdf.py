"""Tests for building and encrypting the viewer PDF report."""

from __future__ import annotations

import json
from io import BytesIO
from typing import TYPE_CHECKING

import pytest
from pypdf import PdfReader
from pypdf.errors import WrongPasswordError

from strix.interface.viewer.report_pdf import (
    _inline_md,
    build_encrypted_report,
    encrypt_pdf,
    generate_password,
    generate_report_pdf,
)


if TYPE_CHECKING:
    from pathlib import Path


def _make_run(base: Path, name: str = "sample", *, chinese: bool = False) -> Path:
    run_dir = base / "strix_runs" / name
    run_dir.mkdir(parents=True)
    record = {
        "run_name": name,
        "targets_info": [
            {"original": "https://example.com/中文" if chinese else "https://example.com"}
        ],
        "scan_mode": "deep",
        "status": "completed",
        "start_time": "2026-01-01T00:00:00Z",
        "end_time": "2026-01-01T01:02:03Z",
        "scan_results": {
            "executive_summary": (
                "中文摘要:发现漏洞。\n\n- 缺少输入验证\n- 需要升级依赖。使用 `中文参数`。"
                '\n\n```python\n# 中文代码块\nprint("测试")\n```'
                "\n\n### **加粗中文标题**"
                if chinese
                else "Summary with an ampersand & an <angle> bracket."
            ),
            "recommendations": "修复建议:更新依赖。" if chinese else "Patch things.",
        },
    }
    (run_dir / "run.json").write_text(json.dumps(record), encoding="utf-8")
    vulns = [
        {
            "title": "SQL 注入漏洞" if chinese else "SQL Injection",
            "severity": "CRITICAL",
            "cvss": 9.8,
            "description": "描述:用户输入未验证。" if chinese else "User input reaches the query.",
            "impact": "影响:数据库泄露。" if chinese else "Full database read.",
            "technical_analysis": "技术分析:参数存在注入。" if chinese else "Details here.",
            "poc_description": "PoC 描述:发送中文参数." if chinese else "Send a crafted parameter.",
            "poc_script_code": (
                '# 中文代码\nprint("https://example.com/?q=测试")\n  indented()'
                if chinese
                else "print('exploit')"
            ),
            "evidence": "证据:HTTP 500。" if chinese else "HTTP 500 with SQL error.",
            "remediation_steps": (
                ["使用参数化查询", "验证输入"]
                if chinese
                else ["Use parameterized queries", "Validate input"]
            ),
            "target": "https://example.com/中文" if chinese else "https://example.com",
            "endpoint": "/login",
            "method": "POST",
        },
        {"title": "Informational note", "severity": "info"},
    ]
    (run_dir / "vulnerabilities.json").write_text(json.dumps(vulns), encoding="utf-8")
    return run_dir


def test_generate_report_pdf_has_pdf_header(tmp_path: Path) -> None:
    run_dir = _make_run(tmp_path)
    pdf = generate_report_pdf(run_dir)
    assert pdf.startswith(b"%PDF-")
    assert len(pdf) > 1000


def test_generate_report_pdf_embeds_cjk_fonts_and_preserves_code(tmp_path: Path) -> None:
    run_dir = _make_run(tmp_path, chinese=True)
    pdf = generate_report_pdf(run_dir)
    reader = PdfReader(BytesIO(pdf))
    extracted = "\n".join(page.extract_text() or "" for page in reader.pages)

    for expected in (
        "中文摘要",
        "SQL 注入漏洞",
        "用户输入未验证",
        "中文代码",
        "中文代码块",
        "测试",
        "中文参数",
        "加粗中文标题",
    ):
        assert expected in extracted
    assert not any(marker in extracted for marker in ("■", "□", "�"))

    embedded_fonts: set[str] = set()
    for page in reader.pages:
        resources = page.get("/Resources")
        assert resources is not None
        for font_ref in resources.get("/Font", {}).values():
            font = font_ref.get_object()
            base_font = str(font.get("/BaseFont", ""))
            if "NotoSansSC" not in base_font:
                continue
            descriptor_ref = font.get("/FontDescriptor")
            assert descriptor_ref is not None
            descriptor = descriptor_ref.get_object()
            assert descriptor.get("/FontFile2") is not None
            embedded_fonts.add(base_font)

    assert any("NotoSansSC-Regular" in name for name in embedded_fonts)
    assert any("NotoSansSC-Bold" in name for name in embedded_fonts)
    assert _inline_md("inline `curl  -X POST`") == (
        'inline <font face="Courier" color="#b31d28">curl  -X POST</font>'
    )
    assert 'face="Courier"' in _inline_md("inline `curl  -X POST 中文`")


def test_generate_password_is_long_and_random() -> None:
    first = generate_password()
    second = generate_password()
    assert len(first) >= 20
    assert first != second


def test_encrypt_pdf_roundtrip(tmp_path: Path) -> None:
    run_dir = _make_run(tmp_path)
    pdf = generate_report_pdf(run_dir)
    password = generate_password()
    encrypted = encrypt_pdf(pdf, password)

    reader = PdfReader(BytesIO(encrypted))
    assert reader.is_encrypted
    assert reader.decrypt(password)
    # A correct password unlocks the pages.
    assert len(reader.pages) >= 1


def test_wrong_password_is_rejected(tmp_path: Path) -> None:
    run_dir = _make_run(tmp_path)
    encrypted = encrypt_pdf(generate_report_pdf(run_dir), "correct-horse-battery")
    with pytest.raises(WrongPasswordError):
        PdfReader(BytesIO(encrypted), password="not-the-password")  # nosec B106


def test_build_encrypted_report(tmp_path: Path) -> None:
    run_dir = _make_run(tmp_path, name="run-42")
    pdf_bytes, password, filename = build_encrypted_report(run_dir)

    assert filename == "strix-report-run-42.pdf"
    assert len(password) >= 20
    reader = PdfReader(BytesIO(pdf_bytes))
    assert reader.is_encrypted
    assert reader.decrypt(password)
