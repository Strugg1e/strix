import assert from "node:assert/strict";
import test from "node:test";
import {
  formatDuration,
  formatNumber,
  formatRelativeTime,
  markdownHeadingLabel,
  scanModeLabel,
  scopeModeLabel,
  severityLabel,
  statusLabel,
  targetTypeLabel,
} from "../src/lib/locale.ts";

test("maps report severities and run statuses to Chinese", () => {
  assert.equal(severityLabel("critical"), "严重");
  assert.equal(severityLabel("medium"), "中危");
  assert.equal(statusLabel("running"), "运行中");
  assert.equal(statusLabel("budget_paused"), "预算暂停");
  assert.equal(statusLabel("unexpected_status"), "未知");
});

test("maps run configuration enums to Chinese", () => {
  assert.equal(targetTypeLabel("web_application"), "Web 应用");
  assert.equal(targetTypeLabel("code_repository"), "代码仓库");
  assert.equal(scanModeLabel("deep"), "深度");
  assert.equal(scopeModeLabel("auto"), "自动");
});

test("maps exact standard Markdown report headings without touching unknown text", () => {
  assert.equal(markdownHeadingLabel("Description"), "描述");
  assert.equal(markdownHeadingLabel("Confirmed Findings"), "已确认发现");
  assert.equal(markdownHeadingLabel("Systemic Themes"), "系统性主题");
  assert.equal(markdownHeadingLabel("Areas Tested with No Findings"), "已测试且未发现问题的区域");
  assert.equal(markdownHeadingLabel("Immediate"), "立即");
  assert.equal(markdownHeadingLabel("Short-term"), "短期");
  assert.equal(markdownHeadingLabel("Medium-term"), "中期");
  assert.equal(markdownHeadingLabel("Retest & Validation"), "复测与验证");
  assert.equal(markdownHeadingLabel("A vulnerability title"), "A vulnerability title");
});

test("formats numbers, durations, and relative times with zh-CN copy", () => {
  assert.equal(formatNumber(1234567), "1,234,567");
  assert.equal(formatDuration(3661), "1 小时 1 分钟 1 秒");
  const now = new Date("2026-08-02T00:00:00Z");
  assert.equal(formatRelativeTime("2026-08-01T23:59:30Z", now), "刚刚");
  assert.equal(formatRelativeTime("2026-08-01T23:00:00Z", now), "1 小时前");
});
