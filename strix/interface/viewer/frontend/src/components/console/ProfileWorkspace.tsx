import { useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  Cpu,
  KeyRound,
  Plus,
  Save,
  Server,
  Trash2,
  Wifi,
} from "lucide-react";
import {
  deleteLLMProfile,
  saveLLMProfile,
  testLLMProfile,
  type LLMProfile,
} from "@/data/consoleSource";
import { TextField } from "@/components/console/ProjectWorkspace";

type ProfileDraft = {
  id?: string;
  name: string;
  model: string;
  api_base: string;
  api_key: string;
};

export function ProfileWorkspace({
  profiles,
  onChanged,
  setError,
}: {
  profiles: LLMProfile[];
  onChanged: () => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const [selectedId, setSelectedId] = useState(profiles[0]?.id ?? "environment");
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | "delete" | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const selected = profiles.find((profile) => profile.id === selectedId);

  useEffect(() => {
    if (!selected) return;
    setDraft({
      id: selected.readonly ? undefined : selected.id,
      name: selected.name,
      model: selected.model,
      api_base: selected.api_base,
      api_key: "",
    });
    setResult(null);
    setDeleteConfirm(false);
  }, [selected?.id, selected?.name, selected?.model, selected?.api_base]);

  const createNew = () => {
    setSelectedId("");
    setDraft({ name: "", model: "", api_base: "", api_key: "" });
    setResult(null);
    setDeleteConfirm(false);
  };

  const save = async () => {
    if (!draft) return;
    setBusy("save");
    setError(null);
    setResult(null);
    try {
      const saved = await saveLLMProfile(draft);
      await onChanged();
      setSelectedId(saved.id);
      setDraft({
        id: saved.id,
        name: saved.name,
        model: saved.model,
        api_base: saved.api_base,
        api_key: "",
      });
      setResult("配置已保存，API Key 已写入 macOS Keychain");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存配置失败");
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!selected) return;
    setBusy("test");
    setError(null);
    setResult(null);
    try {
      const response = await testLLMProfile(selected.id);
      setResult(`${response.message} · ${response.latency_ms} ms`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "连接测试失败");
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!selected || selected.readonly) return;
    setBusy("delete");
    setError(null);
    try {
      await deleteLLMProfile(selected.id);
      await onChanged();
      setSelectedId("environment");
      setDeleteConfirm(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除配置失败");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid min-w-0 gap-5 lg:grid-cols-[286px_minmax(0,1fr)]">
      <aside className="h-fit overflow-hidden rounded-xl bg-white/[0.018] ring-1 ring-inset ring-white/[0.07] lg:sticky lg:top-[84px]">
        <div className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-semibold">LLM 配置</h1>
            <p className="mt-1 text-[11px] text-[#626262]">{profiles.length} 个连接</p>
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
          {profiles.map((profile) => (
            <button
              type="button"
              key={profile.id}
              onClick={() => setSelectedId(profile.id)}
              className={`flex min-h-16 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-[background-color,scale] active:scale-[0.98] ${
                selected?.id === profile.id ? "bg-white/[0.08]" : "hover:bg-white/[0.04]"
              }`}
            >
              <span className={`flex h-8 w-8 flex-none items-center justify-center rounded-md ${profile.has_api_key ? "bg-emerald-500/[0.09] text-emerald-400" : "bg-white/[0.04] text-[#555]"}`}>
                <Server className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-[#ddd]">{profile.name}</span>
                <span className="mt-1 block truncate font-mono text-[10px] text-[#555]">{profile.model || "未设置模型"}</span>
              </span>
              <ChevronRight className="h-3.5 w-3.5 text-[#444]" />
            </button>
          ))}
        </div>
      </aside>

      <section className="min-w-0 overflow-hidden rounded-xl bg-white/[0.018] ring-1 ring-inset ring-white/[0.08]">
        <div className="flex items-start gap-3 border-b border-white/[0.07] px-5 py-5">
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-emerald-500/[0.08] text-emerald-300">
            <Cpu className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-400">Model connection</p>
            <h2 className="mt-1 text-xl font-semibold tracking-[-0.012em]">{selected?.name ?? "新建 LLM 配置"}</h2>
            <p className="mt-1 text-xs leading-5 text-[#626262]">
              {selected?.readonly
                ? "读取控制台启动环境，只能查看与连接测试。"
                : "元数据保存在本机，API Key 单独保存到 macOS Keychain，浏览器不会收到密钥。"}
            </p>
          </div>
        </div>

        {draft && (
          <div className="space-y-6 p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="配置名称" value={draft.name} placeholder="例如：阿里云 Token Plan" disabled={selected?.readonly} onChange={(name) => setDraft({ ...draft, name })} />
              <TextField label="模型" value={draft.model} placeholder="auto 或 provider/model" mono disabled={selected?.readonly} onChange={(model) => setDraft({ ...draft, model })} />
            </div>
            <TextField label="Base URL" value={draft.api_base} placeholder="https://api.example.com/v1" mono disabled={selected?.readonly} onChange={(api_base) => setDraft({ ...draft, api_base })} />
            <div>
              <div className="flex items-center justify-between gap-3">
                <label className="text-[11px] font-semibold text-[#8a8a8a]">API Key</label>
                <span className="flex items-center gap-1 text-[10px] text-[#555]"><KeyRound className="h-3 w-3" />{selected?.has_api_key ? "已安全保存" : "尚未配置"}</span>
              </div>
              <input
                type="password"
                autoComplete="new-password"
                value={draft.api_key}
                disabled={selected?.readonly}
                onChange={(event) => setDraft({ ...draft, api_key: event.target.value })}
                placeholder={selected?.has_api_key ? "留空则保持现有 Key" : "输入 API Key"}
                className="mt-2 h-10 w-full rounded-md bg-[#0b0d0d] px-3 font-mono text-xs text-white ring-1 ring-inset ring-white/[0.09] placeholder:text-[#444] focus-visible:ring-emerald-400/60 disabled:text-[#666]"
              />
              <p className="mt-2 text-[11px] text-[#555]">服务端只接收一次，保存、读取和测试接口均不会返回密钥内容。</p>
            </div>

            {result && (
              <div role="status" className="flex items-center gap-2 rounded-md bg-emerald-500/[0.06] px-3 py-2.5 text-xs text-emerald-300 ring-1 ring-inset ring-emerald-500/20">
                <Check className="h-3.5 w-3.5" /> {result}
              </div>
            )}

            <div className="flex flex-col gap-2 border-t border-white/[0.07] pt-5 sm:flex-row sm:items-center">
              {selected && (
                <button type="button" disabled={busy !== null || !selected.has_api_key} onClick={test} className="flex min-h-10 items-center justify-center gap-2 rounded-md px-4 text-xs font-semibold text-[#bbb] ring-1 ring-inset ring-white/[0.1] transition-[background-color,scale] hover:bg-white/[0.04] active:scale-95 disabled:opacity-30"><Wifi className="h-3.5 w-3.5" />{busy === "test" ? "测试中" : "测试连接"}</button>
              )}
              {!selected?.readonly && (
                <button type="button" disabled={busy !== null} onClick={save} className="flex min-h-10 items-center justify-center gap-2 rounded-md bg-white px-4 text-xs font-bold text-black transition-[background-color,scale] hover:bg-[#ddd] active:scale-95 disabled:opacity-35"><Save className="h-3.5 w-3.5" />{busy === "save" ? "保存中" : "保存配置"}</button>
              )}
              {selected && !selected.readonly && (
                <div className="sm:ml-auto">
                  {!deleteConfirm ? (
                    <button type="button" onClick={() => setDeleteConfirm(true)} className="flex min-h-10 items-center gap-2 rounded-md px-3 text-xs font-semibold text-red-300 transition-[background-color,scale] hover:bg-red-500/[0.07] active:scale-95"><Trash2 className="h-3.5 w-3.5" />删除配置</button>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2 rounded-md bg-red-500/[0.06] p-2 ring-1 ring-inset ring-red-500/20">
                      <span className="px-1 text-xs text-red-200">同时删除 Keychain 密钥</span>
                      <button type="button" onClick={() => setDeleteConfirm(false)} className="min-h-10 rounded-md px-3 text-xs text-[#aaa] active:scale-95">取消</button>
                      <button type="button" disabled={busy !== null} onClick={remove} className="min-h-10 rounded-md bg-red-400 px-3 text-xs font-bold text-black active:scale-95 disabled:opacity-40">确认删除</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
