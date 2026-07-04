const BINARY_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
const DECIMAL_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

function formatBytes(bytes: number, base: 1000 | 1024, units: readonly string[]): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= base && unit < units.length - 1) {
    value /= base;
    unit++;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** Binary byte formatter for quota surfaces. Plan caps are defined in GiB, not decimal GB. */
export function formatBinaryBytes(bytes: number): string {
  return formatBytes(bytes, 1024, BINARY_UNITS);
}

/** Decimal byte formatter for status/trash surfaces. Deliberately not used for plan caps. */
export function formatDecimalBytes(bytes: number): string {
  return formatBytes(bytes, 1000, DECIMAL_UNITS);
}

export function quotaUsage(kind: "storage" | "workspaces", used?: number, cap?: number): string | undefined {
  if (kind === "workspaces") {
    if (used !== undefined && cap !== undefined) return `${used.toLocaleString("en-US")} of ${cap.toLocaleString("en-US")}`;
    if (cap !== undefined) return cap.toLocaleString("en-US");
    return undefined;
  }
  if (used !== undefined && cap !== undefined) return `${formatBinaryBytes(used)} of ${formatBinaryBytes(cap)}`;
  if (used !== undefined) return formatBinaryBytes(used);
  if (cap !== undefined) return formatBinaryBytes(cap);
  return undefined;
}
