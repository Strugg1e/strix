import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Clock3,
  ExternalLink,
  FileSearch,
  ListChecks,
  Play,
  RotateCcw,
  SlidersHorizontal,
  TerminalSquare,
  TriangleAlert,
} from "lucide-react";
import {
  fetchConsoleRunSnapshot,
  launchConsoleJob,
  resumeConsoleRun,
  stopConsoleJob,
  type ConsoleJob,
  type ConsoleProject,
  type ConsoleStatus,
  type LaunchPayload,
  type ResumePayload,
  type RunSnapshot,
  type RunCompletionState,
  type ScanDefaults,
} from "@/data/consoleSource";
import type { ConsoleLiveTask } from "@/components/ConsoleApp";
import type { RunListEntry } from "@/data/serverSource";
import {
  activeJobsForProject,
  isUnassignedRun,
  projectForRun,
  projectLabelForRun,
  runsForHistoryFilter,
  runsForProject,
  type HistoryFilter,
} from "@/lib/console-aggregation";
import {
  FieldLabel,
  NumberField,
  SelectField,
  TextAreaField,
  TextField,
  assetKindIcon,
  assetKindLabel,
} from "@/components/console/ProjectWorkspace";

function launchDefaults(project: ConsoleProject): LaunchPayload {
  return {
    ...project.defaults,
    report_language: project.defaults.report_language ?? "zh-CN",
    use_proxy: project.defaults.use_proxy === true,
    project_id: project.id,
    asset_ids: project.assets.filter((asset) => asset.enabled).map((asset) => asset.id),
    confirmation: "",
  };
}

type HistorySnapshotState = {
  expanded: boolean;
  loading: boolean;
  snapshot: RunSnapshot | null;
  error: string | null;
};

export function TaskWorkspace({
  projects,
  selectedProjectId,
  onSelectProject,
  status,
  runs,
  activeJobs,
  liveTasks,
  onChanged,
  setError,
  onCreateProject,
}: {
  projects: ConsoleProject[];
  selectedProjectId: string;
  onSelectProject: (projectId: string) => void;
  status: ConsoleStatus | null;
  runs: RunListEntry[];
  activeJobs: ConsoleJob[];
  liveTasks: Record<string, ConsoleLiveTask>;
  onChanged: () => Promise<void>;
  setError: (message: string | null) => void;
  onCreateProject: () => void;
}) {
  const project = projects.find((item) => item.id === selectedProjectId) ?? projects[0];
  const [form, setForm] = useState<LaunchPayload | null>(() =>
    project ? launchDefaults(project) : null
  );
  const [reviewing, setReviewing] = useState(false);
  const [stopConfirmRun, setStopConfirmRun] = useState<string | null>(null);
  const [stopBusyRun, setStopBusyRun] = useState<string | null>(null);
  const [busy, setBusy] = useState<"launch" | "stop" | "resume" | null>(null);
  const [resumeRun, setResumeRun] = useState<RunListEntry | null>(null);
  const [resumeProject, setResumeProject] = useState<ConsoleProject | null>(null);
  const [resumeForm, setResumeForm] = useState<ResumePayload>({});
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [historyDetails, setHistoryDetails] = useState<Record<string, HistorySnapshotState>>({});

  useEffect(() => {
    if (!project) {
      setForm(null);
      setHistoryFilter("all");
      setResumeProject(null);
      setResumeRun(null);
      return;
    }
    setForm(launchDefaults(project));
    setReviewing(false);
    setResumeRun(null);
    setResumeProject(null);
  }, [project?.id, project?.updated_at]);

  const projectJobs = project ? activeJobsForProject(project.id, activeJobs) : [];
  const projectRuns = useMemo(() => {
    if (!project) return [];
    return runsForProject(project, runs);
  }, [project, runs]);
  const historyRuns = useMemo(
    () => runsForHistoryFilter(historyFilter, project, runs),
    [historyFilter, project, runs]
  );

  const stop = async (job: ConsoleJob) => {
    setStopBusyRun(job.id);
    setBusy("stop");
    setError(null);
    try {
      await stopConsoleJob(job.id);
      setStopConfirmRun(null);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "停止任务失败");
    } finally {
      setStopBusyRun(null);
      setBusy(null);
    }
  };

  const openResume = (run: RunListEntry) => {
    const sourceProject = projectForRun(run, projects) ?? null;
    // A missing project_id is legacy/ambiguous data: let the server inherit its
    // persisted run settings instead of silently applying the current project.
    const defaults = !isUnassignedRun(run) ? sourceProject?.defaults : undefined;
    setResumeProject(sourceProject);
    setResumeRun(run);
    setResumeForm(
      defaults
        ? {
            profile_id: defaults.profile_id || "environment",
            model: defaults.model,
            max_turns: defaults.max_turns,
            max_budget_usd: defaults.max_budget_usd,
            instruction: "",
            use_proxy: defaults.use_proxy === true,
          }
        : {}
    );
  };

  const resume = async () => {
    if (!resumeRun) return;
    setBusy("resume");
    setError(null);
    try {
      await resumeConsoleRun(resumeRun.name, resumeForm);
      setResumeRun(null);
      setResumeProject(null);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "继续任务失败");
    } finally {
      setBusy(null);
    }
  };

  const toggleHistoryDetails = async (runName: string) => {
    const current = historyDetails[runName];
    if (current?.loading) return;
    if (current?.expanded) {
      setHistoryDetails((previous) => ({
        ...previous,
        [runName]: { ...current, expanded: false },
      }));
      return;
    }
    setHistoryDetails((previous) => ({
      ...previous,
      [runName]: {
        expanded: true,
        loading: true,
        snapshot: current?.snapshot ?? null,
        error: null,
      },
    }));
    try {
      const snapshot = await fetchConsoleRunSnapshot(runName);
      setHistoryDetails((previous) => ({
        ...previous,
        [runName]: { expanded: true, loading: false, snapshot, error: null },
      }));
    } catch (cause) {
      setHistoryDetails((previous) => ({
        ...previous,
        [runName]: {
          expanded: true,
          loading: false,
          snapshot: current?.snapshot ?? null,
          error: cause instanceof Error ? cause.message : "无法读取任务详情",
        },
      }));
    }
  };

  if (!project || !form) {
    return (
      <div className="min-w-0 space-y-5">
        <GlobalTaskSummary activeJobs={activeJobs} runningCount={status?.running_count ?? activeJobs.length} />
        <ActiveTaskList
          jobs={activeJobs}
          liveTasks={liveTasks}
          stopConfirmRun={stopConfirmRun}
          setStopConfirmRun={setStopConfirmRun}
          stopBusyRun={stopBusyRun}
          onStop={stop}
        />
        <div className="rounded-xl bg-white/[0.018] px-5 py-16 text-center ring-1 ring-inset ring-white/[0.07]">
          <ListChecks className="mx-auto h-7 w-7 text-[#555]" />
          <h1 className="mt-4 text-base font-semibold">还没有可扫描的项目</h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#666]">
            先保存授权说明和资产范围。任务启动时只能从项目内选择资产。
          </p>
          <button type="button" onClick={onCreateProject} className="mt-5 min-h-10 rounded-md bg-white px-4 text-xs font-bold text-black transition-[background-color,scale] hover:bg-[#ddd] active:scale-95">
            创建第一个项目
          </button>
        </div>
        <RunHistory
          runs={historyRuns}
          allRuns={runs}
          projects={projects}
          currentProject={project}
          historyFilter={historyFilter}
          onHistoryFilter={setHistoryFilter}
          activeJobs={activeJobs}
          disabled={busy !== null}
          resumeRun={resumeRun}
          resumeProject={resumeProject}
          resumeForm={resumeForm}
          profiles={status?.profiles ?? []}
          onOpenResume={openResume}
          onCancelResume={() => {
            setResumeRun(null);
            setResumeProject(null);
          }}
          onResumeForm={setResumeForm}
          onResume={resume}
          busy={busy}
          historyDetails={historyDetails}
          onToggleDetails={toggleHistoryDetails}
        />
      </div>
    );
  }

  const patch = (values: Partial<LaunchPayload>) => {
    setForm((current) => (current ? { ...current, ...values } : current));
    setReviewing(false);
  };

  const launch = async () => {
    setBusy("launch");
    setError(null);
    try {
      await launchConsoleJob(form);
      setReviewing(false);
      patch({ confirmation: "" });
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "启动任务失败");
    } finally {
      setBusy(null);
    }
  };

  const selectedAssets = new Set(form.asset_ids);
  const canReview = form.asset_ids.length > 0 && busy === null;
  const confirmed = form.confirmation.trim() === project.name;

  return (
    <div className="min-w-0 space-y-5">
      <GlobalTaskSummary activeJobs={activeJobs} runningCount={status?.running_count ?? activeJobs.length} />
      <ActiveTaskList
        jobs={activeJobs}
        liveTasks={liveTasks}
        stopConfirmRun={stopConfirmRun}
        setStopConfirmRun={setStopConfirmRun}
        stopBusyRun={stopBusyRun}
        onStop={stop}
      />
      <section className="overflow-hidden rounded-xl bg-white/[0.018] ring-1 ring-inset ring-white/[0.08]">
        <div className="flex flex-col gap-4 border-b border-white/[0.07] px-5 py-5 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-400">Scan project</p>
            <h1 className="mt-1 text-xl font-semibold tracking-[-0.012em]">{project.name}</h1>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-[#666]">
              {project.description || project.authorization}
            </p>
          </div>
          <SelectProject
            projects={projects}
            value={project.id}
            onChange={onSelectProject}
          />
        </div>

        <div className="grid gap-px bg-white/[0.06] sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="可选资产" value={String(project.assets.length)} />
          <Metric label="项目历史任务" value={String(projectRuns.length)} />
          <Metric label="项目运行中" value={String(projectJobs.length)} />
          <Metric label="默认模式" value={project.defaults.scan_mode} />
          <Metric label="LLM 配置" value={profileName(status, project.defaults.profile_id)} />
        </div>
      </section>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-w-0 overflow-hidden rounded-xl bg-white/[0.018] ring-1 ring-inset ring-white/[0.08]">
          <div className="flex items-start gap-3 border-b border-white/[0.07] px-5 py-4">
            <SlidersHorizontal className="mt-0.5 h-4 w-4 text-[#777]" />
            <div>
              <h2 className="text-sm font-semibold">启动新任务</h2>
              <p className="mt-1 text-xs leading-5 text-[#626262]">
                所有设置直接映射到 Strix CLI，本次修改不会覆盖项目默认值。
              </p>
            </div>
          </div>

          <fieldset disabled={busy !== null} className="space-y-6 p-5 disabled:opacity-45">
            <div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">选择资产</h3>
                  <p className="mt-1 text-xs text-[#5f5f5f]">支持源码、线上应用和目标清单联合扫描。</p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    patch({
                      asset_ids:
                        form.asset_ids.length === project.assets.length
                          ? []
                          : project.assets.map((asset) => asset.id),
                    })
                  }
                  className="min-h-10 rounded-md px-3 text-xs text-emerald-300 transition-[background-color,scale] hover:bg-emerald-500/[0.06] active:scale-95"
                >
                  {form.asset_ids.length === project.assets.length ? "取消全选" : "选择全部"}
                </button>
              </div>
              <div className="mt-3 grid gap-2 lg:grid-cols-2">
                {project.assets.map((asset) => {
                  const Icon = assetKindIcon(asset.kind);
                  const checked = selectedAssets.has(asset.id);
                  return (
                    <label
                      key={asset.id}
                      className={`flex min-h-16 cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 ring-1 ring-inset transition-[background-color,box-shadow] ${
                        checked
                          ? "bg-emerald-400/[0.055] ring-emerald-400/25"
                          : "bg-black/25 ring-white/[0.06] hover:bg-white/[0.025]"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          patch({
                            asset_ids: checked
                              ? form.asset_ids.filter((id) => id !== asset.id)
                              : [...form.asset_ids, asset.id],
                          })
                        }
                        className="h-4 w-4 accent-emerald-300"
                      />
                      <Icon className="h-4 w-4 flex-none text-[#777]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold text-[#ddd]">
                          {asset.label || asset.value}
                        </span>
                        <span className="mt-1 block truncate font-mono text-[10px] text-[#555]">
                          {assetKindLabel(asset.kind)} · {asset.value}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {form.asset_ids.length === 0 && (
                <p role="alert" className="mt-2 text-xs text-amber-300">至少选择一个项目资产。</p>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <SelectField
                label="扫描模式"
                value={form.scan_mode}
                options={[
                  ["quick", "Quick"],
                  ["standard", "Standard"],
                  ["deep", "Deep"],
                ]}
                onChange={(scan_mode) => patch({ scan_mode: scan_mode as LaunchPayload["scan_mode"] })}
              />
              <SelectField
                label="代码范围"
                value={form.scope_mode}
                options={[
                  ["auto", "Auto"],
                  ["diff", "Diff"],
                  ["full", "Full"],
                ]}
                onChange={(scope_mode) => patch({ scope_mode: scope_mode as LaunchPayload["scope_mode"] })}
              />
              <SelectField
                label="报告语言"
                value={form.report_language}
                options={[
                  ["zh-CN", "简体中文"],
                  ["en", "English"],
                ]}
                onChange={(report_language) =>
                  patch({ report_language: report_language as LaunchPayload["report_language"] })
                }
              />
              <NumberField
                label="最大轮次"
                value={form.max_turns}
                min={1}
                max={500}
                onChange={(max_turns) => patch({ max_turns: max_turns ?? 40 })}
              />
              <NumberField
                label="最大预算 USD"
                value={form.max_budget_usd}
                min={0.01}
                step={0.01}
                optional
                onChange={(max_budget_usd) => patch({ max_budget_usd })}
              />
              <SelectField
                label="代理策略"
                value={form.use_proxy ? "true" : "false"}
                options={[
                  ["false", "直连（推荐）"],
                  ["true", "使用终端代理"],
                ]}
                onChange={(use_proxy) => patch({ use_proxy: use_proxy === "true" })}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                label="LLM 配置"
                value={form.profile_id}
                options={(status?.profiles ?? []).map((profile) => [profile.id, profile.name])}
                onChange={(profile_id) => {
                  const profile = status?.profiles.find((item) => item.id === profile_id);
                  patch({ profile_id, model: profile?.model ?? "" });
                }}
              />
              <TextField
                label="模型覆盖"
                value={form.model}
                placeholder="留空使用配置档模型"
                mono
                onChange={(model) => patch({ model })}
              />
              <TextField
                label="Diff Base"
                value={form.diff_base}
                placeholder="origin/main"
                mono
                onChange={(diff_base) => patch({ diff_base })}
              />
              <TextField
                label="CLI 配置文件"
                value={form.config_path}
                placeholder="/path/to/cli-config.json"
                mono
                onChange={(config_path) => patch({ config_path })}
              />
            </div>

            <TextAreaField
              label="补充指令"
              value={form.instruction}
              placeholder="本次任务的测试重点、账号、限制或特殊说明。"
              rows={3}
              onChange={(instruction) =>
                patch({ instruction, instruction_file: instruction ? "" : form.instruction_file })
              }
            />
            <TextField
              label="指令文件"
              value={form.instruction_file}
              placeholder="/path/to/instructions.md，与补充指令二选一"
              mono
              onChange={(instruction_file) =>
                patch({ instruction_file, instruction: instruction_file ? "" : form.instruction })
              }
            />

            {!reviewing ? (
              <button
                type="button"
                disabled={!canReview}
                onClick={() => setReviewing(true)}
                className="flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-white text-sm font-bold text-black transition-[background-color,scale] hover:bg-[#ddd] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-30"
              >
                检查范围并确认授权 <ChevronRight className="h-4 w-4" />
              </button>
            ) : (
              <div className="rounded-lg bg-amber-400/[0.055] p-4 ring-1 ring-inset ring-amber-400/25">
                <div className="flex items-start gap-3">
                  <TriangleAlert className="mt-0.5 h-4 w-4 flex-none text-amber-300" />
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-amber-100">启动前授权确认</h3>
                    <p className="mt-1 text-xs leading-5 text-[#aaa]">
                      即将对 {form.asset_ids.length} 个项目资产执行主动安全测试。请输入项目名称确认范围。
                    </p>
                    <code className="mt-3 block rounded-md bg-black/50 px-3 py-2 text-xs text-amber-100">
                      {project.name}
                    </code>
                    <input
                      autoFocus
                      value={form.confirmation}
                      onChange={(event) =>
                        setForm((current) =>
                          current ? { ...current, confirmation: event.target.value } : current
                        )
                      }
                      placeholder="输入项目名称"
                      className="mt-3 h-10 w-full rounded-md bg-[#0b0d0d] px-3 text-sm text-white ring-1 ring-inset ring-white/[0.11] placeholder:text-[#444] focus-visible:ring-amber-300/70"
                    />
                    <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                      <button
                        type="button"
                        onClick={() => setReviewing(false)}
                        className="min-h-10 rounded-md px-4 text-xs font-semibold text-[#aaa] transition-[background-color,scale] hover:bg-white/[0.04] active:scale-95"
                      >
                        返回修改
                      </button>
                      <button
                        type="button"
                        disabled={!confirmed || busy === "launch"}
                        onClick={launch}
                        className="flex min-h-10 items-center justify-center gap-2 rounded-md bg-amber-300 px-4 text-xs font-bold text-black transition-[background-color,scale] hover:bg-amber-200 active:scale-95 disabled:opacity-30"
                      >
                        <Play className="h-3.5 w-3.5 fill-current" />
                        {busy === "launch" ? "正在启动" : "确认授权并启动"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </fieldset>
        </section>

        <RunHistory
          runs={historyRuns}
          allRuns={runs}
          projects={projects}
          currentProject={project}
          historyFilter={historyFilter}
          onHistoryFilter={setHistoryFilter}
          activeJobs={activeJobs}
          disabled={busy !== null}
          resumeRun={resumeRun}
          resumeProject={resumeProject}
          resumeForm={resumeForm}
          profiles={status?.profiles ?? []}
          onOpenResume={openResume}
          onCancelResume={() => {
            setResumeRun(null);
            setResumeProject(null);
          }}
          onResumeForm={setResumeForm}
          onResume={resume}
          busy={busy}
          historyDetails={historyDetails}
          onToggleDetails={toggleHistoryDetails}
        />
      </div>
    </div>
  );
}

function GlobalTaskSummary({
  activeJobs,
  runningCount,
}: {
  activeJobs: ConsoleJob[];
  runningCount: number;
}) {
  const projectCount = new Set(activeJobs.map((job) => job.project_id).filter(Boolean)).size;
  return (
    <section className="grid gap-px overflow-hidden rounded-xl bg-white/[0.07] ring-1 ring-inset ring-white/[0.08] sm:grid-cols-3">
      <Metric label="运行中" value={formatCount(runningCount)} />
      <Metric label="并行项目" value={formatCount(projectCount)} />
      <Metric label="活动任务" value={formatCount(activeJobs.length)} />
    </section>
  );
}

function ActiveTaskList({
  jobs,
  liveTasks,
  stopConfirmRun,
  setStopConfirmRun,
  stopBusyRun,
  onStop,
}: {
  jobs: ConsoleJob[];
  liveTasks: Record<string, ConsoleLiveTask>;
  stopConfirmRun: string | null;
  setStopConfirmRun: (runName: string | null) => void;
  stopBusyRun: string | null;
  onStop: (job: ConsoleJob) => void;
}) {
  return (
    <section className="overflow-hidden rounded-xl bg-white/[0.018] ring-1 ring-inset ring-white/[0.08]">
      <div className="flex items-center gap-2 border-b border-white/[0.07] px-5 py-4">
        <Activity className="h-4 w-4 text-emerald-300" />
        <h2 className="text-sm font-semibold">并行活动任务</h2>
        <span className="ml-auto text-[11px] tabular-nums text-[#666]">{jobs.length}</span>
      </div>
      {jobs.length === 0 ? (
        <p className="px-5 py-6 text-xs text-[#666]">当前没有运行中的任务。</p>
      ) : (
        <div className="grid gap-3 p-3 lg:grid-cols-2">
          {jobs.map((job) => {
            const live = liveTasks[job.run_name];
            const active = job.status === "running" || job.status === "stopping";
            return (
              <ActiveJob
                key={job.id}
                job={job}
                active={active}
                snapshot={live?.snapshot ?? null}
                log={live?.log ?? ""}
                stopConfirm={stopConfirmRun === job.id}
                setStopConfirm={(value) => setStopConfirmRun(value ? job.id : null)}
                busy={stopBusyRun === job.id ? "stop" : null}
                onStop={() => onStop(job)}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function ActiveJob({
  job,
  active,
  snapshot,
  log,
  stopConfirm,
  setStopConfirm,
  busy,
  onStop,
}: {
  job: ConsoleJob;
  active: boolean;
  snapshot: RunSnapshot | null;
  log: string;
  stopConfirm: boolean;
  setStopConfirm: (value: boolean) => void;
  busy: string | null;
  onStop: () => void;
}) {
  const state = statusLabel(job.status);
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);
  return (
    <section className="overflow-hidden rounded-xl bg-white/[0.022] ring-1 ring-inset ring-white/[0.09]">
      <div className="flex flex-col gap-3 border-b border-white/[0.07] px-5 py-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {active && <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-300" />}
            <h2 className="truncate text-sm font-semibold">{job.project_name || job.target}</h2>
            <span className={`rounded px-2 py-1 text-[10px] font-semibold ${state.style}`}>{state.label}</span>
          </div>
          <p className="mt-1 flex flex-wrap gap-x-2 font-mono text-[10px] text-[#5f5f5f]">
            <span>{job.run_name}</span><span>·</span><span>{job.profile_name}</span><span>{job.model}</span>
          </p>
        </div>
        <a
          href={`/?run=${encodeURIComponent(job.run_name)}`}
          target="_blank"
          rel="noreferrer"
          className="flex min-h-10 items-center justify-center gap-2 rounded-md bg-emerald-400/[0.08] px-3 text-xs font-semibold text-emerald-300 ring-1 ring-inset ring-emerald-400/20 transition-[background-color,scale] hover:bg-emerald-400/[0.12] active:scale-95"
        >
          {active ? "Agent 实时视图与干预" : "查看结果"} <ArrowUpRight className="h-3.5 w-3.5" />
        </a>
      </div>
      <div className="space-y-4 p-5">
        {snapshot ? <RunProgress snapshot={snapshot} /> : <SnapshotLoading />}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <ProgressMetric label="运行耗时" value={snapshot ? formatDuration(snapshot.elapsed_seconds) : "读取中"} />
          <ProgressMetric label="Agent" value={snapshot ? `${snapshot.agent_stats.total ?? 0} 个` : "读取中"} />
          <ProgressMetric label="事件" value={snapshot ? formatCount(snapshot.event_count) : "读取中"} />
          <ProgressMetric label="发现" value={snapshot ? formatCount(snapshot.findings_total) : "读取中"} />
          <ProgressMetric label="最近活动" value={snapshot?.last_activity_at ? formatTimestamp(snapshot.last_activity_at) : "暂无"} />
        </div>
        {snapshot && <SnapshotDetails snapshot={snapshot} />}
        <details className="overflow-hidden rounded-lg bg-black/35 ring-1 ring-inset ring-white/[0.07]">
          <summary className="flex min-h-10 cursor-pointer items-center gap-2 px-3 text-xs font-semibold text-[#aaa] hover:text-white">
            <TerminalSquare className="h-3.5 w-3.5 text-[#777]" /> 查看原始日志
          </summary>
          <pre
            ref={logRef}
            className="scrollbar-thin h-[260px] overflow-auto border-t border-white/[0.07] bg-black/45 p-4 font-mono text-[11px] leading-5 text-[#a7b0aa]"
          >
            {log || "等待 Strix 输出日志…"}
          </pre>
        </details>
        <div className="grid gap-4 border-t border-white/[0.07] pt-4 sm:grid-cols-2 lg:grid-cols-6">
          <JobFact label="扫描模式" value={job.scan_mode} />
          <JobFact label="资产数量" value={String(job.targets.length || 1)} />
          <JobFact label="最大轮次" value={String(job.max_turns)} />
          <JobFact label="预算" value={job.max_budget_usd ? `$${job.max_budget_usd}` : "不限制"} />
          <JobFact label="代理策略" value={job.use_proxy ? "使用终端代理" : "直连（推荐）"} />
          <JobFact
            label="报告语言"
            value={
              job.report_language === "en"
                ? "English"
                : job.report_language === "zh-CN"
                  ? "简体中文"
                  : "未记录"
            }
          />
          <JobFact
            label="报告状态"
            value={snapshot?.stage.key === "completed" ? "已生成" : "待生成"}
          />
        </div>
        {active && (
          <div className="border-t border-white/[0.07] pt-4">
            {!stopConfirm ? (
              <button
                type="button"
                onClick={() => setStopConfirm(true)}
                className="flex min-h-10 w-full items-center justify-center gap-2 rounded-md text-xs font-semibold text-red-300 ring-1 ring-inset ring-red-500/25 transition-[background-color,scale] hover:bg-red-500/[0.07] active:scale-95"
              >
                <CircleStop className="h-3.5 w-3.5" /> 停止任务
              </button>
            ) : (
              <div className="space-y-2 rounded-md bg-red-500/[0.06] p-3 ring-1 ring-inset ring-red-500/20">
                <p className="text-[11px] leading-5 text-red-200">中断 Agent，已写入结果会保留。</p>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setStopConfirm(false)} className="min-h-10 rounded-md text-xs text-[#aaa] active:scale-95">取消</button>
                  <button type="button" disabled={busy === "stop"} onClick={onStop} className="min-h-10 rounded-md bg-red-400 text-xs font-bold text-black active:scale-95 disabled:opacity-40">确认</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

const STAGE_STEPS = [
  ["preparing", "准备"],
  ["exploring", "探索"],
  ["validating", "验证"],
  ["reporting", "整理"],
  ["completed", "结束"],
] as const;

function RunProgress({ snapshot }: { snapshot: RunSnapshot }) {
  const current = snapshot.stage.ordinal;
  return (
    <div className="rounded-lg bg-black/25 p-4 ring-1 ring-inset ring-white/[0.07]">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-300">当前阶段</p>
          <h3 className="mt-1 text-sm font-semibold text-white">{snapshot.stage.label}</h3>
          <p className="mt-1 break-words text-xs leading-5 text-[#777]">{snapshot.stage.detail}</p>
        </div>
        <span className="flex-none text-[10px] tabular-nums text-[#666]">里程碑 {snapshot.stage.ordinal}/{snapshot.stage.total}</span>
      </div>
      <div className="mt-4 grid grid-cols-5 gap-1.5" aria-label="任务阶段">
        {STAGE_STEPS.map(([key, label], index) => {
          const ordinal = index + 1;
          const reached = ordinal < current || snapshot.stage.key === "completed";
          const active = ordinal === current && !reached;
          return (
            <div key={key} className="min-w-0">
              <div className={`h-1 rounded-full ${reached ? "bg-emerald-300" : active ? "bg-amber-300" : "bg-white/[0.1]"}`} />
              <p className={`mt-1 truncate text-[10px] ${active ? "font-semibold text-amber-200" : reached ? "text-emerald-300" : "text-[#555]"}`}>{label}</p>
            </div>
          );
        })}
      </div>
      {(snapshot.stage.key === "stopping" || snapshot.stage.key === "stopped" || snapshot.stage.key === "failed") && (
        <p className="mt-3 text-[11px] text-amber-200">{snapshot.stage.detail}</p>
      )}
    </div>
  );
}

function SnapshotLoading() {
  return (
    <div className="flex min-h-24 items-center justify-center rounded-lg bg-black/25 px-4 text-center text-xs text-[#777] ring-1 ring-inset ring-white/[0.07]">
      正在读取运行快照，首次启动可能需要片刻…
    </div>
  );
}

function SnapshotDetails({ snapshot }: { snapshot: RunSnapshot }) {
  const stats = snapshot.agent_stats;
  const severities = [
    ["critical", "严重", "text-red-300"],
    ["high", "高危", "text-orange-300"],
    ["medium", "中危", "text-amber-200"],
    ["low", "低危", "text-sky-300"],
  ] as const;
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-2">
      <div className="min-w-0 rounded-lg bg-black/25 p-4 ring-1 ring-inset ring-white/[0.07]">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold">Agent 状态</h3>
          <span className="text-[10px] tabular-nums text-[#666]">共 {stats.total ?? 0} 个</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <StatusCount label="运行中" value={stats.running ?? 0} color="text-emerald-300" />
          <StatusCount label="等待" value={stats.waiting ?? 0} color="text-amber-200" />
          <StatusCount label="已完成" value={stats.completed ?? 0} color="text-sky-300" />
          <StatusCount label="失败" value={(stats.failed ?? 0) + (stats.crashed ?? 0)} color="text-red-300" />
          <StatusCount label="已停止" value={stats.stopped ?? 0} color="text-[#aaa]" />
          <StatusCount label="预算暂停" value={stats.budget_paused ?? 0} color="text-violet-300" />
        </div>
        <div className="mt-4 border-t border-white/[0.06] pt-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#555]">最近活动</p>
          {snapshot.recent_activity.length === 0 ? (
            <p className="mt-2 text-xs text-[#666]">暂无可展示的 Agent 事件</p>
          ) : (
            <div className="mt-2 space-y-2">
              {snapshot.recent_activity.slice(-3).reverse().map((item, index) => (
                <div key={`${item.timestamp}-${item.agent_id}-${index}`} className="flex min-w-0 items-center gap-2 text-[11px]">
                  <Activity className="h-3 w-3 flex-none text-emerald-300" />
                  <span className="min-w-0 flex-1 truncate text-[#aaa]">{item.agent}{item.tool ? ` · ${item.tool}` : ` · ${item.kind}`}</span>
                  <span className="flex-none font-mono text-[10px] text-[#555]">{formatTimestamp(item.timestamp)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="min-w-0 rounded-lg bg-black/25 p-4 ring-1 ring-inset ring-white/[0.07]">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold">扫描结果</h3>
          <span className="text-[10px] tabular-nums text-[#666]">共 {formatCount(snapshot.findings_total)} 个发现</span>
        </div>
        <div className="mt-3 grid grid-cols-4 gap-1.5">
          {severities.map(([key, label, color]) => (
            <div key={key} className="min-w-0 rounded-md bg-white/[0.035] px-2 py-2">
              <p className={`text-[10px] ${color}`}>{label}</p>
              <p className="mt-1 text-base font-semibold tabular-nums text-white">{snapshot.severity_counts[key] ?? 0}</p>
            </div>
          ))}
        </div>
        {snapshot.findings.length === 0 ? (
          <p className="mt-4 text-xs leading-5 text-[#666]">尚未写入发现。运行中结果会在文件落盘后自动显示。</p>
        ) : (
          <div className="mt-3 space-y-2">
            {snapshot.findings.slice(0, 4).map((finding) => (
              <div key={finding.id} className="min-w-0 rounded-md bg-black/25 px-3 py-2">
                <div className="flex min-w-0 items-start gap-2">
                  <span className={`mt-0.5 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${severityStyle(finding.severity)}`}>{finding.severity}</span>
                  <p className="min-w-0 flex-1 break-words text-[11px] font-semibold text-[#ddd]">{finding.title}</p>
                </div>
                {(finding.target || finding.endpoint) && <p className="mt-1 break-all pl-12 text-[10px] text-[#666]">{finding.target || finding.endpoint}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusCount({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-md bg-white/[0.035] px-2 py-2">
      <p className="text-[10px] text-[#666]">{label}</p>
      <p className={`mt-1 text-base font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

function ProgressMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-black/25 px-3 py-2.5 ring-1 ring-inset ring-white/[0.05]">
      <p className="truncate text-[10px] uppercase tracking-[0.1em] text-[#555]">{label}</p>
      <p className="mt-1 truncate text-xs font-semibold tabular-nums text-[#ccc]">{value}</p>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = value % 60;
  return hours > 0 ? `${hours}小时 ${minutes}分` : `${minutes}分 ${rest}秒`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(Math.max(0, value));
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function severityStyle(severity: string): string {
  if (severity === "critical") return "bg-red-500/15 text-red-300";
  if (severity === "high") return "bg-orange-500/15 text-orange-300";
  if (severity === "medium") return "bg-amber-500/15 text-amber-200";
  return "bg-sky-500/15 text-sky-300";
}

function RunHistory({
  runs,
  allRuns,
  projects,
  currentProject,
  historyFilter,
  onHistoryFilter,
  activeJobs,
  disabled,
  resumeRun,
  resumeProject,
  resumeForm,
  profiles,
  onOpenResume,
  onCancelResume,
  onResumeForm,
  onResume,
  busy,
  historyDetails,
  onToggleDetails,
}: {
  runs: RunListEntry[];
  allRuns: RunListEntry[];
  projects: ConsoleProject[];
  currentProject: ConsoleProject | undefined;
  historyFilter: HistoryFilter;
  onHistoryFilter: (filter: HistoryFilter) => void;
  activeJobs: ConsoleJob[];
  disabled: boolean;
  resumeRun: RunListEntry | null;
  resumeProject: ConsoleProject | null;
  resumeForm: ResumePayload;
  profiles: NonNullable<ConsoleStatus>["profiles"];
  onOpenResume: (run: RunListEntry) => void;
  onCancelResume: () => void;
  onResumeForm: (form: ResumePayload) => void;
  onResume: () => void;
  busy: string | null;
  historyDetails: Record<string, HistorySnapshotState>;
  onToggleDetails: (runName: string) => Promise<void>;
}) {
  const activeNames = new Set(activeJobs.map((job) => job.run_name));
  const projectRuns = runsForHistoryFilter("project", currentProject, allRuns);
  const unassignedRuns = runsForHistoryFilter("unassigned", currentProject, allRuns);
  const filters: Array<{ key: HistoryFilter; label: string; count: number }> = [
    { key: "all", label: "全部任务", count: allRuns.length },
    { key: "project", label: "当前项目", count: projectRuns.length },
    { key: "unassigned", label: "未分配", count: unassignedRuns.length },
  ];
  return (
    <aside className="h-fit overflow-hidden rounded-xl bg-white/[0.018] ring-1 ring-inset ring-white/[0.08] xl:sticky xl:top-[84px]">
      <div className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-4">
        <Clock3 className="h-4 w-4 text-[#777]" />
        <h2 className="text-sm font-semibold">历史任务</h2>
        <span className="ml-auto text-[11px] tabular-nums text-[#555]">{runs.length}</span>
      </div>
      {resumeRun ? (
        <div className="space-y-4 p-4">
          <div>
            <p className="text-xs font-semibold">继续 {resumeRun.name}</p>
            <p className="mt-1 text-[11px] leading-5 text-[#626262]">恢复完整 Agent 历史，并可覆盖模型、预算和新指令。</p>
            {(!resumeProject || isUnassignedRun(resumeRun)) && (
              <p className="mt-2 rounded-md bg-amber-400/[0.06] px-3 py-2 text-[11px] leading-5 text-amber-200 ring-1 ring-inset ring-amber-400/20">
                该任务缺少直接项目关联，将沿用任务已保存的配置；项目归属不会被改变。缺失配置时由后端使用安全默认值。
              </p>
            )}
          </div>
          <SelectField
            label="LLM 配置"
            value={resumeForm.profile_id ?? "environment"}
            options={profiles.map((profile) => [profile.id, profile.name])}
            onChange={(profile_id) => {
              const profile = profiles.find((item) => item.id === profile_id);
              onResumeForm({ ...resumeForm, profile_id, model: profile?.model ?? "" });
            }}
          />
          <TextField label="模型覆盖" value={resumeForm.model ?? ""} mono onChange={(model) => onResumeForm({ ...resumeForm, model })} />
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="最大轮次" value={resumeForm.max_turns ?? 40} min={1} max={500} onChange={(max_turns) => onResumeForm({ ...resumeForm, max_turns: max_turns ?? 40 })} />
            <NumberField label="预算 USD" value={resumeForm.max_budget_usd ?? null} min={0.01} step={0.01} optional onChange={(max_budget_usd) => onResumeForm({ ...resumeForm, max_budget_usd })} />
          </div>
          <SelectField
            label="报告语言"
            value={resumeForm.report_language ?? ""}
            options={[
              ["", "沿用原任务（推荐）"],
              ["zh-CN", "简体中文"],
              ["en", "English"],
            ]}
            onChange={(report_language) =>
              onResumeForm({
                ...resumeForm,
                report_language: report_language
                  ? (report_language as ResumePayload["report_language"])
                  : undefined,
              })
            }
          />
          <TextAreaField label="新的补充指令" value={resumeForm.instruction ?? ""} rows={3} onChange={(instruction) => onResumeForm({ ...resumeForm, instruction })} />
          <SelectField
            label="代理策略"
            value={resumeForm.use_proxy === true ? "true" : "false"}
            options={[
              ["false", "直连（推荐）"],
              ["true", "使用终端代理"],
            ]}
            onChange={(use_proxy) => onResumeForm({ ...resumeForm, use_proxy: use_proxy === "true" })}
          />
          <p className="-mt-2 text-[10px] leading-4 text-[#5f5f5f]">
            恢复时按此策略执行，可覆盖该任务保存的代理策略。
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={onCancelResume} className="min-h-10 rounded-md text-xs text-[#aaa] ring-1 ring-inset ring-white/[0.09] active:scale-95">取消</button>
            <button type="button" disabled={disabled || busy === "resume"} onClick={onResume} className="min-h-10 rounded-md bg-white text-xs font-bold text-black active:scale-95 disabled:opacity-35">{busy === "resume" ? "恢复中" : "确认继续"}</button>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-1 border-b border-white/[0.07] p-2">
            {filters.map((filter) => (
              <button
                key={filter.key}
                type="button"
                onClick={() => onHistoryFilter(filter.key)}
                className={`flex min-h-10 min-w-0 items-center justify-center gap-1 rounded-md px-1.5 text-[10px] font-semibold transition-[background-color,color,scale] active:scale-95 ${
                  historyFilter === filter.key
                    ? "bg-white/[0.09] text-white"
                    : "text-[#777] hover:bg-white/[0.04] hover:text-[#bbb]"
                }`}
              >
                <span className="truncate">{filter.label}</span>
                <span className="flex-none font-mono tabular-nums text-[9px] text-[#666]">{filter.count}</span>
              </button>
            ))}
          </div>
          <div className="scrollbar-thin max-h-[720px] overflow-y-auto p-2">
          {runs.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <FileSearch className="mx-auto h-5 w-5 text-[#4f4f4f]" />
              <p className="mt-3 text-xs text-[#606060]">
                {historyFilter === "all"
                  ? "还没有历史任务记录"
                  : historyFilter === "project"
                    ? "当前项目还没有任务记录"
                    : "没有未分配任务"}
              </p>
            </div>
          ) : (
            runs.map((run) => {
              const findings = Object.values(run.severity_counts).reduce((sum, value) => sum + value, 0);
              const current = activeNames.has(run.name);
              const sourceLabel = projectLabelForRun(run, projects);
              const detail = historyDetails[run.name];
              const completionState = historyCompletionState(run, detail?.snapshot ?? null);
              return (
                <div key={run.name} className={`rounded-lg px-3 py-3 ${current ? "bg-white/[0.07]" : "hover:bg-white/[0.035]"}`}>
                  <div className="flex items-start gap-2">
                    <HistoryStateIcon
                      state={completionState}
                      error={run.status === "failed" || (detail?.snapshot?.error_counts.read_timeout ?? 0) > 0}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-[#ddd]" title={run.target ?? run.name}>{run.target || run.name}</p>
                      <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-[#555]">
                        <span>{run.scan_mode ?? "unknown"}</span><span>·</span><span>{findings} 个发现</span>
                        <span>{historyStateLabel(completionState)}</span>
                        {(historyFilter === "all" || historyFilter === "unassigned") && (
                          <span className="max-w-full truncate rounded bg-white/[0.06] px-1.5 py-0.5 text-[#888]" title={sourceLabel}>
                            {sourceLabel}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 pl-[22px]">
                    <button
                      type="button"
                      onClick={() => void onToggleDetails(run.name)}
                      aria-expanded={detail?.expanded ?? false}
                      className="flex min-h-10 items-center gap-1 rounded-md px-2 text-[10px] text-[#888] ring-1 ring-inset ring-white/[0.08] transition-[background-color,color,scale] hover:bg-white/[0.04] hover:text-white active:scale-95"
                    >
                      详情 <ChevronDown className={`h-3 w-3 transition-transform ${detail?.expanded ? "rotate-180" : ""}`} />
                    </button>
                    {detail?.expanded && <RunHistoryDetails state={detail} />}
                  </div>
                  <div className="mt-2 flex gap-1.5 pl-[22px]">
                    <a href={`/?run=${encodeURIComponent(run.name)}`} target="_blank" rel="noreferrer" className="flex min-h-10 items-center gap-1 rounded-md px-2 text-[10px] text-[#888] ring-1 ring-inset ring-white/[0.08] hover:text-white active:scale-95">{completionState === "completed" ? "查看已写入结果" : "查看 Agent 轨迹"} <ExternalLink className="h-3 w-3" /></a>
                    {!current && completionState !== "completed" && !(run.status === "running" && run.managed !== true) && (
                      <button type="button" disabled={disabled} onClick={() => onOpenResume(run)} className="flex min-h-10 items-center gap-1 rounded-md px-2 text-[10px] text-[#888] ring-1 ring-inset ring-white/[0.08] hover:text-white active:scale-95 disabled:opacity-30"><RotateCcw className="h-3 w-3" /> 继续</button>
                    )}
                  </div>
                </div>
              );
            })
          )}
          </div>
        </>
      )}
    </aside>
  );
}

function historyCompletionState(run: RunListEntry, snapshot: RunSnapshot | null): RunCompletionState {
  if (snapshot) return snapshot.completion_state;
  if (run.status === "completed") return run.report_available === true ? "completed" : "unknown";
  if (run.status === "running" || run.status === "stopping") return "running";
  if (run.status === "stopped" || run.status === "failed") return "incomplete";
  return "unknown";
}

function historyStateLabel(state: RunCompletionState): string {
  if (state === "completed") return "已完成";
  if (state === "incomplete") return "未完整完成";
  if (state === "running") return "进行中";
  return "证据不足";
}

function HistoryStateIcon({ state, error = false }: { state: RunCompletionState; error?: boolean }) {
  if (state === "completed") {
    return <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-none text-emerald-400" aria-hidden="true" />;
  }
  if (state === "incomplete") {
    return <TriangleAlert className={`mt-0.5 h-3.5 w-3.5 flex-none ${error ? "text-red-300" : "text-amber-300"}`} aria-hidden="true" />;
  }
  return <Activity className="mt-0.5 h-3.5 w-3.5 flex-none text-sky-300" aria-hidden="true" />;
}

function RunHistoryDetails({ state }: { state: HistorySnapshotState }) {
  if (state.loading && !state.snapshot) {
    return <p className="mt-2 rounded-md bg-black/25 px-3 py-3 text-[10px] text-[#777]">正在读取 Agent 轨迹…</p>;
  }
  if (state.error && !state.snapshot) {
    return <p className="mt-2 rounded-md bg-red-500/[0.06] px-3 py-3 text-[10px] leading-5 text-red-200">详情读取失败：{state.error}</p>;
  }
  const snapshot = state.snapshot;
  if (!snapshot) {
    return <p className="mt-2 rounded-md bg-black/25 px-3 py-3 text-[10px] text-[#777]">暂无可用详情。</p>;
  }

  const conclusion =
    snapshot.completion_state === "completed" && snapshot.findings_total === 0
      ? "已完成，0 个已验证发现"
      : historyStateLabel(snapshot.completion_state);
  const conclusionStyle =
    snapshot.completion_state === "completed"
      ? "border-emerald-400/20 bg-emerald-400/[0.07] text-emerald-200"
      : snapshot.completion_state === "incomplete"
        ? "border-amber-400/20 bg-amber-400/[0.07] text-amber-100"
        : snapshot.completion_state === "running"
          ? "border-sky-400/20 bg-sky-400/[0.07] text-sky-100"
          : "border-white/[0.12] bg-white/[0.04] text-[#ccc]";
  const errors = snapshot.error_counts;
  const config = snapshot.config;
  const toolCalls = snapshot.recent_activity.filter((item) => item.kind === "tool_call").length;
  return (
    <div className="mt-2 min-w-0 space-y-2 rounded-md bg-black/25 p-3 ring-1 ring-inset ring-white/[0.07]">
      <div className={`rounded-md border px-3 py-2 ${conclusionStyle}`}>
        <p className="text-[11px] font-semibold">{conclusion}</p>
        <p className="mt-1 break-words text-[10px] leading-5 opacity-80">{snapshot.termination_reason.detail}</p>
      </div>
      {state.error && <p className="break-words text-[10px] text-amber-200">详情刷新提示：{state.error}</p>}
      <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3">
        <HistoryFact label="运行时长" value={formatDuration(snapshot.elapsed_seconds)} />
        <HistoryFact label="最后活动" value={snapshot.last_activity_at ? formatTimestamp(snapshot.last_activity_at) : "暂无"} />
        <HistoryFact label="Agent" value={`${formatCount(snapshot.agent_stats.total ?? 0)} 个`} />
        <HistoryFact label="事件" value={formatCount(snapshot.event_count)} />
        <HistoryFact label="最近工具调用" value={formatCount(toolCalls)} />
        <HistoryFact label="发现" value={formatCount(snapshot.findings_total)} />
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 border-t border-white/[0.06] pt-2 text-[10px]">
        <HistoryFact label="最大轮次异常" value={formatCount(errors.max_turns)} />
        <HistoryFact label="请求超时" value={formatCount(errors.read_timeout)} />
        <HistoryFact label="崩溃 Agent" value={formatCount(errors.crashed_agents)} />
        <HistoryFact label="finish_scan" value={snapshot.completion_evidence.finish_scan ? "已检测" : "未检测"} />
        <HistoryFact label="报告产物" value={snapshot.report_available ? "已生成" : "不可用"} />
        <HistoryFact label="任务状态" value={snapshot.status} />
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 border-t border-white/[0.06] pt-2 text-[10px]">
        <HistoryFact label="LLM 配置" value={config.profile_name || config.profile_id || "未记录"} breakAll />
        <HistoryFact label="模型" value={config.model || "未记录"} breakAll />
        <HistoryFact label="最大轮次" value={config.max_turns == null ? "未记录" : String(config.max_turns)} />
        <HistoryFact label="预算" value={config.max_budget_usd == null ? "不限制/未记录" : `$${config.max_budget_usd}`} />
        <HistoryFact label="代理" value={config.use_proxy == null ? "未记录" : config.use_proxy ? "使用代理" : "直连"} />
        <HistoryFact label="报告语言" value={config.report_language || "未记录"} />
        <HistoryFact label="原始任务" value={snapshot.run_name} breakAll />
      </div>
    </div>
  );
}

function HistoryFact({ label, value, breakAll = false }: { label: string; value: string; breakAll?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[#555]">{label}</p>
      <p className={`mt-0.5 min-w-0 text-[#bbb] ${breakAll ? "break-all" : "truncate"}`} title={value}>{value}</p>
    </div>
  );
}

function SelectProject({ projects, value, onChange }: { projects: ConsoleProject[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="w-full sm:w-64">
      <FieldLabel>当前项目</FieldLabel>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 h-10 w-full rounded-md bg-[#0b0d0d] px-3 text-xs text-[#ddd] ring-1 ring-inset ring-white/[0.09] focus-visible:ring-emerald-400/60">
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="bg-[#090b0b] px-5 py-3"><p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#535353]">{label}</p><p className="mt-1 truncate text-xs font-semibold text-[#bbb]">{value}</p></div>;
}

function JobFact({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[10px] uppercase tracking-[0.12em] text-[#515151]">{label}</p><p className="mt-1 truncate text-xs font-medium text-[#bbb]">{value}</p></div>;
}

function profileName(status: ConsoleStatus | null, profileId: string): string {
  return status?.profiles.find((profile) => profile.id === profileId)?.name ?? "当前环境";
}

function statusLabel(status: ConsoleJob["status"]): { label: string; style: string } {
  if (status === "running") return { label: "运行中", style: "bg-emerald-500/[0.09] text-emerald-300" };
  if (status === "stopping") return { label: "停止中", style: "bg-amber-500/[0.09] text-amber-200" };
  if (status === "completed") return { label: "已完成", style: "bg-emerald-500/[0.09] text-emerald-300" };
  if (status === "failed") return { label: "失败", style: "bg-red-500/[0.09] text-red-300" };
  return { label: "已停止", style: "bg-white/[0.06] text-[#aaa]" };
}
