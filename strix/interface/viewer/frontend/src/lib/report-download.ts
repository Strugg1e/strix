/** Helpers shared by the local report-download API and its browser trigger. */

/** Build the local, run-scoped PDF download endpoint URL. */
export function reportDownloadPath(runName?: string | null): string {
  return `/api/report/download${runName ? `?run=${encodeURIComponent(runName)}` : ""}`;
}

/**
 * Read a server-provided PDF filename while keeping the DOM download attribute
 * safe if a proxy ever returns an unexpected header. The local server emits a
 * conservative ASCII basename, but this parser still rejects separators,
 * control characters, and missing/incorrect extensions.
 */
export function reportFilenameFromContentDisposition(header: string | null): string {
  const match = header?.match(/filename\s*=\s*"([^"]*)"/i) ?? header?.match(/filename\s*=\s*([^;\s]+)/i);
  const candidate = match?.[1]?.trim() ?? "";
  const safe = candidate
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/\.\.+/g, "_");
  return safe.toLowerCase().endsWith(".pdf") && safe !== ".pdf"
    ? safe
    : "strix-report.pdf";
}
