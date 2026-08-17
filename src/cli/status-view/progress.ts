/**
 * Transfer-progress wording, shared by spinners, the live status line, and the
 * brief headline. One module owns the phase vocabulary and every byte, rate and
 * ETA format that appears beside it, so a new surface cannot invent a second way
 * to say "uploading 3/7".
 */
import { formatDecimalBytes } from "../quota-format.js";
import type { TransferPhase, TransferProgressBytes } from "../transfer-progress.js";
import { n, truncateDetail } from "./text.js";

const BINARY_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

/**
 * Shared by spinners and the live status line.
 * Phase-shaped so the two silent-until-now phases read truthfully:
 *  - `scan` is INDETERMINATE (no known total during a live walk) → count only,
 *    no percent: `scanning… 12,304 files`.
 *  - `gitcap` is a per-repo N/total with an optional repo name:
 *    `capturing git state 3/140 — zen-browser-desktop`.
 *  - byte-aware transfer phases render a byte-derived bar/percent and byte fraction;
 *    entry counts are never used as a transfer percentage.
 */
export function progressLabel(phase: TransferPhase, done: number, total: number, detail?: string, bytes?: TransferProgressBytes): string {
  if (phase === "scan") return `scanning… ${n(done)} files${bytes ? ` · ${formatDecimalBytes(bytes.bytesDone)}` : ""}`;
  const byteSuffix = bytes ? ` · ${formatProgressBytes(bytes)}` : "";
  if (phase === "gitcap") {
    const suffix = detail ? ` — ${truncateDetail(detail)}` : "";
    return `capturing git state ${n(done)}/${n(total)}${byteSuffix}${suffix}`;
  }
  // Determinate transfer phases. The final `?? "syncing"` is a defensive fallback so a
  // phase string an OLDER daemon never wrote (read from the user-editable activity file)
  // degrades to a sane verb rather than a misleading "downloading".
  const verb = phase === "encrypt" ? "encrypting" : phase === "upload" ? "uploading" : phase === "download" ? "downloading" : "syncing";
  if (bytes?.bytesTotal !== undefined && bytes.bytesTotal > 0) {
    const pct = Math.min(100, Math.max(0, Math.floor((bytes.bytesDone / bytes.bytesTotal) * 100)));
    const rate = phase === "upload" && bytes.bytesPerSecond !== undefined && Number.isFinite(bytes.bytesPerSecond) && bytes.bytesPerSecond > 0 ? ` · ${formatRate(bytes.bytesPerSecond)}` : "";
    const eta = phase === "upload" && bytes.etaSeconds !== undefined && Number.isFinite(bytes.etaSeconds) && bytes.etaSeconds >= 0 ? ` · ${formatEta(bytes.etaSeconds)}` : "";
    return `${verb} ${progressBar(pct)} ${pct}%${byteSuffix}${rate}${eta}`;
  }
  return `${verb} ${n(done)}/${n(total)}${byteSuffix}`;
}

function formatProgressBytes(bytes: TransferProgressBytes): string {
  if (bytes.bytesTotal !== undefined && bytes.bytesTotal > 0) return formatDecimalBytePair(bytes.bytesDone, bytes.bytesTotal);
  return `${formatDecimalBytes(bytes.bytesDone)} sent`;
}

const DECIMAL_PROGRESS_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
function formatDecimalBytePair(done: number, total: number): string {
  let unit = 0;
  let scaledTotal = Math.max(0, total);
  while (scaledTotal >= 1_000 && unit < DECIMAL_PROGRESS_UNITS.length - 1) {
    scaledTotal /= 1_000;
    unit++;
  }
  if (unit === 0) return `${Math.round(Math.max(0, done))} B / ${Math.round(scaledTotal)} B`;
  const divisor = 1_000 ** unit;
  return `${(Math.max(0, done) / divisor).toFixed(1)} ${DECIMAL_PROGRESS_UNITS[unit]} / ${scaledTotal.toFixed(1)} ${DECIMAL_PROGRESS_UNITS[unit]}`;
}

const progressBar = (pct: number): string => {
  const filled = Math.floor(pct / 20);
  return `${"▓".repeat(filled)}${"░".repeat(5 - filled)}`;
};

function formatRate(bytesPerSecond: number): string {
  const mb = Math.max(0, bytesPerSecond) / 1_000_000;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB/s`;
}

function formatEta(seconds: number): string {
  const safe = Math.max(0, seconds);
  return safe < 60 ? `~${Math.round(safe)}s left` : `~${Math.max(1, Math.round(safe / 60))}m left`;
}

export function formatBinaryBytePair(done: number, total: number): string {
  const clampedTotal = Math.max(0, total);
  const clampedDone = Math.max(0, done);
  if (clampedTotal < 1024) return `${Math.round(clampedDone)}/${Math.round(clampedTotal)} B`;
  let unit = 0;
  let scaledTotal = clampedTotal;
  while (scaledTotal >= 1024 && unit < BINARY_UNITS.length - 1) {
    scaledTotal /= 1024;
    unit++;
  }
  const divisor = 1024 ** unit;
  return `${(clampedDone / divisor).toFixed(1)}/${scaledTotal.toFixed(1)} ${BINARY_UNITS[unit]}`;
}
