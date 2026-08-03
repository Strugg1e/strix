import { useState } from "react";
import { History, ChevronRight, Terminal } from "lucide-react";
import type { RunListEntry, RunsPayload, RunSeverityCounts } from "@/data/serverSource";
import { runTitle } from "@/lib/target-utils";
import { trackCta } from "@/lib/cta";
import EmailVerifyInline from "@/components/EmailVerifyInline";
import { formatDate as formatLocaleDate, formatRelativeTime, severityLabel, statusLabel } from "@/lib/locale";

/**
 * "Past runs" panel. Unverified users see a tease with the run count and a
 * verify affordance (the launched run stays fully visible; the CLI
 * `strix view <name>` still works). Verified users get the full history and can
 * switch the active run, which threads ?run=<name> through the data fetches.
 */

const SEV = [
  { key: "critical", dot: "bg-red-500", text: "text-red-500" },
  { key: "high", dot: "bg-orange-500", text: "text-orange-500" },
  { key: "medium", dot: "bg-yellow-500", text: "text-yellow-500" },
  { key: "low", dot: "bg-blue-500", text: "text-blue-500" },
] as const;

function SeverityChips({ counts }: { counts: RunSeverityCounts }) {
  const shown = SEV.filter((s) => counts[s.key] > 0);
  if (shown.length === 0) {
    return <span className="text-xs text-[#555]">无漏洞</span>;
  }
  return (
    <div className="flex items-center gap-3">
      {shown.map((s) => (
        <div key={s.key} className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${s.dot}`} aria-hidden="true" />
          <span className={`text-xs tabular-nums ${s.text}`}>{counts[s.key]}</span>
          <span className="text-xs text-[#555]">{severityLabel(s.key)}</span>
        </div>
      ))}
    </div>
  );
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const normalized = iso.trim().replace(" UTC", "Z").replace(" ", "T");
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return null;
  return formatLocaleDate(d);
}

/**
 * Relative time ("just now" / "5m ago" / "3h ago" / "2d ago"), falling back to
 * the absolute date for anything older than a week (mirrors the pro app).
 */
function formatTimeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const normalized = iso.trim().replace(" UTC", "Z").replace(" ", "T");
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return null;
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  return formatRelativeTime(d);
}

interface PastRunsViewProps {
  runs: RunsPayload | null;
  activeRun: string | null;
  onSelectRun: (name: string) => void;
  onVerified: () => void;
}

export default function PastRunsView({
  runs,
  activeRun,
  onSelectRun,
  onVerified,
}: PastRunsViewProps) {
  const count = runs?.count ?? 0;
  const [showVerify, setShowVerify] = useState(false);

  if (!runs || runs.locked) {
    return (
      <div className="rounded-xl border border-[#222] bg-[rgba(255,255,255,0.02)] p-8 text-center">
        <div
          className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl"
          style={{ border: "1px solid #2a2a2a", background: "rgba(255,255,255,0.04)" }}
        >
          <History className="h-5 w-5 text-[#888]" aria-hidden="true" />
        </div>
        <h2 className="text-base font-semibold text-white">浏览本机上的所有任务</h2>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-[#888]">
          本机共有 {count} 个历史任务。
        </p>
        {showVerify ? (
          <>
            <p className="mx-auto mt-3 max-w-sm text-xs text-[#666]">
              使用一次性验证码验证邮箱后即可解锁完整历史记录。
            </p>
            <EmailVerifyInline onVerified={onVerified} />
          </>
        ) : (
          <button
            onClick={() => {
              trackCta("history_unlock", "past_runs");
              setShowVerify(true);
            }}
            className="mt-4 cursor-pointer rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90"
          >
            查看任务
          </button>
        )}
        <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-[#555]">
          <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
          也可以使用 CLI 打开：{" "}
          <code className="font-mono text-[#888]">strix view &lt;name&gt;</code>
        </p>
      </div>
    );
  }

  if (runs.runs.length === 0) {
    return (
      <div className="rounded-xl border border-[#222] bg-[rgba(255,255,255,0.02)] p-8 text-center text-sm text-[#888]">
        本机暂未找到历史任务。
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {runs.runs.map((run: RunListEntry) => {
        const active = run.name === activeRun;
        const date = formatTimeAgo(run.start_time) ?? formatTimeAgo(run.end_time);
        const title = runTitle(run.target, run.name);
        return (
          <button
            key={run.name}
            onClick={() => onSelectRun(run.name)}
            className={`animate-card-in group flex w-full cursor-pointer items-center gap-4 rounded-lg border px-4 py-3 text-left transition-colors ${
              active
                ? "border-[#444] bg-[rgba(255,255,255,0.04)]"
                : "border-[#222] bg-[rgba(255,255,255,0.02)] hover:border-[#444]"
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-white">{title}</span>
                {active && (
                  <span className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-400" style={{ border: "1px solid rgba(16,185,129,0.3)" }}>
                    当前
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[#666]">
                {run.scan_mode && <span>{run.scan_mode === "quick" ? "快速" : run.scan_mode === "standard" ? "标准" : run.scan_mode === "deep" ? "深度" : "未知"}</span>}
                {run.scan_mode && (date || run.status) && <span className="text-[#333]">·</span>}
                {date && <span>{date}</span>}
                {date && run.status && <span className="text-[#333]">·</span>}
                {run.status && <span>{statusLabel(run.status)}</span>}
              </div>
            </div>
            <SeverityChips counts={run.severity_counts} />
            <ChevronRight className="h-4 w-4 flex-shrink-0 text-[#555] transition-colors group-hover:text-[#aaa]" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
