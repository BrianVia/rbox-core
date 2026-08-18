/** Never: process control or runtime-state mutation. */
import fsp from "node:fs/promises";
import path from "node:path";
import { daemonCrashLogPath, daemonRuntimeDir } from "../rbox-paths.js";
import { parseDaemonDatedLogBasename } from "./logger.js";
import {
  currentWorkspaceId,
  readDaemonBindingRecord,
  readDaemonPidRecord,
  type DaemonBindingRecord,
  type DaemonPidRecord,
} from "./runtime-state.js";

const RBOX_DIR = ".rbox";
const LOG_FILE = "daemon.log";
const logPath = daemonCrashLogPath;

/** Pre-global location of the pid/log (inside the workspace). Kept only as a
 *  READ fallback so a daemon started before this change stays visible to `rbox
 *  logs`; nothing new is ever written here. Pre-launch back-compat, not migration. */
const legacyLogPath = (root: string) => path.join(root, RBOX_DIR, LOG_FILE);

/** Resolve the dated operational stream plus independent crash and legacy
 * channels. The latter two never suppress each other or the dated stream. */
export interface DaemonLogSources {
  crash?: string;
  dated?: string;
  legacy?: string;
}

/** Resolve independent daemon channels by filename calendar date, never mtime. */
export async function resolveDaemonLogSources(root: string, now: Date = new Date()): Promise<DaemonLogSources> {
  const runtime = daemonRuntimeDir(root);
  const today = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86_400_000);
  let dated: string | undefined;
  try {
    const eligible: string[] = [];
    for (const name of await fsp.readdir(runtime)) {
      const parsed = parseDaemonDatedLogBasename(name);
      if (!parsed || parsed.day > today) continue;
      try {
        const stat = await fsp.lstat(path.join(runtime, name));
        if (stat.isFile() && !stat.isSymbolicLink()) eligible.push(name);
      } catch { /* raced with rotation/removal */ }
    }
    eligible.sort();
    if (eligible.length) dated = path.join(runtime, eligible[eligible.length - 1]!);
  } catch { /* runtime absent/unreadable */ }
  const present = async (file: string): Promise<string | undefined> => {
    try { return (await fsp.lstat(file)).isFile() ? file : undefined; } catch { return undefined; }
  };
  const crash = await present(logPath(root));
  const legacy = await present(legacyLogPath(root));
  return {
    ...(crash ? { crash } : {}),
    ...(dated ? { dated } : {}),
    ...(legacy ? { legacy } : {}),
  };
}


export const DEFAULT_LOG_LINES = 50;
const AUXILIARY_TAIL_BYTES = 64 * 1024;

async function readHandleRange(fd: fsp.FileHandle, start: number, end: number): Promise<Buffer> {
  const out = Buffer.alloc(Math.max(0, end - start));
  let offset = 0;
  while (offset < out.length) {
    const { bytesRead } = await fd.read(out, offset, out.length - offset, start + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === out.length ? out : out.subarray(0, offset);
}

async function truncatedLinePrefix(fd: fsp.FileHandle, start: number): Promise<string> {
  let position = start;
  let lineStart = 0;
  while (position > 0) {
    const length = Math.min(AUXILIARY_TAIL_BYTES, position);
    position -= length;
    const part = await readHandleRange(fd, position, position + length);
    const newline = part.lastIndexOf(0x0a);
    if (newline >= 0) { lineStart = position + newline + 1; break; }
  }
  return (await readHandleRange(fd, lineStart, Math.min(start, lineStart + 512))).toString("utf8");
}

async function tailHandle(fd: fsp.FileHandle, maxLines: number | undefined, maxBytes: number): Promise<{ text: string; size: number; truncatedPrefix?: string }> {
  const { size } = await fd.stat();
  if (maxLines !== undefined) {
    if (size === 0 || maxLines <= 0) return { text: "", size };
    let position = size;
    let newlines = 0;
    const parts: Buffer[] = [];
    while (position > 0 && newlines <= maxLines) {
      const length = Math.min(AUXILIARY_TAIL_BYTES, position);
      position -= length;
      const part = await readHandleRange(fd, position, position + length);
      parts.unshift(part);
      for (const byte of part) if (byte === 0x0a) newlines++;
    }
    const lines = Buffer.concat(parts).toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const text = lines.slice(-maxLines).join("\n");
    return { text: text ? `${text}\n` : "", size };
  }
  const start = Math.max(0, size - maxBytes);
  const bytes = await readHandleRange(fd, start, size);
  let text = bytes.toString("utf8");
  let truncatedPrefix: string | undefined;
  if (start > 0) {
    truncatedPrefix = await truncatedLinePrefix(fd, start);
    const firstNewline = text.indexOf("\n");
    const afterPartial = firstNewline < 0 ? "" : text.slice(firstNewline + 1);
    // Prefer complete records, but a single oversized final record is still the
    // bounded tail and must not collapse to an empty diagnostic section.
    if (afterPartial) text = afterPartial;
  }
  return { text, size, ...(truncatedPrefix !== undefined ? { truncatedPrefix } : {}) };
}

export interface LogsOptions {
  follow: boolean;
  lines: number;
}

type SourceKind = "crash" | "dated" | "legacy";
const SOURCE_ORDER: Record<SourceKind, number> = { crash: 0, dated: 1, legacy: 2 };
interface OpenSource {
  kind: SourceKind;
  file: string;
  fd: fsp.FileHandle;
  dev: number | bigint;
  ino: number | bigint;
  generation: number;
  offset: number;
  stableEofPolls: number;
}

function sourceEntries(sources: DaemonLogSources): Array<[SourceKind, string]> {
  return (["crash", "dated", "legacy"] as const).flatMap((kind) => sources[kind] ? [[kind, sources[kind]!] as [SourceKind, string]] : []);
}

async function openSource(kind: SourceKind, file: string, generation: number): Promise<OpenSource | undefined> {
  try {
    const fd = await fsp.open(file, "r");
    try {
      const stat = await fd.stat();
      return { kind, file, fd, dev: stat.dev, ino: stat.ino, generation, offset: 0, stableEofPolls: 0 };
    } catch (error) {
      await fd.close().catch(() => {});
      throw error;
    }
  } catch { return undefined; }
}

function marked(kind: SourceKind, file: string, bytes: Buffer): string {
  if (bytes.length === 0) return "";
  const label = kind === "dated" ? path.basename(file) : kind;
  return `--- ${label} ---\n${bytes.toString("utf8")}${bytes.at(-1) === 0x0a ? "" : "\n"}`;
}

function mergeInitial(channels: Array<{ kind: SourceKind; text: string }>, markSources = false): string {
  const ordered: Array<{ timestamp: number; kind: SourceKind; offset: number; line: string }> = [];
  const trailing: Array<{ kind: SourceKind; lines: string[] }> = [];
  for (const channel of channels) {
    const nonIso: string[] = [];
    let offset = 0;
    for (const line of channel.text.split("\n")) {
      if (!line) { offset++; continue; }
      const match = /^(\d{4}-\d{2}-\d{2}T\S+)\s/.exec(line);
      const timestamp = match ? Date.parse(match[1]!) : Number.NaN;
      if (Number.isFinite(timestamp)) ordered.push({ timestamp, kind: channel.kind, offset, line });
      else nonIso.push(line);
      offset += Buffer.byteLength(line) + 1;
    }
    if (nonIso.length) trailing.push({ kind: channel.kind, lines: nonIso });
  }
  ordered.sort((a, b) => a.timestamp - b.timestamp || SOURCE_ORDER[a.kind] - SOURCE_ORDER[b.kind] || a.offset - b.offset);
  let result = ordered.map((record) => markSources ? `[${record.kind}] ${record.line}` : record.line).join("\n");
  if (result) result += "\n";
  for (const block of trailing) result += `--- ${block.kind} (un-timestamped) ---\n${block.lines.join("\n")}\n`;
  return result;
}

export async function readMergedDaemonLogTail(root: string, maxBytes = AUXILIARY_TAIL_BYTES): Promise<string> {
  const channels: Array<{ kind: SourceKind; text: string }> = [];
  for (const [kind, file] of sourceEntries(await resolveDaemonLogSources(root))) {
    const source = await openSource(kind, file, 0);
    if (!source) continue;
    try {
      const tail = await tailHandle(source.fd, undefined, maxBytes);
      const prefixMessage = /^\d{4}-\d\d-\d\dT\S+\s+(.*)$/.exec(tail.truncatedPrefix ?? "")?.[1] ?? tail.truncatedPrefix;
      const unsafeTruncatedGit = prefixMessage?.startsWith("git-sync ") || prefixMessage?.startsWith("git-sync:") || prefixMessage?.startsWith("git deferred");
      channels.push({
        kind,
        text: unsafeTruncatedGit
          ? `1970-01-01T00:00:00.000Z git-sync UNKNOWN truncated byte tail\n${tail.text}`
          : tail.text,
      });
    } finally {
      await source.fd.close().catch(() => {});
    }
  }
  return mergeInitial(channels);
}

interface FollowLifecycleSnapshot {
  workspaceId?: string;
  bindingWorkspaceId?: string;
  boot?: string;
  valid: boolean;
}

function lifecycleBoot(pid: DaemonPidRecord, binding: DaemonBindingRecord, workspaceId: string | undefined): string | undefined {
  if (!pid.pid || !binding.workspaceId || binding.workspaceId !== workspaceId) return undefined;
  if (pid.bootId && binding.bootId && pid.bootId !== binding.bootId) return undefined;
  return pid.bootId ?? binding.bootId ?? `legacy:${pid.pid}`;
}

function captureFollowLifecycle(root: string): FollowLifecycleSnapshot {
  const workspaceId = currentWorkspaceId(root);
  const pid = readDaemonPidRecord(root);
  const binding = readDaemonBindingRecord(root);
  const boot = lifecycleBoot(pid, binding, workspaceId);
  const absent = !pid.present && !binding.present;
  return { workspaceId, bindingWorkspaceId: binding.workspaceId, boot, valid: absent || boot !== undefined };
}

function lifecycleMatches(root: string, snapshot: FollowLifecycleSnapshot): boolean {
  if (!snapshot.valid || currentWorkspaceId(root) !== snapshot.workspaceId) return false;
  const pid = readDaemonPidRecord(root);
  const binding = readDaemonBindingRecord(root);
  if (!snapshot.boot) return !pid.present && !binding.present;
  return binding.workspaceId === snapshot.bindingWorkspaceId
    && lifecycleBoot(pid, binding, snapshot.workspaceId) === snapshot.boot;
}

export interface LogsDeps {
  resolveSources?: typeof resolveDaemonLogSources;
  waitForPoll?: () => Promise<void>;
}

/** `rbox logs` merges the operational stream with bounded crash and legacy tails.
 * Follow keeps every opened identity alive, so rollover and late old-date appends
 * remain visible without stat/open races. */
export async function logsDaemon(root: string, opts: LogsOptions, deps: LogsDeps = {}): Promise<void> {
  // Follow is pinned before the first await: resolving or opening sources must not
  // create a window in which a replacement daemon generation can be adopted.
  const lifecycleAtEntry = captureFollowLifecycle(root);
  if (opts.follow && !lifecycleAtEntry.valid) return;
  const resolveSources = deps.resolveSources ?? resolveDaemonLogSources;
  const waitForPoll = deps.waitForPoll ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 250)));
  const open: OpenSource[] = [];
  let stopped = false;
  const stop = () => { stopped = true; };
  let listening = false;
  try {
    const initial: Array<{ kind: SourceKind; text: string }> = [];
    let generation = 0;
    const sources = await resolveSources(root);
    for (const [kind, file] of sourceEntries(sources)) {
      const source = await openSource(kind, file, generation++);
      if (!source) continue;
      open.push(source);
      const tail = await tailHandle(source.fd, kind === "dated" ? opts.lines : undefined, kind === "dated" ? Number.MAX_SAFE_INTEGER : AUXILIARY_TAIL_BYTES);
      source.offset = tail.size;
      initial.push({ kind, text: tail.text });
    }
    if (opts.follow && !lifecycleMatches(root, lifecycleAtEntry)) return;
    if (initial.length) process.stdout.write(mergeInitial(initial, opts.follow));
    else if (!opts.follow) {
      console.log("(no daemon log yet — start background sync with `rbox start`)");
      return;
    }
    if (!opts.follow) return;

    let activeDated = open.find((source) => source.kind === "dated");
    let pendingDated: OpenSource | undefined;
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    listening = true;
    while (!stopped) {
      if (!lifecycleMatches(root, lifecycleAtEntry)) break;
      const resolved = await resolveSources(root);
      if (!lifecycleMatches(root, lifecycleAtEntry)) break;
      for (const [kind, file] of sourceEntries(resolved)) {
        const candidate = await openSource(kind, file, generation++);
        if (!candidate) continue;
        const duplicate = open.some((source) => source.kind === kind && source.dev === candidate.dev && source.ino === candidate.ino);
        if (duplicate) await candidate.fd.close().catch(() => {});
        else {
          open.push(candidate);
          if (kind === "dated" && candidate !== activeDated) pendingDated = candidate;
        }
      }
      for (const source of open) {
        if (source === pendingDated) continue;
        const stat = await source.fd.stat();
        if (stat.size < source.offset) source.offset = 0;
        if (stat.size === source.offset) { source.stableEofPolls++; continue; }
        const bytes = await readHandleRange(source.fd, source.offset, stat.size);
        if (bytes.length > 0) {
          process.stdout.write(marked(source.kind, source.file, bytes));
          source.offset += bytes.length;
          source.stableEofPolls = 0;
        }
      }
      if (pendingDated && (!activeDated || activeDated.stableEofPolls >= 2)) {
        activeDated = pendingDated;
        pendingDated = undefined;
      }
      await waitForPoll();
    }
  } finally {
    if (listening) {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    await Promise.all(open.map((source) => source.fd.close().catch(() => {})));
  }
}
