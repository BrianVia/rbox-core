import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIgnoreMatcher, checkoutTransactionCapability, cryptoPoolStatus, ManifestChainError, MAX_MANIFEST_DELTA_CHAIN, type IgnoreMatcher } from "../engine/index.js";
import { loadActivity, type DaemonActivity } from "./activity.js";
import { loadConfig, loadRawState, loadState, syncStreamId, type WorkspaceConfig } from "./config.js";
import { credentialFailureMessage, loadCredentials, type CredentialLoadResult, type Credentials } from "./credentials.js";
import { currentWorkspaceId, daemonBindingStatus, readDaemonBindingRecord, readMergedDaemonLogTail } from "./daemon-control.js";
import { enrolledDeviceId, loadDevice } from "./e2ee-keystore.js";
import { loadMetrics, type SyncMetrics } from "./metrics.js";
import { promptConfirm } from "./prompt.js";
import { verifyAndParseManifest } from "./release-verify.js";
import { RBOX_VERSION } from "./version.js";
import { semverGt } from "./semver.js";
import { style } from "./style.js";
import { friendlyHttpError } from "./http-error.js";
import { buildAuthedRemote } from "./e2ee-client.js";
import type { E2eeRemote } from "./e2ee-remote.js";
import { readLockingHealth } from "./sync-mutex.js";
import { ResetCorruptionError } from "./reset-io.js";

const REPORT_CAP_BYTES = 512 * 1024;
const DAEMON_LOG_TAIL_BYTES = 64 * 1024;
const SECTION_STRING_CAP_BYTES = 2 * 1024;
const FETCH_TIMEOUT_MS = 3500;
const STALE_EXCLUDED = { excluded: "stale daemon binding" } as const;
const NOTICE =
  "this includes your daemon log tail, which contains file and folder names/paths from this workspace, your device id, and raw error messages; it is stored UNENCRYPTED for support for 30 days.";
const bunVersion = () => (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun ?? "unknown";
const GIT_DEFERRAL_REASONS = new Set([
  "local-edits", "local-index", "local-operation", "local-commits", "local-stash",
  "conflict", "git-busy", "worktree-ownership", "ignored-target", "unreadable",
  "artifact", "config", "containment", "unsupported", "other",
]);

type CheckName = "credentials" | "enrollment" | "device" | "daemon" | "remote" | "version" | "state" | "crypto" | "locking" | "git";

export interface DoctorCheck {
  ok: boolean;
  label: string;
  message: string;
  hint?: string;
  latencyMs?: number;
  status?: string;
  current?: string;
  latest?: string;
  pid?: number;
}

export type DoctorChecks = Record<CheckName, DoctorCheck> & { chain?: DoctorCheck };

export interface WorkspaceShape {
  fileCount: number;
  totalBytes: number;
}

type ExcludedSection = typeof STALE_EXCLUDED;
type DaemonLogSection = string | ExcludedSection;
type MetricsSection = Partial<SyncMetrics> & { truncated?: boolean; originalBytes?: number } | ExcludedSection;
type ActivitySection = Partial<DaemonActivity> & { truncated?: boolean; originalBytes?: number } | ExcludedSection;

export interface DiagnosticsBundle {
  version: string;
  platform: { os: string; arch: string };
  bunVersion: string;
  checks: DoctorChecks;
  daemonLogTail: DaemonLogSection;
  metrics: MetricsSection;
  activity: ActivitySection;
  workspaceShape: WorkspaceShape;
}

export interface DoctorContext {
  root: string;
  cfg: WorkspaceConfig;
  creds?: Credentials;
  credentialResult?: CredentialLoadResult;
  checks: DoctorChecks;
  workspaceShape: WorkspaceShape;
  daemonStale: boolean;
}

interface DoctorCmdOptions {
  report: boolean;
  yes: boolean;
  diagnostics?: boolean;
}

const rboxHome = () => path.join(process.env.RBOX_HOME || os.homedir(), ".rbox");

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function capString(s: string, maxBytes = SECTION_STRING_CAP_BYTES): { value: string; truncated: boolean; originalBytes: number } {
  const bytes = Buffer.from(s, "utf8");
  if (bytes.byteLength <= maxBytes) return { value: s, truncated: false, originalBytes: bytes.byteLength };
  return { value: bytes.subarray(0, maxBytes).toString("utf8"), truncated: true, originalBytes: bytes.byteLength };
}

function keepLastUtf8(s: string, maxBytes: number): string {
  const bytes = Buffer.from(s, "utf8");
  if (bytes.byteLength <= maxBytes) return s;
  return bytes.subarray(bytes.byteLength - maxBytes).toString("utf8");
}

function gitReasonOf(detail: string, fallback = "other"): string {
  const normalized = detail.toLowerCase().replace(/[ _]+/g, "-");
  for (const reason of GIT_DEFERRAL_REASONS) {
    if (normalized.includes(reason)) return reason;
  }
  if (/local edits|working (?:tree|files)|unstaged|porcelain/.test(detail.toLowerCase())) return "local-edits";
  if (/local index|\bstaged\b|\bindex\b/.test(detail.toLowerCase())) return "local-index";
  if (/operation|rebase|cherry-pick|sequencer|bisect|revert/.test(detail.toLowerCase())) return "local-operation";
  if (/local commits?|diverg|held refs?|\bheads?\b/.test(detail.toLowerCase())) return "local-commits";
  if (/stash/.test(detail.toLowerCase())) return "local-stash";
  if (/conflict/.test(detail.toLowerCase())) return "conflict";
  if (/\bbusy\b|lock/.test(detail.toLowerCase())) return "git-busy";
  if (/ownership|non-owned|does not own|outside workspace/.test(detail.toLowerCase())) return "worktree-ownership";
  if (/ignor/.test(detail.toLowerCase())) return "ignored-target";
  if (/unreadable|cannot read|could not read/.test(detail.toLowerCase())) return "unreadable";
  if (/artifact|bundle|op-state/.test(detail.toLowerCase())) return "artifact";
  if (/config/.test(detail.toLowerCase())) return "config";
  if (/containment|outside root/.test(detail.toLowerCase())) return "containment";
  if (/unsupported/.test(detail.toLowerCase())) return "unsupported";
  return fallback;
}

function classifyGitLogMessage(message: string): { text: string; key: string } | undefined {
  let klass: string;
  let reason = "other";
  let age = "-";
  let match: RegExpExecArray | null;

  if ((match = /^git deferred (\d+m|1h|1d|7d|14d|30d):\s+(.+?) on (?:branch .+|detached checkout|checkout unavailable) \(.+\)(?: \(working files changed since\))?$/.exec(message))) {
    klass = "deferred";
    age = match[1]!;
    reason = gitReasonOf(match[2]!);
  } else if ((match = /^git-sync deferred\s+[^:\r\n]+:\s*(.+)$/.exec(message))) {
    klass = "deferred";
    reason = gitReasonOf(match[1]!);
  } else if ((match = /^git-sync CONFLICT\s+(.+)$/.exec(message))) {
    klass = "conflict";
    reason = "conflict";
  } else if ((match = /^git-sync WARNING\s+[^:\r\n]+:\s*(.+)$/.exec(message))) {
    klass = "warning";
    reason = gitReasonOf(match[1]!);
  } else if ((match = /^git-sync config skipped\s+[^:\r\n]+:\s*(.+)$/.exec(message))) {
    klass = "config-skipped";
    reason = "config";
  } else if ((match = /^git-sync applied\s+(.+)$/.exec(message))) {
    klass = "applied";
    reason = /\(held refs:/.test(match[1]!) ? gitReasonOf(match[1]!, "local-commits") : "other";
  } else if ((match = /^git-sync removed\s+(.+)$/.exec(message))) {
    klass = "removed";
    reason = "other";
  } else if (/^git-sync: captured \d+(?: \(.+\))? · carried \d+ · skipped \d+(?: \(.*\))? · deferred \d+(?: \(.*\))? · removed \d+(?: \(.*\))?$/.test(message)) {
    klass = "summary";
    reason = "other";
  } else {
    return undefined;
  }

  const key = `git-sync ${klass} reason=${reason} age=${age}`;
  return { text: key, key };
}

/** Redact local Git forensics before diagnostics leave the machine. Git-family
 * lines are fail-closed: recognized forms become closed enums; all others and
 * any physical continuation of a timestamped Git message are omitted. */
export function redactGitLogLines(tail: string): string {
  const rows: Array<{ key: string; text: string }> = [];
  // A raw Git error can contain arbitrary newlines, including a forged daemon
  // timestamp. Once a Git record starts there is no trustworthy delimiter left
  // in this legacy text format: retain only later structurally recognized Git
  // records (which are rewritten), and drop all ordinary physical lines.
  let afterGitFamily = false;
  for (const line of tail.split(/\r?\n/)) {
    const stamped = /^(\d{4}-\d\d-\d\dT\S+Z)\s+(.*)$/.exec(line);
    const message = stamped ? stamped[2]! : line;
    const isGitFamily = message.startsWith("git-sync ") || message.startsWith("git-sync:") || message.startsWith("git deferred");
    const isLockFamily = message.startsWith("lock starved:");
    if (!isGitFamily && !isLockFamily) {
      if (!afterGitFamily) rows.push({ key: `raw\0${rows.length}`, text: line });
      continue;
    }
    afterGitFamily = true;
    if (isLockFamily) {
      const lock = /^lock starved: reason=(foreign|identity-drift|stale-owned|fence) age=(15m|1h|1d)$/.exec(message);
      if (lock) {
        const key = `lock starved: reason=${lock[1]} age=${lock[2]}`;
        rows.push({ key, text: key });
      }
      continue;
    }
    const classified = classifyGitLogMessage(message);
    if (classified) rows.push(classified);
  }

  const counts = new Map<string, number>();
  for (const row of rows) if (!row.key.startsWith("raw\0")) counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
  const emitted = new Set<string>();
  const output: string[] = [];
  for (const row of rows) {
    if (row.key.startsWith("raw\0")) {
      output.push(row.text);
      continue;
    }
    if (emitted.has(row.key)) continue;
    emitted.add(row.key);
    const count = counts.get(row.key) ?? 1;
    output.push(`${row.text}${count > 1 ? ` count=${count}` : ""}`);
  }
  return output.join("\n") + (tail.endsWith("\n") && output.length > 0 ? "\n" : "");
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<{ res: Response; latencyMs: number }> {
  const t0 = performance.now();
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return { res, latencyMs: Math.round(performance.now() - t0) };
}

async function checkCredentials(creds: Credentials | undefined): Promise<DoctorCheck> {
  if (!creds?.token) {
    return { ok: false, label: "credentials", message: "not logged in", hint: "run `rbox login`" };
  }
  try {
    const { res, latencyMs } = await fetchWithTimeout(`${creds.remoteUrl}/v1/account/status`, {
      headers: { authorization: `Bearer ${creds.token}` },
    });
    if (!res.ok) return { ok: false, label: "credentials", message: `token rejected (${res.status})`, hint: "run `rbox login` again", latencyMs };
    return { ok: true, label: "credentials", message: `authenticated (${latencyMs}ms)`, latencyMs };
  } catch {
    return { ok: false, label: "credentials", message: "could not verify token", hint: "check your network or run `rbox login` again" };
  }
}

async function checkEnrollment(creds: Credentials | undefined): Promise<DoctorCheck> {
  if (!creds?.accountId) return { ok: false, label: "encryption", message: "credential has no account id", hint: "run `rbox login` again" };
  try {
    const loaded = await loadDevice(creds.accountId);
    if (!loaded) return { ok: false, label: "encryption", message: "device key is missing", hint: "run `rbox pair` or `rbox key recover`" };
    if (!("secrets" in loaded)) return { ok: false, label: "encryption", message: "device key is present but master key is missing", hint: "run `rbox key recover` or sync once to self-heal if possible" };
    return { ok: true, label: "encryption", message: "device key and master key present" };
  } catch {
    return { ok: false, label: "encryption", message: "could not read local key material", hint: "check `~/.rbox/e2ee` permissions" };
  }
}

export async function checkDeviceIdentity(creds: Credentials | undefined, cfg: WorkspaceConfig): Promise<DoctorCheck> {
  // Intentionally stricter than the resolver: a workspace deliberately bound with --new-device/--device should surface as a dangling identity mismatch.
  const enrolled = await enrolledDeviceId(creds?.accountId);
  if (!enrolled) return { ok: true, label: "device", message: "no enrolled device identity" };
  if (cfg.deviceId !== enrolled) {
    return {
      ok: false,
      label: "device",
      message: `workspace uses ${cfg.deviceId}; this machine is ${enrolled}`,
      hint: "re-run `rbox init` / `rbox track` to rebind to this machine's device, or `rbox doctor` for details",
    };
  }
  return { ok: true, label: "device", message: `device ${enrolled}` };
}

function checkDaemon(root: string, cfg: WorkspaceConfig): { check: DoctorCheck; stale: boolean } {
  const binding = daemonBindingStatus(root, cfg.remoteWorkspaceId);
  if (binding.stale) {
    return {
      stale: true,
      check: {
        ok: false,
        label: "background sync",
        message: `running but bound to a different workspace${binding.alive.pid ? ` (pid ${binding.alive.pid})` : ""}`,
        hint: "run `rbox start` to rebind",
        status: "stale",
        ...(binding.alive.pid ? { pid: binding.alive.pid } : {}),
      },
    };
  }
  if (binding.alive.running) {
    return { stale: false, check: { ok: true, label: "background sync", message: `running (pid ${binding.alive.pid})`, status: "running", ...(binding.alive.pid ? { pid: binding.alive.pid } : {}) } };
  }
  return { stale: false, check: { ok: false, label: "background sync", message: "stopped", hint: "run `rbox start`", status: "stopped" } };
}

async function checkRemote(creds: Credentials | undefined, cfg: WorkspaceConfig): Promise<DoctorCheck> {
  const base = creds?.remoteUrl ?? cfg.remoteUrl;
  try {
    const { res, latencyMs } = await fetchWithTimeout(`${base}/health`);
    if (!res.ok) return { ok: false, label: "remote", message: `/health returned ${res.status}`, latencyMs };
    return { ok: true, label: "remote", message: `reachable (${latencyMs}ms)`, latencyMs };
  } catch {
    return { ok: false, label: "remote", message: "unreachable", hint: "check your network or RBOX_API" };
  }
}

async function checkVersion(creds: Credentials | undefined, cfg: WorkspaceConfig): Promise<DoctorCheck> {
  const base = creds?.remoteUrl ?? cfg.remoteUrl;
  try {
    const [manifest, sig] = await Promise.all([fetchWithTimeout(`${base}/version`), fetchWithTimeout(`${base}/version.sig`)]);
    if (!manifest.res.ok || !sig.res.ok) return { ok: false, label: "version", message: "could not fetch release manifest", current: RBOX_VERSION };
    const latest = verifyAndParseManifest(new Uint8Array(await manifest.res.arrayBuffer()), new Uint8Array(await sig.res.arrayBuffer())).version;
    if (semverGt(latest, RBOX_VERSION)) {
      return { ok: false, label: "version", message: `update available (${latest})`, hint: "run `rbox upgrade`", current: RBOX_VERSION, latest };
    }
    return { ok: true, label: "version", message: `up to date (${RBOX_VERSION})`, current: RBOX_VERSION, latest };
  } catch {
    return { ok: false, label: "version", message: "could not verify latest release", current: RBOX_VERSION };
  }
}

async function checkState(root: string, cfg: WorkspaceConfig): Promise<DoctorCheck> {
  const file = path.join(root, ".rbox", "state.json");
  try {
    const parsed = await loadRawState(root);
    if (!parsed) return { ok: true, label: "state", message: "no sync state yet" };
    const expected = syncStreamId(cfg);
    if (parsed.stream !== undefined && parsed.stream !== expected) {
      return { ok: false, label: "state", message: ".rbox/state.json belongs to a different stream", hint: "run `rbox status` for the local re-baseline warning" };
    }
    return { ok: true, label: "state", message: "state file parses and matches this stream" };
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (e instanceof ResetCorruptionError
      && message.includes(file)
      && (message.includes("malformed JSON") || message.includes("JSON nesting exceeded"))) {
      return { ok: false, label: "state", message: ".rbox/state.json is not valid JSON", hint: "inspect the file or delete it to intentionally re-baseline" };
    }
    return { ok: false, label: "state", message: "could not read .rbox/state.json" };
  }
}

export async function checkManifestChain(remote: Pick<E2eeRemote, "chainDiagnostic">): Promise<DoctorCheck> {
  try {
    const d = await remote.chainDiagnostic();
    return {
      ok: true,
      label: "manifest chain",
      message: `head ${d.sequence}; links ${d.links}/${MAX_MANIFEST_DELTA_CHAIN}; chainBytes ${d.chainBytes}; snapshotBytes ${d.snapshotBytes}${d.snapshotFetched === false ? " (not fetched)" : ""}`,
    };
  } catch (error) {
    if (error instanceof ManifestChainError) {
      return {
        ok: false,
        label: "manifest chain",
        message: `head ${error.head?.seq ?? "unknown"}: ${error.reason}; failing encrypted link ${error.failingLink ?? "head-level"}`,
        hint: "run `rbox recover` to inspect and repair the unreadable suffix",
      };
    }
    return { ok: false, label: "manifest chain", message: error instanceof Error ? error.message : String(error) };
  }
}

function checkCryptoWorkers(): DoctorCheck {
  const status = cryptoPoolStatus();
  if (status.state === "disabled") {
    return {
      ok: false,
      label: "crypto workers",
      message: `disabled: ${status.reason}`,
      hint: "worker pool unavailable; inline crypto fallback is active",
      status: "disabled",
    };
  }
  if (status.state === "off") {
    return { ok: true, label: "crypto workers", message: status.reason ?? "off", status: "off" };
  }
  return { ok: true, label: "crypto workers", message: `${status.state} (${status.workers} worker${status.workers === 1 ? "" : "s"})`, status: status.state };
}

async function checkGitCapability(root: string): Promise<DoctorCheck> {
  const capability = await checkoutTransactionCapability(root);
  const current = capability.version;
  switch (capability.status) {
    case "supported":
      return { ok: true, label: "git", message: `transactional symref-update supported${current ? ` (${current})` : ""}`, status: capability.status, ...(current ? { current } : {}) };
    case "git-missing":
      return { ok: false, label: "git", message: "Git is not installed", hint: "install Git >= 2.46", status: capability.status };
    case "version-unavailable":
      return { ok: false, label: "git", message: "Git version is unavailable", hint: "repair or upgrade Git to >= 2.46", status: capability.status };
    case "probe-failed":
      return { ok: false, label: "git", message: "transactional symref-update probe failed", hint: "retry after Git state settles", status: capability.status, ...(current ? { current } : {}) };
    case "unsupported":
      return { ok: false, label: "git", message: `needs Git >= 2.46 transactional symref-update${current ? `; found ${current}` : ""}`, hint: "upgrade Git to >= 2.46", status: capability.status, ...(current ? { current } : {}) };
  }
}

async function workspaceShape(root: string, cfg: WorkspaceConfig): Promise<WorkspaceShape> {
  const state = await loadState(root, syncStreamId(cfg));
  const matcher = buildIgnoreMatcher(root, {
    respectGitignore: cfg.respectGitignore === true,
    knownGitRepos: Object.keys(state.lastSyncedManifest.gitRepos ?? {}),
  });
  const shape: WorkspaceShape = { fileCount: 0, totalBytes: 0 };
  await addWorkspaceShape(root, "", matcher, shape);
  return shape;
}

async function addWorkspaceShape(root: string, relDir: string, matcher: IgnoreMatcher, shape: WorkspaceShape): Promise<void> {
  const absDir = relDir ? path.join(root, relDir) : root;
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
    if (ent.isDirectory() ? (matcher.prunes?.(`${rel}/`) ?? matcher.ignores(`${rel}/`)) : matcher.ignores(rel)) continue;
    const abs = path.join(root, rel);
    if (ent.isDirectory()) {
      await addWorkspaceShape(root, rel, matcher, shape);
      continue;
    }
    if (!ent.isFile() && !ent.isSymbolicLink()) continue;
    try {
      const st = await fsp.lstat(abs);
      shape.fileCount++;
      shape.totalBytes += st.size;
    } catch {
      /* best effort: shape is diagnostic, not correctness state */
    }
  }
}

async function checkLocking(root: string): Promise<DoctorCheck> {
  const health = await readLockingHealth(root);
  if (health.status === "ok") {
    return {
      ok: true,
      label: "locking",
      message: "ok (.rbox/state/sync.lock)",
      status: "ok",
    };
  }
  return {
    ok: false,
    label: "locking",
    message: `${health.reason} (.rbox/state/sync.lock)`,
    hint: health.status === "starved"
      ? "stop the current sync holder or retry after it exits"
      : "retry after host identity is available",
    status: health.status,
    current: health.reason,
  };
}

export async function collectDoctorContext(root: string): Promise<DoctorContext> {
  const rawCfg = await loadConfig(root);
  const loaded = await loadCredentials();
  const creds = loaded.state === "valid" ? loaded.credentials : undefined;
  const cfg = { ...rawCfg, remoteUrl: creds?.remoteUrl ?? rawCfg.remoteUrl };
  const daemon = checkDaemon(root, cfg);
  const [credentials, enrollment, device, remote, version, state, locking, git, shape, chain] = await Promise.all([
    loaded.state !== "valid" && loaded.state !== "absent"
      ? Promise.resolve({ ok: false, label: "credentials", message: `credential-degraded: ${credentialFailureMessage(loaded)}`, hint: "repair the credential source, then retry" })
      : checkCredentials(creds),
    checkEnrollment(creds),
    checkDeviceIdentity(creds, cfg),
    checkRemote(creds, cfg),
    checkVersion(creds, cfg),
    checkState(root, cfg),
    checkLocking(root),
    checkGitCapability(root),
    workspaceShape(root, cfg),
    buildAuthedRemote(root, Date.now, undefined, loaded).then((built) => checkManifestChain(built.remote)).catch((error: unknown) => ({
      ok: false, label: "manifest chain", message: error instanceof Error ? error.message : String(error),
    })),
  ]);
  return {
    root,
    cfg,
    creds,
    credentialResult: loaded,
    daemonStale: daemon.stale,
    workspaceShape: shape,
    checks: { credentials, enrollment, device, daemon: daemon.check, remote, version, state, crypto: checkCryptoWorkers(), locking, git, chain },
  };
}

async function daemonLogTail(root: string): Promise<string> {
  return readMergedDaemonLogTail(root, DAEMON_LOG_TAIL_BYTES);
}

function pickMetrics(m: SyncMetrics): MetricsSection {
  const out: Partial<SyncMetrics> = {
    syncs: Number.isFinite(m.syncs) ? Math.max(0, Math.trunc(m.syncs)) : 0,
    commitConflicts409: Number.isFinite(m.commitConflicts409) ? Math.max(0, Math.trunc(m.commitConflicts409)) : 0,
    fileConflicts: Number.isFinite(m.fileConflicts) ? Math.max(0, Math.trunc(m.fileConflicts)) : 0,
    lockStarved: Number.isFinite(m.lockStarved) ? Math.max(0, Math.trunc(m.lockStarved)) : 0,
  };
  if (typeof m.lastConflictAt === "string") {
    const capped = capString(m.lastConflictAt);
    out.lastConflictAt = capped.value;
    if (capped.truncated) return { ...out, truncated: true, originalBytes: capped.originalBytes };
  }
  return out;
}

function pickActivity(a: DaemonActivity | undefined): ActivitySection {
  if (!a) return {};
  let truncated = false;
  let originalBytes = 0;
  const cap = (s: string) => {
    const c = capString(s);
    truncated ||= c.truncated;
    originalBytes = Math.max(originalBytes, c.originalBytes);
    return c.value;
  };
  const out: ActivitySection = { at: cap(a.at) };
  if (a.lastPush) out.lastPush = { at: cap(a.lastPush.at), files: a.lastPush.files, sequence: a.lastPush.sequence };
  if (a.lastPull) out.lastPull = { at: cap(a.lastPull.at), writes: a.lastPull.writes, deletes: a.lastPull.deletes, conflicts: a.lastPull.conflicts };
  if (a.active) out.active = { at: cap(a.active.at), phase: a.active.phase, done: a.active.done, total: a.active.total };
  if (a.halt) out.halt = { at: cap(a.halt.at), reason: cap(a.halt.reason), count: a.halt.count, op: a.halt.op };
  if (truncated) {
    out.truncated = true;
    out.originalBytes = originalBytes;
  }
  return out;
}

export async function buildDiagnosticsBundle(ctx: DoctorContext): Promise<DiagnosticsBundle> {
  const sidecars = daemonOwnedSectionsExcluded(ctx)
    ? { daemonLogTail: STALE_EXCLUDED, metrics: STALE_EXCLUDED, activity: STALE_EXCLUDED }
    : {
        daemonLogTail: redactGitLogLines(await daemonLogTail(ctx.root)),
        metrics: pickMetrics(await loadMetrics(ctx.root)),
        activity: pickActivity(await loadActivity(ctx.root)),
      };
  return fitBundle({
    version: RBOX_VERSION,
    platform: { os: process.platform, arch: process.arch },
    bunVersion: bunVersion(),
    checks: ctx.checks,
    daemonLogTail: sidecars.daemonLogTail,
    metrics: sidecars.metrics,
    activity: sidecars.activity,
    workspaceShape: ctx.workspaceShape,
  });
}

function daemonOwnedSectionsExcluded(ctx: DoctorContext): boolean {
  if (ctx.daemonStale) return true;
  const binding = readDaemonBindingRecord(ctx.root);
  if (!binding.present) return false;
  const current = currentWorkspaceId(ctx.root) ?? ctx.cfg.remoteWorkspaceId;
  return binding.unreadable === true || binding.workspaceId !== current;
}

function fitBundle(bundle: DiagnosticsBundle): DiagnosticsBundle {
  let raw = JSON.stringify(bundle, null, 2);
  if (byteLen(raw) <= REPORT_CAP_BYTES) return bundle;
  if (typeof bundle.daemonLogTail !== "string") return bundle;
  const over = byteLen(raw) - REPORT_CAP_BYTES;
  const marker = "[rbox: daemon log tail truncated to fit diagnostics bundle]\n";
  const keepBytes = Math.max(0, byteLen(bundle.daemonLogTail) - over - byteLen(marker) - 1024);
  const next = { ...bundle, daemonLogTail: marker + keepLastUtf8(bundle.daemonLogTail, keepBytes) };
  raw = JSON.stringify(next, null, 2);
  if (byteLen(raw) <= REPORT_CAP_BYTES) return next;
  return { ...next, daemonLogTail: marker };
}

export function renderDoctor(checks: DoctorChecks): string {
  const lines = [`${style.bold("doctor")} — workspace health`];
  for (const key of ["credentials", "enrollment", "device", "daemon", "remote", "version", "state", "crypto", "locking", "git", "chain"] as const) {
    const c = checks[key];
    if (!c) continue;
    lines.push(`  ${c.ok ? style.sym.ok : style.sym.err} ${c.label}: ${c.message}`);
    if (!c.ok && c.hint) lines.push(`      ${style.dim("fix:")} ${c.hint}`);
  }
  return lines.join("\n");
}

export function diagnosticsUploadEnabled(opts: { diagnostics?: boolean }): boolean {
  // Diagnostics uploads intentionally ship disabled. A future `diagnostics:` key
  // in rbox.yml is reserved as the third enablement path when design 51 lands.
  return opts.diagnostics === true || process.env.RBOX_DIAGNOSTICS === "1";
}

async function writePreviewFile(preview: string): Promise<string> {
  const dir = rboxHome();
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `diagnostics-preview-${Date.now()}-${process.pid}.json`);
  const fh = await fsp.open(file, "wx", 0o600);
  try {
    await fh.writeFile(preview);
  } finally {
    await fh.close();
  }
  await fsp.chmod(file, 0o600).catch(() => {});
  return file;
}

export async function presentDiagnosticsPreview(bundle: DiagnosticsBundle, opts: { yes: boolean }): Promise<boolean> {
  const preview = JSON.stringify(bundle, null, 2);
  const bytes = byteLen(preview);
  if (process.stdin.isTTY !== true) {
    if (!opts.yes) throw new Error("diagnostics upload needs explicit consent; re-run with `rbox doctor --report --yes` in non-interactive mode");
    const file = await writePreviewFile(preview);
    console.log(NOTICE);
    console.log(`diagnostics preview written to ${file} (${bytes} bytes)`);
    return true;
  }

  console.log(NOTICE);
  console.log(`\n--- diagnostics preview (${bytes} bytes) ---`);
  process.stdout.write(preview + "\n");
  console.log("--- end diagnostics preview ---");
  if (opts.yes) return true;
  return promptConfirm({ message: "Upload this plaintext diagnostics report to rbox support?", default: false });
}

function printDiagnosticsPreview(bundle: DiagnosticsBundle): void {
  const preview = JSON.stringify(bundle, null, 2);
  console.log(`\n--- diagnostics preview (${byteLen(preview)} bytes) ---`);
  process.stdout.write(preview + "\n");
  console.log("--- end diagnostics preview ---");
}

async function uploadDiagnostics(loaded: CredentialLoadResult, bundle: DiagnosticsBundle): Promise<void> {
  if (loaded.state !== "valid") {
    if (loaded.state === "absent") throw new Error("not logged in — run `rbox login` before uploading diagnostics");
    throw new Error(credentialFailureMessage(loaded));
  }
  const creds = loaded.credentials;
  const body = JSON.stringify(bundle, null, 2);
  const res = await fetch(`${creds.remoteUrl}/v1/diagnostics`, {
    method: "POST",
    headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json" },
    body,
  });
  if (!res.ok) throw await friendlyHttpError(res, "diagnostics upload");
  const uploaded = (await res.json()) as { id: string; expiresAt: string };
  console.log(`report uploaded — reference ${uploaded.id} (auto-deletes ${uploaded.expiresAt.slice(0, 10)})`);
}

export async function doctorCmd(root: string, opts: DoctorCmdOptions): Promise<void> {
  if (opts.diagnostics === true && !opts.report) {
    throw new Error("--diagnostics uploads the support report — combine it with --report: rbox doctor --report --diagnostics");
  }
  const ctx = await collectDoctorContext(root);
  console.log(renderDoctor(ctx.checks));
  if (opts.report) {
    const bundle = await buildDiagnosticsBundle(ctx);
    if (diagnosticsUploadEnabled(opts)) {
      if (await presentDiagnosticsPreview(bundle, { yes: opts.yes })) {
        const loaded = ctx.credentialResult ?? (ctx.creds
          ? { state: "valid" as const, source: "disk" as const, credentials: { v: 1, ...ctx.creds }, legacy: false, extensions: {} }
          : { state: "absent" as const, path: "credentials.json" });
        await uploadDiagnostics(loaded, bundle);
      }
      else console.log("diagnostics report not uploaded");
    } else {
      printDiagnosticsPreview(bundle);
      console.log("nothing was uploaded — add --diagnostics to send this report to rbox support");
    }
  }
  if (Object.values(ctx.checks).some((c) => !c.ok)) process.exitCode = 1;
}
