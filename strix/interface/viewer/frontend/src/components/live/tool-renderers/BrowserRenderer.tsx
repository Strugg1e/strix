"use client";

import type { ToolRendererProps } from "@/types/events";
import { SyntaxBlock } from "./ToolCard";

const SIMPLE_ACTIONS: Record<string, string> = {
  back: "返回浏览器历史记录",
  forward: "前进浏览器历史记录",
  scroll_down: "向下滚动",
  scroll_up: "向上滚动",
  refresh: "刷新",
  close_tab: "关闭标签页",
  switch_tab: "切换标签页",
  list_tabs: "列出标签页",
  view_source: "查看页面源代码",
  get_console_logs: "获取控制台日志",
  screenshot: "截图",
  wait: "等待中…",
  close: "关闭",
};

const CLICK_ACTIONS: Record<string, string> = {
  click: "点击",
  double_click: "双击",
  hover: "悬停",
};

function UrlLabel({ prefix, url, suffix }: { prefix: string; url?: string; suffix?: string }) {
  return (
    <span className="text-[#888] text-[13px]">
      {prefix}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-cyan-400/80 hover:underline"
        >
          {url}
        </a>
      )}
      {suffix}
    </span>
  );
}

function describeAction(args: Record<string, unknown>): React.ReactNode {
  const action = (args.action as string) ?? "";
  const url = (args.url as string) ?? undefined;

  // Simple actions (no extra args)
  if (action in SIMPLE_ACTIONS) return SIMPLE_ACTIONS[action];

  // URL actions: launch, goto, new_tab
  if (action === "launch") {
    if (!url) return "启动浏览器";
    return <UrlLabel prefix="打开 " url={url} />;
  }
  if (action === "goto" || action === "navigate") {
    return <UrlLabel prefix="导航至 " url={url} />;
  }
  if (action === "new_tab") {
    return <UrlLabel prefix="打开标签页 " url={url} />;
  }

  // Click actions
  if (action in CLICK_ACTIONS) return CLICK_ACTIONS[action];

  // Type
  if (action === "type") {
    const text = ((args.text as string) ?? "").slice(0, 40);
    return `输入“${text}”`;
  }

  // Key press
  if (action === "press_key" || action === "key_press") {
    return `按键 ${(args.key as string) ?? ""}`;
  }

  // Save PDF
  if (action === "save_pdf" || action === "save_as_pdf") {
    const path = (args.file_path as string) ?? "";
    return `保存 PDF${path ? ` 至 ${path}` : ""}`;
  }

  // Execute JS — description only, code shown separately
  if (action === "execute_js") return "执行 JavaScript";

  return action || "浏览器操作";
}

export default function BrowserRenderer({ args }: ToolRendererProps) {
  const action = (args.action as string) ?? "";
  const jsCode = action === "execute_js"
    ? ((args.js_code as string) ?? (args.code as string) ?? "")
    : "";
  const description = describeAction(args);

  return (
    <div>
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-blue-400/80 font-semibold text-sm shrink-0">浏览器</span>
        <span className="min-w-0 truncate text-[#888] text-[13px]">
          {typeof description === "string" ? description : description}
        </span>
      </div>
      {jsCode && <SyntaxBlock code={jsCode} language="javascript" collapsible />}
    </div>
  );
}
