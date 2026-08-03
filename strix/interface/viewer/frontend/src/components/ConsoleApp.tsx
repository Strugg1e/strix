import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Boxes, Cpu, ShieldCheck, TriangleAlert } from "lucide-react";
import {
  fetchConsoleLog,
  fetchConsoleProjects,
  fetchConsoleRunSnapshot,
  fetchConsoleRuns,
  fetchConsoleStatus,
  type ConsoleProject,
  type ConsoleRuns,
  type ConsoleStatus,
  type RunSnapshot,
} from "@/data/consoleSource";
import { ProfileWorkspace } from "@/components/console/ProfileWorkspace";
import { ProjectWorkspace } from "@/components/console/ProjectWorkspace";
import { TaskWorkspace } from "@/components/console/TaskWorkspace";

const POLL_MS = 1000;
type Section = "projects" | "tasks" | "models";
export interface ConsoleLiveTask {
  snapshot: RunSnapshot | null;
  log: string;
  logOffset: number;
}

export default function ConsoleApp() {
  const [section, setSection] = useState<Section>("projects");
  const [status, setStatus] = useState<ConsoleStatus | null>(null);
  const [runs, setRuns] = useState<ConsoleRuns | null>(null);
  const [projects, setProjects] = useState<ConsoleProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [liveTasks, setLiveTasks] = useState<Record<string, ConsoleLiveTask>>({});
  const [error, setError] = useState<string | null>(null);
  const liveRef = useRef<Record<string, ConsoleLiveTask>>({});

  const refresh = useCallback(async () => {
    const [nextStatus, nextRuns, nextProjects] = await Promise.all([
      fetchConsoleStatus(),
      fetchConsoleRuns(),
      fetchConsoleProjects(),
    ]);
    setStatus(nextStatus);
    setRuns(nextRuns);
    setProjects(nextProjects);
    setSelectedProjectId((current) => {
      if (current && nextProjects.some((project) => project.id === current)) return current;
      return nextProjects[0]?.id ?? "";
    });
  }, []);

  useEffect(() => {
    void refresh().catch((cause) =>
      setError(cause instanceof Error ? cause.message : "无法连接本地控制台")
    );
    const timer = window.setInterval(() => void refresh().catch(() => undefined), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const activeJobs = status?.active_jobs ?? (status?.active_job ? [status.active_job] : []);
  const activeRunKey = activeJobs.map((job) => job.run_name).sort().join("|");
  useEffect(() => {
    if (activeJobs.length === 0) return;
    const cleanups: Array<() => void> = [];
    for (const job of activeJobs) {
      const runName = job.run_name;
      const existing = liveRef.current[runName] ?? { snapshot: null, log: "", logOffset: 0 };
      liveRef.current[runName] = existing;
      let cancelled = false;
      let snapshotTimer: number | undefined;
      let logTimer: number | undefined;
      let snapshotInFlight = false;
      let logInFlight = false;
      let terminal = false;
      const publish = (patch: Partial<ConsoleLiveTask>) => {
        liveRef.current[runName] = { ...liveRef.current[runName], ...patch };
        setLiveTasks({ ...liveRef.current });
      };
      const pullSnapshot = async () => {
        if (cancelled || snapshotInFlight) return;
        snapshotInFlight = true;
        try {
          const next = await fetchConsoleRunSnapshot(runName);
          if (!cancelled) {
            publish({ snapshot: next });
            terminal = next.finished;
          }
        } catch {
          // The run directory can appear just after the process starts.
        } finally {
          snapshotInFlight = false;
          if (!cancelled && !terminal) snapshotTimer = window.setTimeout(pullSnapshot, POLL_MS);
        }
      };
      const pullLog = async () => {
        if (cancelled || logInFlight) return;
        logInFlight = true;
        try {
          const current = liveRef.current[runName] ?? existing;
          const chunk = await fetchConsoleLog(job.id, current.logOffset);
          if (!cancelled) {
            const prefix = chunk.truncated && current.logOffset === 0 ? "[较早日志已截断]\n" : "";
            publish({
              log: `${current.log}${prefix}${chunk.text}`,
              logOffset: chunk.next,
            });
          }
        } catch {
          // The subprocess can exist briefly before its log file is created.
        } finally {
          logInFlight = false;
          if (!cancelled) logTimer = window.setTimeout(pullLog, POLL_MS);
        }
      };
      void pullSnapshot();
      void pullLog();
      cleanups.push(() => {
        cancelled = true;
        if (snapshotTimer !== undefined) window.clearTimeout(snapshotTimer);
        if (logTimer !== undefined) window.clearTimeout(logTimer);
      });
    }
    return () => cleanups.forEach((cleanup) => cleanup());
    // The key changes only when a run is added/removed; each run has its own
    // timers and state, so another run cannot overwrite its snapshot or log.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunKey]);

  const selectProject = (projectId: string, nextSection?: Section) => {
    setSelectedProjectId(projectId);
    if (nextSection) setSection(nextSection);
  };

  return (
    <div lang="zh" className="min-h-screen bg-[#050606] text-[#ededed] antialiased">
      <a
        href="#console-main"
        className="sr-only z-50 rounded-md bg-white px-3 py-2 text-black focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        跳到主要内容
      </a>
      <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-[#050606]">
        <div className="mx-auto flex min-h-16 max-w-[1560px] flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-emerald-300 text-black">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold tracking-[-0.01em]">Strix 工作台</p>
              <p className="truncate font-mono text-[10px] text-[#666]">
                {status?.work_dir ?? "正在读取工作目录"}
              </p>
            </div>
          </div>
          <nav aria-label="控制台导航" className="flex w-full min-w-0 items-center gap-1 rounded-lg bg-white/[0.025] p-1 sm:ml-auto sm:w-auto">
            <NavButton
              active={section === "projects"}
              label="项目"
              icon={<Boxes className="h-3.5 w-3.5" />}
              onClick={() => setSection("projects")}
            />
            <NavButton
              active={section === "tasks"}
              label="任务"
              icon={<Activity className="h-3.5 w-3.5" />}
              badge={status?.running_count ?? status?.active_jobs.length ?? 0}
              onClick={() => setSection("tasks")}
            />
            <NavButton
              active={section === "models"}
              label="LLM"
              icon={<Cpu className="h-3.5 w-3.5" />}
              onClick={() => setSection("models")}
            />
          </nav>
        </div>
      </header>

      <main id="console-main" className="mx-auto min-w-0 max-w-[1560px] px-4 py-5 sm:px-6 sm:py-7">
        {error && (
          <div role="alert" className="mb-5 flex items-start gap-2 rounded-lg bg-red-500/[0.08] px-4 py-3 text-sm text-red-200 ring-1 ring-inset ring-red-500/20">
            <TriangleAlert className="mt-0.5 h-4 w-4 flex-none" />
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="min-h-10 rounded-md px-2 text-xs text-red-300 transition-[background-color,scale] hover:bg-red-500/10 active:scale-95"
            >
              关闭
            </button>
          </div>
        )}

        {section === "projects" && (
          <ProjectWorkspace
            projects={projects}
            profiles={status?.profiles ?? []}
            runs={runs?.runs ?? []}
            activeJobs={activeJobs}
            selectedProjectId={selectedProjectId}
            onSelect={selectProject}
            onChanged={refresh}
            setError={setError}
          />
        )}
        {section === "tasks" && (
          <TaskWorkspace
            projects={projects}
            selectedProjectId={selectedProjectId}
            onSelectProject={(id) => selectProject(id)}
            status={status}
            runs={runs?.runs ?? []}
            activeJobs={activeJobs}
            liveTasks={liveTasks}
            onChanged={refresh}
            setError={setError}
            onCreateProject={() => setSection("projects")}
          />
        )}
        {section === "models" && (
          <ProfileWorkspace
            profiles={status?.profiles ?? []}
            onChanged={refresh}
            setError={setError}
          />
        )}
      </main>
    </div>
  );
}

function NavButton({
  active,
  label,
  icon,
  badge = 0,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex min-h-10 min-w-0 flex-1 items-center justify-center gap-2 rounded-md px-3 text-xs font-semibold transition-[background-color,color,scale] active:scale-95 sm:flex-none ${
        active ? "bg-white/[0.09] text-white" : "text-[#777] hover:bg-white/[0.04] hover:text-[#bbb]"
      }`}
    >
      {icon}
      {label}
      {badge > 0 && (
        <span aria-label={`${badge} 个任务运行中`} className="min-w-5 rounded-full bg-emerald-300 px-1.5 py-0.5 text-[10px] tabular-nums text-black">
          {badge}
        </span>
      )}
    </button>
  );
}
