/**
 * The display primitives every status surface shares: number grouping, byte
 * sizes, the two age vocabularies, and the terminal-safety rules for untrusted
 * local strings.
 *
 * These are the leaf of the status-view family — nothing here knows about a
 * snapshot, a deferral, or a brief. Everything above imports downward into this
 * module, so one sanitize/truncate rule governs every rendered line.
 */
import { formatDecimalBytes } from "../quota-format.js";

export const n = (v: number) => v.toLocaleString("en-US");

/** "just now" / "42s ago" / "5m ago" / "3h ago" / "2d ago". */
export function relTime(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(s)) return "unknown";
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Coarse chronic-age bucket shared by all deferral visibility surfaces. */
export function ageBucket(iso: string, now: number): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed) || parsed > now) return "unknown";
  const seconds = Math.floor((now - parsed) / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return "1h";
  if (seconds < 7 * 86400) return "1d";
  if (seconds < 14 * 86400) return "7d";
  if (seconds < 30 * 86400) return "14d";
  return "30d";
}

export const ageLabel = (ageMs: number | undefined): string => {
  if (ageMs === undefined || !Number.isFinite(ageMs)) return "unknown";
  return `${Math.max(0, Math.round(ageMs / 1000))}s ago`;
};

/** Longest display `detail` (in CODE POINTS, e.g. a repo name) rendered on the
 *  progress line; a longer one is head-truncated so the meaningful TAIL (the
 *  basename) survives. */
const DETAIL_MAX = 40;
/** Sanitize + truncate a display `detail`. Detail comes from on-disk names,
 *  i.e. untrusted bytes headed for a terminal: strip ANSI/CSI escape
 *  sequences and every remaining control char first, then truncate by CODE POINTS
 *  (Array.from — a `.slice` on UTF-16 units could cut through a surrogate pair and
 *  emit a lone-surrogate mojibake) keeping the tail. */
export const sanitizeTerminalText = (text: string): string =>
  text.replace(/\u001b\[[0-9;:?]*[ -/]*[@-~]/g, "").replace(/\p{Cc}/gu, "");

export const truncateDetail = (d: string): string => {
  const clean = sanitizeTerminalText(d);
  const cps = Array.from(clean);
  return cps.length > DETAIL_MAX ? `…${cps.slice(-(DETAIL_MAX - 1)).join("")}` : clean;
};

/** Longest curated deferral `detail` rendered in the status companion line. */
const CURATED_DETAIL_MAX = 120;
/** Curated prose reads from its HEAD, so an over-long persisted value keeps the
 *  head and loses the tail — the opposite of {@link truncateDetail}, which keeps
 *  a path's meaningful basename. A persisted record written by an older, wider,
 *  or corrupted author must never render an unbounded line. */
export const boundedCuratedDetail = (d: string): string => {
  const cps = Array.from(sanitizeTerminalText(d));
  return cps.length > CURATED_DETAIL_MAX ? `${cps.slice(0, CURATED_DETAIL_MAX - 1).join("")}…` : cps.join("");
};

/** Human byte size: `847 B` / `12.3 KB` / `312.4 MB` / `1.4 GB` (decimal units, one
 *  decimal place above bytes). Pure — the status trash line and any future size surface
 *  share one formatting rule. */
export function humanBytes(bytes: number): string {
  return formatDecimalBytes(bytes);
}
