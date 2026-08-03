"use client";

import type { ToolRendererProps } from "@/types/events";
import { CodeBlock } from "./ToolCard";

const MAX_LINE_LENGTH = 200;

const METHOD_COLORS: Record<string, string> = {
  GET: "text-emerald-400/80", POST: "text-blue-400/80", PUT: "text-yellow-400/80",
  PATCH: "text-orange-400/80", DELETE: "text-red-400/80",
};

const PART_LABELS: Record<string, string> = {
  request: "请求",
  response: "响应",
  headers: "请求头",
  body: "正文",
};

function statusColor(code: number): string {
  if (code < 300) return "text-emerald-400/80";
  if (code < 400) return "text-yellow-400/80";
  if (code < 500) return "text-orange-400/80";
  return "text-red-400/80";
}

/** Hard truncate with trailing "..." */
function trunc(text: string, maxLen = 80): string {
  return text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;
}

/** Replace newlines/tabs, then truncate */
function sanitize(text: string, maxLen = 150): string {
  return trunc(text.replace(/\n/g, " ").replace(/\r/g, "").replace(/\t/g, " "), maxLen);
}

/** Limit body to maxLines, each truncated to MAX_LINE_LENGTH-5; returns display string */
function limitBody(body: string, maxLines: number): string {
  const lines = body.split("\n");
  const display = lines.slice(0, maxLines).map(l => trunc(l, MAX_LINE_LENGTH - 5)).join("\n");
  return lines.length > maxLines ? display + "\n..." : display;
}

function ListRequests({ args, result }: ToolRendererProps) {
  const filter = (args.httpql_filter as string) ?? "";
  const res = result as Record<string, unknown> | null;
  const rawReqs = res ? res.requests : null;
  const requests = Array.isArray(rawReqs) ? rawReqs as Array<Record<string, unknown>> : [];

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-purple-400/80 font-semibold text-sm">列出请求</span>
        {filter && <span className="text-[#888] text-[13px]">{trunc(filter, 150)}</span>}
      </div>
      {requests.length > 0 && (
        <div className="mt-1.5 font-mono text-[13px] space-y-0.5">
          {requests.slice(0, 20).map((r, i) => {
            const m = ((r.method as string) ?? "GET").toUpperCase();
            const host = (r.host as string) ?? "";
            const path = (r.path as string) ?? "";
            const resp = r.response as Record<string, unknown> | undefined;
            const sc = (resp?.statusCode as number) ?? null;
            return (
              <div key={i} className="flex gap-2">
                <span className={`w-10 shrink-0 font-bold ${METHOD_COLORS[m] ?? "text-[#888]"}`}>{m}</span>
                <span className="text-[#777] truncate">{trunc(host + path, 180)}</span>
                {sc != null && <span className={`ml-auto shrink-0 ${statusColor(sc)}`}>{sc}</span>}
              </div>
            );
          })}
          {requests.length > 20 && <div className="text-[#555]">… 还有 {requests.length - 20} 条</div>}
        </div>
      )}
    </div>
  );
}

function ViewRequest({ args, result }: ToolRendererProps) {
  const requestId = args.request_id as number | undefined;
  const part = PART_LABELS[(args.part as string) ?? "request"] ?? "内容";
  const searchPattern = (args.search_pattern as string) ?? "";
  const res = result as Record<string, unknown> | null;
  const rawMatches = res ? res.matches : null;
  const matches = Array.isArray(rawMatches) ? rawMatches as Array<Record<string, string>> : [];
  const content = res ? (res.content as string) ?? null : null;
  const hasMore = res ? !!(res.has_more) : false;

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-purple-400/80 font-semibold text-sm">{searchPattern ? "搜索" : "查看"} {part}</span>
        {requestId != null && <span className="text-[#888] text-[13px]">#{requestId}</span>}
        {searchPattern && <span className="text-[#666] font-mono text-[13px]">/{trunc(searchPattern, 100)}/</span>}
      </div>
      {matches.length > 0 && (
        <div className="mt-1.5 font-mono text-[13px] space-y-1">
          {matches.slice(0, 5).map((m, i) => {
            // Sanitize context: replace newlines with space, trim to 100 chars
            const before = ((m.before ?? "").replace(/\n/g, " ").replace(/\r/g, "")).slice(-100);
            const after = ((m.after ?? "").replace(/\n/g, " ").replace(/\r/g, "")).slice(0, 100);
            return (
              <div key={i}>
                {before && <span className="text-[#555]">...{before}</span>}
                <span className="text-amber-400/80 font-bold">{m.match}</span>
                {after && <span className="text-[#555]">{after}...</span>}
              </div>
            );
          })}
          {matches.length > 5 && <div className="text-[#555]">… 还有 {matches.length - 5} 个匹配项</div>}
        </div>
      )}
      {content && !matches.length && (() => {
        const lines = content.split("\n");
        const display = lines.slice(0, 15).map(l => trunc(l, MAX_LINE_LENGTH)).join("\n");
        const showMore = hasMore || lines.length > 15;
        return (
          <CodeBlock className="text-[#666]">
            {display + (showMore ? "\n… 还有更多内容" : "")}
          </CodeBlock>
        );
      })()}
    </div>
  );
}

function SendRequest({ args, result }: ToolRendererProps) {
  const method = ((args.method as string) ?? "GET").toUpperCase();
  const url = (args.url as string) ?? "";
  const headers = args.headers as Record<string, string> | undefined;
  const rawBody = args.body;
  const reqBody = typeof rawBody === "string" ? rawBody : "";
  const res = result as Record<string, unknown> | null;
  const error = res ? (res.error as string) ?? null : null;
  const statusCode = res ? (res.status_code as number) ?? null : null;
  const responseTime = res ? (res.response_time_ms as number) ?? null : null;
  const rawResBody = res ? res.body : null;
  const resBody = typeof rawResBody === "string" ? rawResBody : null;

  return (
    <div>
      <span className="text-purple-400/80 font-semibold text-sm">请求</span>
      <div className="mt-1.5 font-mono text-[13px] space-y-0.5">
        <div>
          <span className="text-[#555] select-none mr-1">&gt;&gt;</span>
          <span className={`font-bold ${METHOD_COLORS[method] ?? "text-[#888]"}`}>{method}</span>
          <span className="text-[#888] ml-1 break-all">{trunc(url, 180)}</span>
        </div>
        {headers && typeof headers === "object" && Object.entries(headers).slice(0, 5).map(([k, v]) => (
          <div key={k} className="text-[#555] pl-5">{k}: {sanitize(String(v), 150)}</div>
        ))}
      </div>
      {reqBody && (
        <CodeBlock className="text-[#888]">{limitBody(reqBody, 4)}</CodeBlock>
      )}
      {error && <div className="text-red-400/70 text-[13px] mt-1.5">{sanitize(error, 150)}</div>}
      {statusCode != null && (
        <div className="font-mono text-[13px] mt-1.5">
          <span className="text-[#555] select-none mr-1">&lt;&lt;</span>
          <span className={`font-bold ${statusColor(statusCode)}`}>{statusCode}</span>
          {responseTime != null && <span className="text-[#555] ml-2">{responseTime}ms</span>}
        </div>
      )}
      {resBody && (
        <CodeBlock className="text-[#666]">{limitBody(resBody, 6)}</CodeBlock>
      )}
    </div>
  );
}

function RepeatRequest({ args, result }: ToolRendererProps) {
  const requestId = args.request_id as number | undefined;
  const modifications = args.modifications as Record<string, unknown> | undefined;
  const res = result as Record<string, unknown> | null;
  const statusCode = res ? (res.status_code as number) ?? null : null;
  const responseTime = res ? (res.response_time_ms as number) ?? null : null;
  const rawRepBody = res ? res.body : null;
  const resBody = typeof rawRepBody === "string" ? rawRepBody : null;

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-purple-400/80 font-semibold text-sm">重复请求</span>
        {requestId != null && <span className="text-[#888] text-[13px]">#{requestId}</span>}
      </div>
      {modifications && typeof modifications === "object" && Object.keys(modifications).length > 0 && (
        <div className="mt-1.5 font-mono text-[13px] space-y-0.5">
          {Object.entries(modifications).slice(0, 5).map(([k, v]) => (
            <div key={k}><span className="text-orange-400/60">{k}:</span> <span className="text-[#777]">{sanitize(typeof v === "string" ? v : JSON.stringify(v), 150)}</span></div>
          ))}
        </div>
      )}
      {statusCode != null && (
        <div className="font-mono text-[13px] mt-1.5">
          <span className="text-[#555] select-none mr-1">&lt;&lt;</span>
          <span className={`font-bold ${statusColor(statusCode)}`}>{statusCode}</span>
          {responseTime != null && <span className="text-[#555] ml-2">{responseTime}ms</span>}
        </div>
      )}
      {resBody && (
        <CodeBlock className="text-[#666]">{limitBody(resBody, 5)}</CodeBlock>
      )}
    </div>
  );
}

const SCOPE_ACTION: Record<string, string> = {
  get: "获取", list: "列出", create: "创建", update: "更新", delete: "删除",
};

function ScopeRules({ args }: ToolRendererProps) {
  const action = (args.action as string) ?? "";
  const scopeName = (args.scope_name as string) ?? "";
  const label = SCOPE_ACTION[action] ?? (action ? action : "管理");
  return (
    <div className="flex items-center gap-2">
      <span className="text-purple-400/80 font-semibold text-sm">{label} 代理范围</span>
      {scopeName && <span className="text-[#888] text-[13px]">{trunc(scopeName, 50)}</span>}
    </div>
  );
}

function ListSitemap({ args }: ToolRendererProps) {
  const parentId = args.parent_id as string | undefined;
  return (
    <div className="flex items-center gap-2">
      <span className="text-purple-400/80 font-semibold text-sm">列出站点地图</span>
      {parentId && <span className="text-[#888] text-[13px]">父级 #{trunc(String(parentId), 20)}</span>}
    </div>
  );
}

function ViewSitemapEntry({ args }: ToolRendererProps) {
  const entryId = args.entry_id as string | undefined;
  return (
    <div className="flex items-center gap-2">
      <span className="text-purple-400/80 font-semibold text-sm">查看站点地图条目</span>
      {entryId && <span className="text-[#888] text-[13px]">#{trunc(String(entryId), 20)}</span>}
    </div>
  );
}

export default function ProxyRenderer(props: ToolRendererProps) {
  switch (props.toolName) {
    case "list_requests": return <ListRequests {...props} />;
    case "view_request": return <ViewRequest {...props} />;
    case "send_request": return <SendRequest {...props} />;
    case "repeat_request": return <RepeatRequest {...props} />;
    case "scope_rules": return <ScopeRules {...props} />;
    case "list_sitemap": return <ListSitemap {...props} />;
    case "view_sitemap_entry": return <ViewSitemapEntry {...props} />;
    default:
      return (
        <span className="text-purple-400/80 font-semibold text-sm">{props.toolName.replace(/_/g, " ")}</span>
      );
  }
}
