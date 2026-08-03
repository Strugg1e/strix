import {
  fetchRunSummary,
  fetchReportMarkdown,
  fetchTranscript,
  fetchVulnerabilities,
  type RunListEntry,
} from "@/data/serverSource";

export type AssetKind = "target" | "mount" | "target_list";
export type ScanMode = "quick" | "standard" | "deep";
export type ScopeMode = "auto" | "diff" | "full";
export type ReportLanguage = "zh-CN" | "en";
export type ExecutionStrategy = "auto" | "single" | "batched";

export interface ProjectAsset {
  id: string;
  kind: AssetKind;
  value: string;
  label: string;
  enabled: boolean;
}

export interface ScanDefaults {
  scan_mode: ScanMode;
  scope_mode: ScopeMode;
  report_language: ReportLanguage;
  diff_base: string;
  max_turns: number;
  max_budget_usd: number | null;
  instruction: string;
  instruction_file: string;
  config_path: string;
  profile_id: string;
  model: string;
  use_proxy: boolean;
}

export interface ConsoleProject {
  id: string;
  name: string;
  description: string;
  authorization: string;
  assets: ProjectAsset[];
  defaults: ScanDefaults;
  run_names: string[];
  created_at: string;
  updated_at: string;
}

export interface ConsoleJob {
  id: string;
  run_name: string;
  target: string;
  target_kind: AssetKind | "multiple" | "resume";
  scan_mode: string;
  scope_mode: string;
  max_turns: number;
  max_budget_usd: number | null;
  status: "queued" | "running" | "stopping" | "completed" | "stopped" | "failed";
  started_at: string;
  finished_at: string | null;
  returncode: number | null;
  pid: number | null;
  resumed: boolean;
  profile_id: string;
  model: string;
  profile_name: string;
  targets: Array<Pick<ProjectAsset, "id" | "kind" | "value" | "label">>;
  project_id: string;
  project_name: string;
  use_proxy: boolean;
  report_language?: ReportLanguage;
  error?: string | null;
  execution_strategy?: ExecutionStrategy;
  batch_id?: string | null;
  batch_index?: number | null;
  batch_total?: number | null;
  batch_asset_count?: number | null;
  batch_concurrency?: number | null;
  group_max_budget_usd?: number | null;
}

export interface BatchGroup {
  batch_id: string;
  execution_strategy: ExecutionStrategy;
  batch_size: number;
  concurrency: number;
  total_assets: number;
  total_batches: number;
  max_budget_usd: number | null;
  project_id: string;
  project_name: string;
  status: "queued" | "running" | "completed" | "failed" | "stopped";
  error: string | null;
  running: number;
  queued: number;
  completed: number;
  failed: number;
  stopped: number;
}

export interface LLMProfile {
  id: string;
  name: string;
  model: string;
  api_base: string;
  has_api_key: boolean;
  readonly: boolean;
}

export interface ConsoleStatus {
  active_job: ConsoleJob | null;
  active_jobs: ConsoleJob[];
  running_count: number;
  queued_count: number;
  batch_groups: BatchGroup[];
  profiles: LLMProfile[];
  default_profile_id: string;
  work_dir: string;
  single_run_only: boolean;
}

export type RunSnapshotStatus = ConsoleJob["status"] | "unknown";

export interface RunSnapshotStage {
  key: "preparing" | "exploring" | "validating" | "reporting" | "completed" | "stopping" | "stopped" | "failed";
  label: string;
  detail: string;
  ordinal: number;
  total: number;
}

export interface RunSnapshotAgent {
  id: string;
  name: string;
  status: string;
  parent_id: string | null;
}

export interface RunSnapshotFinding {
  id: string;
  title: string;
  severity: string;
  target: string;
  endpoint: string;
  timestamp: string;
}

export interface RunSnapshotActivity {
  timestamp: string;
  agent_id: string;
  agent: string;
  kind: string;
  tool?: string;
}

export type RunCompletionState = "running" | "completed" | "incomplete" | "unknown";

export interface RunSnapshotTerminationReason {
  kind: string;
  label: string;
  detail: string;
}

export interface RunSnapshotCompletionEvidence {
  finish_scan: boolean;
  finish_scan_calls: number;
}

export interface RunSnapshotErrorCounts {
  max_turns: number;
  read_timeout: number;
  crashed_agents: number;
  failed_agents: number;
}

export interface RunSnapshotArtifacts {
  state: "complete" | "partial" | "missing" | string;
  report_available: boolean;
  vulnerabilities_available: boolean;
  sarif_available: boolean;
  findings_count: number;
}

export interface RunSnapshotConfig {
  scan_mode: string | null;
  scope_mode: string | null;
  max_turns: number | null;
  max_budget_usd: number | null;
  profile_id: string | null;
  profile_name: string | null;
  profile: { id: string | null; name: string | null };
  model: string | null;
  use_proxy: boolean | null;
  report_language: string | null;
}

export interface RunSnapshot {
  run_name: string;
  status: RunSnapshotStatus;
  finished: boolean;
  completion_state: RunCompletionState;
  completion_signal: boolean;
  completion_evidence: RunSnapshotCompletionEvidence;
  termination_reason: RunSnapshotTerminationReason;
  error_counts: RunSnapshotErrorCounts;
  report_available: boolean;
  artifacts: RunSnapshotArtifacts;
  config: RunSnapshotConfig;
  start_time: string | null;
  end_time: string | null;
  started_at: string | null;
  finished_at: string | null;
  elapsed_seconds: number;
  stage: RunSnapshotStage;
  agent_stats: Record<string, number>;
  agents: RunSnapshotAgent[];
  event_count: number;
  last_activity_at: string | null;
  severity_counts: Record<"critical" | "high" | "medium" | "low", number>;
  findings_total: number;
  findings: RunSnapshotFinding[];
  recent_activity: RunSnapshotActivity[];
  result_url: string;
  source?: "legacy";
}

export interface ConsoleRuns {
  locked: boolean;
  count: number;
  runs: RunListEntry[];
}

export interface LaunchPayload extends ScanDefaults {
  project_id: string;
  asset_ids: string[];
  confirmation: string;
  execution_strategy: ExecutionStrategy;
  batch_size: number;
  batch_concurrency: number;
}

export interface ResumePayload {
  profile_id?: string;
  model?: string;
  max_turns?: number;
  max_budget_usd?: number | null;
  instruction?: string;
  use_proxy?: boolean;
  report_language?: ReportLanguage;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    /* handled by the status check below */
  }
  if (!response.ok) {
    throw new Error(String(data.error ?? `请求失败 (${response.status})`));
  }
  return data as T;
}

function post<T>(path: string, body: object = {}): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function fetchConsoleStatus(): Promise<ConsoleStatus> {
  const data = await request<Partial<ConsoleStatus>>("/api/console/status");
  const legacy = data.active_job ?? null;
  const activeJobs = Array.isArray(data.active_jobs)
    ? data.active_jobs
    : legacy
      ? [legacy]
      : [];
  return {
    active_job: legacy ?? activeJobs[0] ?? null,
    active_jobs: activeJobs,
    running_count:
      typeof data.running_count === "number" ? data.running_count : activeJobs.length,
    queued_count: typeof data.queued_count === "number" ? data.queued_count : 0,
    batch_groups: Array.isArray(data.batch_groups) ? data.batch_groups : [],
    profiles: Array.isArray(data.profiles) ? data.profiles : [],
    default_profile_id: data.default_profile_id ?? "environment",
    work_dir: data.work_dir ?? "",
    single_run_only: data.single_run_only === true,
  };
}

export function fetchConsoleRuns(): Promise<ConsoleRuns> {
  return request("/api/console/runs");
}

export async function fetchConsoleRunSnapshot(runName: string): Promise<RunSnapshot> {
  const path = `/api/console/runs/${encodeURIComponent(runName)}/snapshot`;
  const response = await fetch(path, { cache: "no-store" });
  if (response.ok) return (await response.json()) as RunSnapshot;
  if (response.status === 404) return fetchLegacyRunSnapshot(runName);
  let error = `请求失败 (${response.status})`;
  try {
    const data = (await response.json()) as { error?: unknown };
    if (data.error) error = String(data.error);
  } catch {
    /* keep the HTTP status fallback */
  }
  throw new Error(error);
}

async function fetchLegacyRunSnapshot(runName: string): Promise<RunSnapshot> {
  const { summary } = await fetchRunSummary(runName);
  const [transcript, vulnerabilities, reportMarkdown] = await Promise.all([
    fetchTranscript(runName).catch(() => ({ agents: [], events: [] })),
    fetchVulnerabilities(summary.runId, runName).catch(() => []),
    fetchReportMarkdown(runName).catch(() => null),
  ]);
  const status = normalizeSnapshotStatus(summary.status);
  const startTime = summary.startTime;
  const endTime = summary.endTime;
  const startMs = startTime ? new Date(startTime).getTime() : Number.NaN;
  const endMs = endTime ? new Date(endTime).getTime() : Date.now();
  const elapsedSeconds = Number.isNaN(startMs)
    ? 0
    : Math.max(0, Math.floor((endMs - startMs) / 1000));

  const agentStats: Record<string, number> = {
    running: 0,
    waiting: 0,
    completed: 0,
    failed: 0,
    stopped: 0,
    crashed: 0,
    budget_paused: 0,
    other: 0,
    total: transcript.agents.length,
  };
  const agentNames = new Map<string, string>();
  for (const agent of transcript.agents) {
    agentNames.set(agent.id, agent.name);
    const key = Object.hasOwn(agentStats, agent.status) ? agent.status : "other";
    agentStats[key] += 1;
  }

  const recentEvents = transcript.events.slice(-10);
  const recentActivity: RunSnapshotActivity[] = recentEvents.map((event) => {
    const tool = event.type === "tool" ? String(event.data.tool_name ?? "") : "";
    return {
      timestamp: event.timestamp,
      agent_id: event.agent_id,
      agent: agentNames.get(event.agent_id) ?? event.agent_id,
      kind: event.type === "tool" ? "tool_call" : String(event.data.role ?? "message"),
      ...(tool ? { tool } : {}),
    };
  });

  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  const findings: RunSnapshotFinding[] = vulnerabilities.map((finding, index) => {
    const severity = String(finding.severity ?? "low").toLowerCase();
    const key = Object.hasOwn(severityCounts, severity)
      ? (severity as keyof typeof severityCounts)
      : "low";
    severityCounts[key] += 1;
    return {
      id: String(finding.id ?? `finding-${index + 1}`),
      title: String(finding.title ?? "未命名发现"),
      severity,
      target: String(finding.target ?? ""),
      endpoint: String(finding.endpoint ?? ""),
      timestamp: String(finding.created_at ?? ""),
    };
  });

  const finishScanCalls = transcript.events.filter(
    (event) => event.data.tool_name === "finish_scan"
  ).length;
  const finishScan = finishScanCalls > 0;
  const reportAvailable = Boolean(reportMarkdown);
  const completionState: RunCompletionState =
    status === "running" || status === "stopping"
      ? "running"
      : status === "completed" && (finishScan || reportAvailable)
        ? "completed"
        : status === "stopped" || status === "failed"
          ? "incomplete"
          : status === "completed" || status === "unknown"
            ? "unknown"
            : "unknown";
  const completionSignal = completionState === "completed";
  const reportingStarted = finishScan || reportAvailable;
  const stage = legacyStage(status, findings.length, transcript.events.length, reportingStarted);
  const lastActivity = [...recentActivity]
    .reverse()
    .find((item) => item.timestamp)?.timestamp ?? startTime;
  return {
    run_name: runName,
    status,
    finished: completionSignal,
    completion_state: completionState,
    completion_signal: completionSignal,
    completion_evidence: {
      finish_scan: finishScan,
      finish_scan_calls: finishScanCalls,
    },
    termination_reason: legacyTerminationReason(
      completionState,
      completionSignal,
      finishScan,
      reportAvailable,
      status
    ),
    error_counts: {
      max_turns: 0,
      read_timeout: 0,
      crashed_agents: agentStats.crashed ?? 0,
      failed_agents: agentStats.failed ?? 0,
    },
    report_available: reportAvailable,
    artifacts: {
      state: reportAvailable ? "complete" : vulnerabilities.length > 0 ? "partial" : "missing",
      report_available: reportAvailable,
      vulnerabilities_available: vulnerabilities.length > 0,
      sarif_available: false,
      findings_count: findings.length,
    },
    config: {
      scan_mode: summary.scanMode,
      scope_mode: null,
      max_turns: null,
      max_budget_usd: null,
      profile_id: null,
      profile_name: null,
      profile: { id: null, name: null },
      model: null,
      use_proxy: null,
      report_language: null,
    },
    start_time: startTime,
    end_time: endTime,
    started_at: startTime,
    finished_at: endTime,
    elapsed_seconds: elapsedSeconds,
    stage,
    agent_stats: agentStats,
    agents: transcript.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      status: agent.status,
      parent_id: agent.parent_id,
    })),
    event_count: transcript.events.length,
    last_activity_at: lastActivity,
    severity_counts: severityCounts,
    findings_total: findings.length,
    findings: findings.slice(-8).reverse(),
    recent_activity: recentActivity,
    result_url: `/?run=${encodeURIComponent(runName)}`,
    source: "legacy",
  };
}

function legacyTerminationReason(
  completionState: RunCompletionState,
  completionSignal: boolean,
  finishScan: boolean,
  reportAvailable: boolean,
  status: RunSnapshotStatus
): RunSnapshotTerminationReason {
  if (completionState === "running") {
    return { kind: "running", label: "进行中", detail: "Agent 仍在执行扫描" };
  }
  if (completionSignal) {
    return { kind: "completed", label: "已完成", detail: "检测到完成信号与结果产物" };
  }
  const detail = [
    !finishScan ? "未检测到 finish_scan" : "",
    !reportAvailable ? "未生成最终报告" : "",
  ]
    .filter(Boolean)
    .join("；") || "缺少可确认的完成证据";
  if (completionState === "incomplete") {
    return { kind: status, label: "异常未完整完成", detail };
  }
  return { kind: "unknown", label: "状态证据不足", detail };
}

function normalizeSnapshotStatus(status: string | null): RunSnapshotStatus {
  if (["running", "stopping", "completed", "stopped", "failed"].includes(status ?? "")) {
    return status as RunSnapshotStatus;
  }
  return status === "interrupted" ? "stopped" : "unknown";
}

function legacyStage(
  status: RunSnapshotStatus,
  findings: number,
  events: number,
  reportingStarted: boolean
): RunSnapshotStage {
  if (status === "completed") return { key: "completed", label: "已完成", detail: "运行已结束，结果可以查看", ordinal: 5, total: 5 };
  if (status === "failed") return { key: "failed", label: "执行失败", detail: "运行异常结束，请查看日志与已写入结果", ordinal: 5, total: 5 };
  if (status === "stopping") return { key: "stopping", label: "停止中", detail: "正在中断 Agent，已写入的结果会保留", ordinal: 5, total: 5 };
  if (status === "stopped") return { key: "stopped", label: "已停止", detail: "运行已停止，已写入的结果仍然保留", ordinal: 5, total: 5 };
  if (reportingStarted) return { key: "reporting", label: "整理结果", detail: "正在生成最终报告与结果文件", ordinal: 4, total: 5 };
  if (findings > 0) return { key: "validating", label: "验证发现", detail: "已记录发现，Agent 正在确认影响范围", ordinal: 3, total: 5 };
  if (events > 0) return { key: "exploring", label: "探索目标", detail: "Agent 正在执行侦察与测试步骤", ordinal: 2, total: 5 };
  return { key: "preparing", label: "准备环境", detail: "正在建立 Agent 图与运行上下文", ordinal: 1, total: 5 };
}

export async function fetchConsoleProjects(): Promise<ConsoleProject[]> {
  const data = await request<{ projects: ConsoleProject[] }>("/api/console/projects");
  return data.projects;
}

export function saveConsoleProject(payload: {
  id?: string;
  name: string;
  description: string;
  authorization: string;
  assets: ProjectAsset[];
  defaults: ScanDefaults;
}): Promise<ConsoleProject> {
  return post("/api/console/projects", payload);
}

export function deleteConsoleProject(projectId: string): Promise<{ ok: true }> {
  return request(`/api/console/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  });
}

export async function fetchLLMProfiles(): Promise<LLMProfile[]> {
  const data = await request<{ profiles: LLMProfile[] }>("/api/console/profiles");
  return data.profiles;
}

export function saveLLMProfile(payload: {
  id?: string;
  name: string;
  model: string;
  api_base: string;
  api_key: string;
}): Promise<LLMProfile> {
  return post("/api/console/profiles", payload);
}

export function testLLMProfile(
  profileId: string
): Promise<{ ok: boolean; latency_ms: number; message: string }> {
  return post(`/api/console/profiles/${encodeURIComponent(profileId)}/test`);
}

export function deleteLLMProfile(profileId: string): Promise<{ ok: true }> {
  return request(`/api/console/profiles/${encodeURIComponent(profileId)}`, {
    method: "DELETE",
  });
}

export function launchConsoleJob(payload: LaunchPayload): Promise<ConsoleJob> {
  return post("/api/console/jobs", payload);
}

export function stopConsoleJob(jobId: string): Promise<ConsoleJob> {
  return post(`/api/console/jobs/${encodeURIComponent(jobId)}/stop`);
}

export function resumeConsoleRun(
  runName: string,
  payload: ResumePayload = {}
): Promise<ConsoleJob> {
  return post(`/api/console/runs/${encodeURIComponent(runName)}/resume`, payload);
}

export function fetchConsoleLog(
  jobId: string,
  after: number
): Promise<{ text: string; next: number; truncated: boolean }> {
  return request(
    `/api/console/jobs/${encodeURIComponent(jobId)}/log?after=${encodeURIComponent(after)}`
  );
}
