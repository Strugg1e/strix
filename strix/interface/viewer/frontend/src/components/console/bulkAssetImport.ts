import type { ProjectAsset } from "@/data/consoleSource";

export const BULK_ASSET_MAX_COUNT = 200;
export const BULK_ASSET_VALUE_MAX_LENGTH = 2048;
export const BULK_ASSET_LABEL_MAX_LENGTH = 100;

export interface BulkAssetImportEntry {
  kind: "target";
  value: string;
  label: string;
  enabled: true;
  line: number;
}

export interface BulkAssetImportError {
  line: number;
  message: string;
}

export interface BulkAssetImportResult {
  assets: BulkAssetImportEntry[];
  groupCount: number;
  duplicateCount: number;
  skippedCount: number;
  errors: BulkAssetImportError[];
  hasAssetLines: boolean;
}

type ExistingAsset = Pick<ProjectAsset, "kind" | "value">;

/**
 * Parse a line-oriented target list without mutating the project draft.
 *
 * Lines beginning with `#` change the label applied to subsequent targets.
 * Blank lines are ignored. Targets are de-duplicated against the supplied
 * project assets and against earlier targets in the same input.
 */
export function parseBulkAssets(
  input: string,
  existingAssets: ExistingAsset[] = []
): BulkAssetImportResult {
  const seen = new Set(
    existingAssets
      .filter((asset) => asset.kind === "target" && asset.value.trim())
      .map((asset) => assetKey(asset.value.trim()))
  );
  const groups = new Set<string>();
  const assets: BulkAssetImportEntry[] = [];
  const errors: BulkAssetImportError[] = [];
  let duplicateCount = 0;
  let skippedCount = 0;
  let hasAssetLines = false;
  let currentLabel = "";

  // Normalise CRLF and old-style CR input before splitting so line numbers are
  // stable regardless of where the pasted list came from.
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((rawLine, index) => {
    const line = index + 1;
    const value = rawLine.trim();
    if (!value) return;

    if (value.startsWith("#")) {
      const label = value.slice(1).trim();
      if (label.length > BULK_ASSET_LABEL_MAX_LENGTH) {
        errors.push({
          line,
          message: `分组名称不能超过 ${BULK_ASSET_LABEL_MAX_LENGTH} 个字符`,
        });
        currentLabel = "";
        skippedCount += 1;
        return;
      }
      currentLabel = label;
      if (label) groups.add(label);
      return;
    }

    hasAssetLines = true;
    if (value.length > BULK_ASSET_VALUE_MAX_LENGTH) {
      errors.push({
        line,
        message: `资产内容不能超过 ${BULK_ASSET_VALUE_MAX_LENGTH} 个字符`,
      });
      skippedCount += 1;
      return;
    }

    const key = assetKey(value);
    if (seen.has(key)) {
      duplicateCount += 1;
      skippedCount += 1;
      return;
    }

    seen.add(key);
    assets.push({ kind: "target", value, label: currentLabel, enabled: true, line });
  });

  return {
    assets,
    groupCount: groups.size,
    duplicateCount,
    skippedCount,
    errors,
    hasAssetLines,
  };
}

function assetKey(value: string): string {
  return `target\u0000${value}`;
}
