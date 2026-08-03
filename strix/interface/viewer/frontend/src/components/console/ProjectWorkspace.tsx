import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  FileCode2,
  FileInput,
  FolderOpen,
  Globe2,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import {
  deleteConsoleProject,
  saveConsoleProject,
  type AssetKind,
  type ConsoleProject,
  type ConsoleJob,
  type LLMProfile,
  type ProjectAsset,
  type ScanDefaults,
} from "@/data/consoleSource";
import type { RunListEntry } from "@/data/serverSource";
import {
  BULK_ASSET_MAX_COUNT,
  parseBulkAssets,
  type BulkAssetImportResult,
} from "./bulkAssetImport";
import { activeJobsForProject, runsForProject } from "@/lib/console-aggregation";

type ProjectDraft = {
  id?: string;
  name: string;
  description: string;
  authorization: string;
  assets: ProjectAsset[];
  defaults: ScanDefaults;
};

const EMPTY_DEFAULTS: ScanDefaults = {
  scan_mode: "quick",
  scope_mode: "auto",
  report_language: "zh-CN",
  diff_base: "",
  max_turns: 40,
  max_budget_usd: null,
  instruction: "",
  instruction_file: "",
  config_path: "",
  profile_id: "environment",
  model: "",
  use_proxy: false,
};

function newAsset(kind: AssetKind = "target"): ProjectAsset {
  return {
    id: `asset_${crypto.randomUUID().replaceAll("-", "")}`,
    kind,
    value: "",
    label: "",
    enabled: true,
  };
}

function blankProject(profileId = "environment"): ProjectDraft {
  return {
    name: "",
    description: "",
    authorization: "",
    assets: [newAsset()],
    defaults: { ...EMPTY_DEFAULTS, profile_id: profileId },
  };
}

function editProject(project: ConsoleProject): ProjectDraft {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    authorization: project.authorization,
    assets: project.assets.map((asset) => ({ ...asset })),
    defaults: {
      ...project.defaults,
      report_language: project.defaults.report_language ?? "zh-CN",
      use_proxy: project.defaults.use_proxy === true,
    },
  };
}

export function ProjectWorkspace({
  projects,
  profiles,
  selectedProjectId,
  runs,
  activeJobs,
  onSelect,
  onChanged,
  setError,
}: {
  projects: ConsoleProject[];
  profiles: LLMProfile[];
  selectedProjectId: string;
  runs: RunListEntry[];
  activeJobs: ConsoleJob[];
  onSelect: (projectId: string, section?: "projects" | "tasks" | "models") => void;
  onChanged: () => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const selected = projects.find((project) => project.id === selectedProjectId);
  const runCounts = (project: ConsoleProject) => {
    const projectRuns = runsForProject(project, runs);
    const running = activeJobsForProject(project.id, activeJobs).length;
    return { running, history: projectRuns.length };
  };
  const [draft, setDraft] = useState<ProjectDraft>(() =>
    selected ? editProject(selected) : blankProject()
  );
  const [creating, setCreating] = useState(projects.length === 0);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [fieldError, setFieldError] = useState("");
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [bulkImportText, setBulkImportText] = useState("");

  const bulkImportResult = useMemo(
    () => parseBulkAssets(bulkImportText, draft.assets),
    [bulkImportText, draft.assets]
  );
  const replacesBlankAsset =
    draft.assets.length === 1 &&
    draft.assets[0].value.trim() === "" &&
    draft.assets[0].label.trim() === "";
  const bulkImportAssetCount =
    bulkImportResult.assets.length + (replacesBlankAsset ? 0 : draft.assets.length);
  const bulkImportCapacityError =
    bulkImportAssetCount > BULK_ASSET_MAX_COUNT
      ? `项目最多支持 ${BULK_ASSET_MAX_COUNT} 个资产，本次导入后将有 ${bulkImportAssetCount} 个。`
      : "";

  useEffect(() => {
    if (!selected || creating) return;
    setDraft(editProject(selected));
    setDeleteConfirm(false);
    setFieldError("");
    setBulkImportOpen(false);
    setBulkImportText("");
  }, [selected?.id, selected?.updated_at, creating]);

  const dirty = useMemo(() => {
    if (!selected || creating) return true;
    return JSON.stringify(draft) !== JSON.stringify(editProject(selected));
  }, [draft, selected, creating]);

  const createNew = () => {
    setCreating(true);
    setDraft(blankProject(profiles[0]?.id ?? "environment"));
    setDeleteConfirm(false);
    setFieldError("");
    setBulkImportOpen(false);
    setBulkImportText("");
  };

  const save = async () => {
    if (!draft.name.trim()) {
      setFieldError("请输入项目名称");
      return;
    }
    if (!draft.authorization.trim()) {
      setFieldError("请记录授权来源、允许的测试类型或有效期");
      return;
    }
    if (!draft.assets.length || draft.assets.some((asset) => !asset.value.trim())) {
      setFieldError("每个资产都必须填写目标或本地路径");
      return;
    }
    setBusy("save");
    setError(null);
    setFieldError("");
    try {
      const saved = await saveConsoleProject({
        ...draft,
        assets: draft.assets.map((asset) => ({
          ...asset,
          label: asset.label.trim(),
          value: asset.value.trim(),
        })),
      });
      await onChanged();
      setCreating(false);
      onSelect(saved.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存项目失败");
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!draft.id) return;
    setBusy("delete");
    setError(null);
    try {
      await deleteConsoleProject(draft.id);
      await onChanged();
      setCreating(projects.length <= 1);
      setDraft(blankProject(profiles[0]?.id ?? "environment"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除项目失败");
    } finally {
      setBusy(null);
    }
  };

  const patchDefaults = (patch: Partial<ScanDefaults>) => {
    setDraft((current) => ({
      ...current,
      defaults: { ...current.defaults, ...patch },
    }));
  };

  const patchAsset = (assetId: string, patch: Partial<ProjectAsset>) => {
    setDraft((current) => ({
      ...current,
      assets: current.assets.map((asset) =>
        asset.id === assetId ? { ...asset, ...patch } : asset
      ),
    }));
  };

  const confirmBulkImport = () => {
    if (!bulkImportResult.assets.length || bulkImportCapacityError) return;
    const importedAssets: ProjectAsset[] = bulkImportResult.assets.map((asset) => ({
      id: `asset_${crypto.randomUUID().replaceAll("-", "")}`,
      kind: asset.kind,
      value: asset.value,
      label: asset.label,
      enabled: asset.enabled,
    }));
    setDraft((current) => {
      const hasOnlyBlankPlaceholder =
        current.assets.length === 1 &&
        current.assets[0].value.trim() === "" &&
        current.assets[0].label.trim() === "";
      return {
        ...current,
        assets: hasOnlyBlankPlaceholder
          ? importedAssets
          : [...current.assets, ...importedAssets],
      };
    });
    setBulkImportOpen(false);
    setBulkImportText("");
  };

  const cancelBulkImport = () => {
    setBulkImportOpen(false);
    setBulkImportText("");
  };

  return (
    <div className="grid min-w-0 gap-5 lg:grid-cols-[286px_minmax(0,1fr)]">
      <aside className="h-fit min-w-0 overflow-hidden rounded-xl bg-white/[0.018] ring-1 ring-inset ring-white/[0.07] lg:sticky lg:top-[84px]">
        <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-semibold">项目与授权范围</h1>
            <p className="mt-1 text-[11px] text-[#666]">{projects.length} 个项目</p>
          </div>
          <button
            type="button"
            onClick={createNew}
            className="flex min-h-10 items-center gap-1.5 rounded-md bg-white/[0.07] px-3 text-xs font-semibold text-[#ccc] transition-[background-color,scale] hover:bg-white/[0.11] active:scale-95"
          >
            <Plus className="h-3.5 w-3.5" /> 新建
          </button>
        </div>
        <div className="space-y-1 p-2">
          {projects.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <ShieldCheck className="mx-auto h-5 w-5 text-[#555]" />
              <p className="mt-3 text-xs text-[#777]">先建立授权范围，再启动扫描。</p>
            </div>
          ) : (
            projects.map((project) => (
              <button
                type="button"
                key={project.id}
                onClick={() => {
                  setCreating(false);
                  onSelect(project.id);
                }}
                className={`w-full rounded-lg px-3 py-3 text-left transition-[background-color,scale] active:scale-[0.98] ${
                  !creating && selected?.id === project.id
                    ? "bg-white/[0.08]"
                    : "hover:bg-white/[0.04]"
                }`}
              >
                <span className="block truncate text-xs font-semibold text-[#ddd]">
                  {project.name}
                </span>
                <span className="mt-1.5 flex gap-2 text-[10px] text-[#5f5f5f]">
                  <span>{project.assets.length} 个资产</span>
                  <span>·</span>
                  <span>{runCounts(project).running} 运行中</span>
                  <span>·</span>
                  <span>{runCounts(project).history} 次历史任务</span>
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className="min-w-0 overflow-hidden rounded-xl bg-white/[0.018] ring-1 ring-inset ring-white/[0.08]">
        <div className="flex flex-col gap-4 border-b border-white/[0.07] px-5 py-5 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-400">
              {creating ? "New project" : "Authorized scope"}
            </p>
            <h2 className="mt-1 text-xl font-semibold tracking-[-0.012em]">
              {creating ? "建立一个 SRC 项目" : draft.name || "未命名项目"}
            </h2>
            <p className="mt-1 text-xs leading-5 text-[#666]">
              资产范围由服务端保存，任务只能选择这里登记的目标。
            </p>
          </div>
          {!creating && draft.id && (
            <button
              type="button"
              onClick={() => onSelect(draft.id!, "tasks")}
              className="flex min-h-10 items-center justify-center gap-2 rounded-md bg-emerald-300 px-4 text-xs font-bold text-black transition-[background-color,scale] hover:bg-emerald-200 active:scale-95"
            >
              发起任务 <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {!creating && selected && (
          <div className="grid gap-px border-b border-white/[0.07] bg-white/[0.06] sm:grid-cols-3">
            <ProjectMetric label="全局运行中" value={String(activeJobs.length)} />
            <ProjectMetric label="当前项目运行中" value={String(runCounts(selected).running)} />
            <ProjectMetric label="当前项目历史" value={String(runCounts(selected).history)} />
          </div>
        )}

        <div className="space-y-7 p-5">
          <FormSection title="项目资料" description="用于识别授权上下文，不会写入模型密钥。">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="项目名称"
                value={draft.name}
                placeholder="例如：2026 夏季 SRC"
                required
                onChange={(name) => setDraft((current) => ({ ...current, name }))}
              />
              <TextField
                label="项目说明"
                value={draft.description}
                placeholder="业务背景、负责人或测试窗口"
                onChange={(description) => setDraft((current) => ({ ...current, description }))}
              />
            </div>
            <TextAreaField
              label="授权说明"
              value={draft.authorization}
              placeholder="记录授权来源、允许的测试类型、时间窗口和禁止操作。"
              required
              rows={3}
              onChange={(authorization) =>
                setDraft((current) => ({ ...current, authorization }))
              }
            />
          </FormSection>

          <FormSection
            title="资产范围"
            description="普通目标使用 --target，本地大仓库使用只读 --mount，清单文件使用 --target-list。"
            action={
              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      assets: [...current.assets, newAsset()],
                    }))
                  }
                  className="flex min-h-10 items-center gap-1.5 rounded-md px-3 text-xs font-semibold text-emerald-300 transition-[background-color,scale] hover:bg-emerald-500/[0.06] active:scale-95"
                >
                  <Plus className="h-3.5 w-3.5" /> 添加资产
                </button>
                <button
                  type="button"
                  aria-expanded={bulkImportOpen}
                  onClick={() => {
                    if (bulkImportOpen) {
                      cancelBulkImport();
                    } else {
                      setBulkImportOpen(true);
                    }
                  }}
                  className="flex min-h-10 items-center gap-1.5 rounded-md px-3 text-xs font-semibold text-[#aaa] transition-[background-color,scale] hover:bg-white/[0.06] active:scale-95"
                >
                  <Upload className="h-3.5 w-3.5" />
                  {bulkImportOpen ? "收起批量导入" : "批量导入"}
                </button>
              </div>
            }
          >
            <div className="space-y-2">
              {draft.assets.map((asset, index) => (
                <AssetRow
                  key={asset.id}
                  asset={asset}
                  index={index}
                  canRemove={draft.assets.length > 1}
                  onChange={(patch) => patchAsset(asset.id, patch)}
                  onRemove={() =>
                    setDraft((current) => ({
                      ...current,
                      assets: current.assets.filter((item) => item.id !== asset.id),
                    }))
                  }
                />
              ))}
            </div>
            {bulkImportOpen && (
              <BulkAssetImportPanel
                value={bulkImportText}
                result={bulkImportResult}
                capacityError={bulkImportCapacityError}
                onChange={setBulkImportText}
                onConfirm={confirmBulkImport}
                onCancel={cancelBulkImport}
              />
            )}
          </FormSection>

          <FormSection title="默认任务配置" description="每次发起任务时仍可覆盖这些默认值。">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <SelectField
                label="扫描模式"
                value={draft.defaults.scan_mode}
                options={[
                  ["quick", "Quick"],
                  ["standard", "Standard"],
                  ["deep", "Deep"],
                ]}
                onChange={(scan_mode) =>
                  patchDefaults({ scan_mode: scan_mode as ScanDefaults["scan_mode"] })
                }
              />
              <SelectField
                label="代码范围"
                value={draft.defaults.scope_mode}
                options={[
                  ["auto", "Auto"],
                  ["diff", "Diff"],
                  ["full", "Full"],
                ]}
                onChange={(scope_mode) =>
                  patchDefaults({ scope_mode: scope_mode as ScanDefaults["scope_mode"] })
                }
              />
              <SelectField
                label="报告语言"
                value={draft.defaults.report_language}
                options={[
                  ["zh-CN", "简体中文"],
                  ["en", "English"],
                ]}
                onChange={(report_language) =>
                  patchDefaults({ report_language: report_language as ScanDefaults["report_language"] })
                }
              />
              <NumberField
                label="每个 Agent 最大轮次"
                value={draft.defaults.max_turns}
                min={1}
                max={500}
                onChange={(max_turns) => patchDefaults({ max_turns: max_turns ?? 40 })}
              />
              <NumberField
                label="最大预算 USD"
                value={draft.defaults.max_budget_usd}
                min={0.01}
                step={0.01}
                optional
                onChange={(max_budget_usd) => patchDefaults({ max_budget_usd })}
              />
              <SelectField
                label="代理策略"
                value={draft.defaults.use_proxy ? "true" : "false"}
                options={[
                  ["false", "直连（推荐）"],
                  ["true", "使用终端代理"],
                ]}
                onChange={(use_proxy) => patchDefaults({ use_proxy: use_proxy === "true" })}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Diff Base"
                value={draft.defaults.diff_base}
                placeholder="origin/main"
                mono
                onChange={(diff_base) => patchDefaults({ diff_base })}
              />
              <TextField
                label="CLI 配置文件"
                value={draft.defaults.config_path}
                placeholder="/path/to/cli-config.json"
                mono
                onChange={(config_path) => patchDefaults({ config_path })}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                label="LLM 配置"
                value={draft.defaults.profile_id}
                options={profiles.map((profile) => [profile.id, profile.name])}
                onChange={(profile_id) => {
                  const profile = profiles.find((item) => item.id === profile_id);
                  patchDefaults({ profile_id, model: profile?.model ?? "" });
                }}
              />
              <TextField
                label="模型覆盖"
                value={draft.defaults.model}
                placeholder="留空使用配置档默认模型"
                mono
                onChange={(model) => patchDefaults({ model })}
              />
            </div>
            <TextAreaField
              label="补充指令"
              value={draft.defaults.instruction}
              placeholder="例如：重点验证租户越权，不进行拒绝服务测试。"
              rows={3}
              onChange={(instruction) =>
                patchDefaults({ instruction, instruction_file: instruction ? "" : draft.defaults.instruction_file })
              }
            />
            <TextField
              label="指令文件"
              value={draft.defaults.instruction_file}
              placeholder="/path/to/instructions.md，与补充指令二选一"
              mono
              onChange={(instruction_file) =>
                patchDefaults({
                  instruction_file,
                  instruction: instruction_file ? "" : draft.defaults.instruction,
                })
              }
            />
          </FormSection>

          {fieldError && (
            <p role="alert" className="rounded-md bg-amber-500/[0.08] px-3 py-2.5 text-xs text-amber-200 ring-1 ring-inset ring-amber-500/20">
              {fieldError}
            </p>
          )}

          <div className="flex flex-col gap-3 border-t border-white/[0.07] pt-5 sm:flex-row sm:items-center">
            <button
              type="button"
              disabled={!dirty || busy !== null}
              onClick={save}
              className="flex min-h-10 items-center justify-center gap-2 rounded-md bg-white px-5 text-xs font-bold text-black transition-[background-color,scale] hover:bg-[#ddd] active:scale-95 disabled:cursor-not-allowed disabled:opacity-35"
            >
              {busy === "save" ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
              {busy === "save" ? "正在保存" : "保存项目"}
            </button>
            {draft.id && !creating && (
              <div className="sm:ml-auto">
                {!deleteConfirm ? (
                  <button
                    type="button"
                    onClick={() => setDeleteConfirm(true)}
                    className="flex min-h-10 items-center gap-2 rounded-md px-3 text-xs font-semibold text-red-300 transition-[background-color,scale] hover:bg-red-500/[0.07] active:scale-95"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> 删除项目
                  </button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 rounded-md bg-red-500/[0.06] p-2 ring-1 ring-inset ring-red-500/20">
                    <span className="px-1 text-xs text-red-200">历史扫描结果不会删除</span>
                    <button
                      type="button"
                      onClick={() => setDeleteConfirm(false)}
                      className="min-h-10 rounded-md px-3 text-xs text-[#aaa] active:scale-95"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={remove}
                      className="min-h-10 rounded-md bg-red-400 px-3 text-xs font-bold text-black transition-[scale] active:scale-95 disabled:opacity-40"
                    >
                      确认删除
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function BulkAssetImportPanel({
  value,
  result,
  capacityError,
  onChange,
  onConfirm,
  onCancel,
}: {
  value: string;
  result: BulkAssetImportResult;
  capacityError: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const canConfirm = result.assets.length > 0 && !capacityError;

  return (
    <div className="min-w-0 rounded-lg bg-black/30 p-3 ring-1 ring-inset ring-white/[0.08]">
      <div className="flex min-w-0 flex-col gap-1">
        <h4 className="text-xs font-semibold text-[#ddd]">批量导入资产</h4>
        <p className="text-[11px] leading-5 text-[#686868]">
          每行一个普通目标；以 # 开头的行作为分组标题，空行会自动忽略。
        </p>
      </div>
      <label
        htmlFor="bulk-asset-input"
        className="mt-3 block text-[11px] font-semibold text-[#8a8a8a]"
      >
        资产清单
      </label>
      <textarea
        id="bulk-asset-input"
        value={value}
        rows={8}
        spellCheck={false}
        placeholder={'# 京东商城\n*.jd.com\n*.jd.hk'}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 block w-full min-w-0 resize-y rounded-md bg-[#0b0d0d] px-3 py-2.5 font-mono text-xs leading-5 text-white ring-1 ring-inset ring-white/[0.09] placeholder:text-[#444] focus-visible:ring-emerald-400/60"
      />

      <div className="mt-3 grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
        <ImportMetric label="将导入资产" value={result.assets.length} />
        <ImportMetric label="分组" value={result.groupCount} />
        <ImportMetric label="重复/跳过" value={result.skippedCount} />
        <ImportMetric label="错误" value={result.errors.length} />
      </div>

      <div className="mt-3 space-y-2 text-[11px] leading-5">
        {result.errors.length > 0 && (
          <div
            role="alert"
            className="min-w-0 rounded-md bg-amber-500/[0.08] px-3 py-2 text-amber-200 ring-1 ring-inset ring-amber-500/20"
          >
            <p className="font-semibold">以下行无法导入：</p>
            <ul className="mt-1 space-y-0.5 break-words text-amber-100/80">
              {result.errors.map((error) => (
                <li key={`${error.line}-${error.message}`}>
                  第 {error.line} 行：{error.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        {capacityError && (
          <p
            role="alert"
            className="min-w-0 rounded-md bg-red-500/[0.08] px-3 py-2 text-red-200 ring-1 ring-inset ring-red-500/20"
          >
            {capacityError}
          </p>
        )}
        {!result.assets.length && !result.errors.length && (
          <p role="status" className="text-[#777]">
            尚未识别到可导入的资产。请粘贴至少一行目标地址或域名。
          </p>
        )}
        {result.errors.length > 0 && result.assets.length > 0 && (
          <p className="text-[#777]">确认导入后，有错误的行会被跳过，其余有效资产仍会加入草稿。</p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="min-h-10 rounded-md px-3 text-xs font-semibold text-[#aaa] transition-[background-color,scale] hover:bg-white/[0.06] active:scale-95"
        >
          取消
        </button>
        <button
          type="button"
          disabled={!canConfirm}
          onClick={onConfirm}
          className="flex min-h-10 items-center gap-1.5 rounded-md bg-emerald-300 px-3 text-xs font-bold text-black transition-[background-color,scale] hover:bg-emerald-200 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35"
        >
          <Upload className="h-3.5 w-3.5" /> 导入 {result.assets.length} 项
        </button>
      </div>
    </div>
  );
}

function ImportMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 rounded-md bg-white/[0.035] px-3 py-2 ring-1 ring-inset ring-white/[0.06]">
      <p className="text-[10px] leading-4 text-[#696969]">{label}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums text-[#ddd]">{value}</p>
    </div>
  );
}

function AssetRow({
  asset,
  index,
  canRemove,
  onChange,
  onRemove,
}: {
  asset: ProjectAsset;
  index: number;
  canRemove: boolean;
  onChange: (patch: Partial<ProjectAsset>) => void;
  onRemove: () => void;
}) {
  const Icon = asset.kind === "mount" ? FolderOpen : asset.kind === "target_list" ? FileInput : Globe2;
  const placeholder =
    asset.kind === "mount"
      ? "/Users/me/source"
      : asset.kind === "target_list"
        ? "/Users/me/targets.txt"
        : "https://app.example.com、仓库、域名、IP 或本地目录";
  return (
    <div className="grid min-w-0 gap-2 rounded-lg bg-black/40 p-3 ring-1 ring-inset ring-white/[0.06] md:grid-cols-[42px_150px_minmax(180px,1fr)_180px_42px] md:items-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-md bg-white/[0.045] text-[#777]">
        <Icon className="h-4 w-4" />
      </span>
      <select
        aria-label={`资产 ${index + 1} 类型`}
        value={asset.kind}
        onChange={(event) => onChange({ kind: event.target.value as AssetKind })}
        className="h-10 w-full min-w-0 rounded-md bg-[#0d0f0f] px-3 text-xs text-[#ddd] ring-1 ring-inset ring-white/[0.09] focus-visible:ring-emerald-400/60"
      >
        <option value="target">普通目标</option>
        <option value="mount">只读挂载</option>
        <option value="target_list">目标清单</option>
      </select>
      <input
        aria-label={`资产 ${index + 1} 内容`}
        value={asset.value}
        placeholder={placeholder}
        onChange={(event) => onChange({ value: event.target.value })}
        className="h-10 w-full min-w-0 rounded-md bg-[#0d0f0f] px-3 font-mono text-xs text-white ring-1 ring-inset ring-white/[0.09] placeholder:text-[#444] focus-visible:ring-emerald-400/60"
      />
      <input
        aria-label={`资产 ${index + 1} 名称`}
        value={asset.label}
        placeholder="资产名称，可选"
        onChange={(event) => onChange({ label: event.target.value })}
        className="h-10 w-full min-w-0 rounded-md bg-[#0d0f0f] px-3 text-xs text-white ring-1 ring-inset ring-white/[0.09] placeholder:text-[#444] focus-visible:ring-emerald-400/60"
      />
      <button
        type="button"
        aria-label={`删除资产 ${index + 1}`}
        disabled={!canRemove}
        onClick={onRemove}
        className="flex h-10 w-10 items-center justify-center rounded-md text-[#666] transition-[background-color,color,scale] hover:bg-red-500/[0.08] hover:text-red-300 active:scale-95 disabled:opacity-20"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function FormSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-4 flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-start">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-[#e5e5e5]">{title}</h3>
          <p className="mt-1 text-xs leading-5 text-[#626262]">{description}</p>
        </div>
        {action}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export function FieldLabel({ children, required = false }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="text-[11px] font-semibold text-[#8a8a8a]">
      {children}
      {required && <span className="ml-1 text-amber-300">必填</span>}
    </label>
  );
}

export function TextField({
  label,
  value,
  placeholder,
  mono = false,
  required = false,
  disabled = false,
  type = "text",
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  mono?: boolean;
  required?: boolean;
  disabled?: boolean;
  type?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <FieldLabel required={required}>{label}</FieldLabel>
      <input
        type={type}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-2 h-10 w-full rounded-md bg-[#0b0d0d] px-3 text-sm text-white ring-1 ring-inset ring-white/[0.09] placeholder:text-[#444] focus-visible:ring-emerald-400/60 disabled:text-[#666] ${mono ? "font-mono text-xs" : ""}`}
      />
    </div>
  );
}

export function TextAreaField({
  label,
  value,
  placeholder,
  rows,
  required = false,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  rows: number;
  required?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <FieldLabel required={required}>{label}</FieldLabel>
      <textarea
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full resize-y rounded-md bg-[#0b0d0d] px-3 py-2.5 text-sm leading-6 text-white ring-1 ring-inset ring-white/[0.09] placeholder:text-[#444] focus-visible:ring-emerald-400/60"
      />
    </div>
  );
}

export function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 h-10 w-full rounded-md bg-[#0b0d0d] px-3 text-sm text-[#ddd] ring-1 ring-inset ring-white/[0.09] focus-visible:ring-emerald-400/60"
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </div>
  );
}

export function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  optional = false,
  onChange,
}: {
  label: string;
  value: number | null;
  min: number;
  max?: number;
  step?: number;
  optional?: boolean;
  onChange: (value: number | null) => void;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <input
        type="number"
        value={value ?? ""}
        min={min}
        max={max}
        step={step}
        placeholder={optional ? "不限制" : undefined}
        onChange={(event) =>
          onChange(event.target.value === "" ? null : Number(event.target.value))
        }
        className="mt-2 h-10 w-full rounded-md bg-[#0b0d0d] px-3 text-sm tabular-nums text-white ring-1 ring-inset ring-white/[0.09] placeholder:text-[#444] focus-visible:ring-emerald-400/60"
      />
    </div>
  );
}

export function assetKindLabel(kind: AssetKind): string {
  return kind === "mount" ? "只读挂载" : kind === "target_list" ? "目标清单" : "普通目标";
}

function ProjectMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#090b0b] px-4 py-3">
      <p className="text-[10px] uppercase tracking-[0.12em] text-[#535353]">{label}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums text-[#bbb]">{value}</p>
    </div>
  );
}

export function assetKindIcon(kind: AssetKind) {
  return kind === "mount" ? FolderOpen : kind === "target_list" ? FileCode2 : Globe2;
}
