/** Shared copy and formatting helpers for the local results viewer. */

export const SEVERITY_LABELS = {
  critical: "严重",
  high: "高危",
  medium: "中危",
  low: "低危",
  info: "信息",
  none: "无",
} as const;

export const STATUS_LABELS: Record<string, string> = {
  open: "待处理",
  in_progress: "处理中",
  snoozed: "已延后",
  fixed: "已修复",
  ignored: "已忽略",
  running: "运行中",
  waiting: "等待中",
  completed: "已完成",
  failed: "失败",
  crashed: "失败",
  error: "失败",
  stopped: "已停止",
  budget_paused: "预算暂停",
  unknown: "未知",
};

export const FIX_EFFORT_LABELS: Record<string, string> = {
  trivial: "极低",
  low: "低",
  medium: "中",
  high: "高",
};

export const TARGET_TYPE_LABELS: Record<string, string> = {
  web_application: "Web 应用",
  webapp: "Web 应用",
  code_repository: "代码仓库",
  repository: "代码仓库",
  local_code: "本地代码",
  ip: "IP 地址",
  ip_address: "IP 地址",
  domain: "域名",
};

export const SCAN_MODE_LABELS: Record<string, string> = {
  quick: "快速",
  standard: "标准",
  deep: "深度",
};

export const SCOPE_MODE_LABELS: Record<string, string> = {
  auto: "自动",
  diff: "差异",
  full: "完整",
  complete: "完整",
};

export const TOOL_LABELS: Record<string, string> = {
  browser: "浏览器",
  terminal: "终端",
  python: "Python",
  proxy: "代理",
  apply_patch: "应用补丁",
  edit_file: "编辑文件",
  list_files: "列出文件",
  search_files: "搜索文件",
  create_agent: "创建 Agent",
  send_message: "发送消息",
  wait: "等待",
  think: "思考",
  finish_scan: "完成扫描",
  create_vulnerability_report: "创建漏洞报告",
  list_vulnerability_reports: "列出漏洞报告",
  get_vulnerability_report: "获取漏洞报告",
  create_todo: "添加任务",
  list_todos: "列出任务",
};

export const CVSS_FACTOR_LABELS: Record<string, string> = {
  attack_vector: "攻击向量",
  attack_complexity: "攻击复杂度",
  privileges_required: "所需权限",
  user_interaction: "用户交互",
  scope: "影响范围",
  confidentiality: "机密性",
  integrity: "完整性",
  availability: "可用性",
};

export const REPORT_SECTION_LABELS: Record<string, string> = {
  "Executive Summary": "执行摘要",
  Methodology: "方法论",
  "Technical Analysis": "技术分析",
  Recommendations: "修复建议",
  "Technical Details": "技术详情",
  Impact: "影响",
  "Proof of Concept": "概念验证",
  Remediation: "修复方案",
  Assumptions: "假设",
  Evidence: "证据",
  "Run details": "运行详情",
  Configuration: "配置",
  Targets: "目标",
  Instruction: "指令",
  Scope: "范围",
  Mode: "模式",
  Status: "状态",
  "Local sources": "本地源",
  "Usage & cost": "用量与费用",
  Model: "模型",
  Provider: "提供方",
  "Run time": "运行时长",
  Requests: "请求数",
  "Input tokens": "输入 tokens",
  "Output tokens": "输出 tokens",
  "Total tokens": "总 tokens",
  Cost: "费用",
  Agents: "Agent 数量",
};

/** Exact Markdown report headings that are emitted by the server in English. */
export const MARKDOWN_HEADING_LABELS: Record<string, string> = {
  Description: "描述",
  "Confirmed Findings": "已确认发现",
  "Systemic Themes": "系统性主题",
  "Areas Tested with No Findings": "已测试且未发现问题的区域",
  Immediate: "立即",
  "Short-term": "短期",
  "Medium-term": "中期",
  "Retest & Validation": "复测与验证",
};

export function severityLabel(value: string | null | undefined): string {
  return value && value in SEVERITY_LABELS
    ? SEVERITY_LABELS[value as keyof typeof SEVERITY_LABELS]
    : value || "未知";
}

export function statusLabel(value: string | null | undefined): string {
  return value ? STATUS_LABELS[value] ?? "未知" : "未知";
}

export function targetTypeLabel(value: string | null | undefined): string {
  return value ? TARGET_TYPE_LABELS[value] ?? "未知" : "未知";
}

export function scanModeLabel(value: string | null | undefined): string {
  return value ? SCAN_MODE_LABELS[value] ?? "未知" : "未知";
}

export function scopeModeLabel(value: string | null | undefined): string {
  return value ? SCOPE_MODE_LABELS[value] ?? "未知" : "未知";
}

export function toolLabel(value: string): string {
  return TOOL_LABELS[value] ?? value.replace(/_/g, " ");
}

export function viewerErrorMessage(error: unknown, fallback = "加载失败，请稍后重试。"): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/responded 401|unauthorized|未授权/i.test(message)) return "当前链接未授权，请重新打开带 token 的结果链接。";
  if (/responded 403|forbidden|禁止/i.test(message)) return "当前操作没有权限。";
  if (/responded 404|not found|不存在/i.test(message)) return "未找到请求的结果数据。";
  if (/network|failed to fetch|fetch/i.test(message)) return "无法连接本地结果服务，请确认服务仍在运行。";
  return fallback;
}

export function fixEffortLabel(value: string | null | undefined): string {
  return value ? FIX_EFFORT_LABELS[value] ?? value : "未知";
}

export function reportSectionLabel(value: string): string {
  return REPORT_SECTION_LABELS[value] ?? value;
}

export function markdownHeadingLabel(value: string): string {
  return MARKDOWN_HEADING_LABELS[value] ?? value;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

export function formatDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatRelativeTime(value: string | Date, now = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (!Number.isFinite(diff)) return "未知时间";
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} 天前`;
  return formatDate(date);
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0 || !Number.isFinite(seconds)) return "暂无";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h} 小时 ${m} 分钟 ${s} 秒`;
  if (m) return `${m} 分钟 ${s} 秒`;
  return `${s} 秒`;
}
