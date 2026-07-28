import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIgnoreMatcher, checkoutTransactionCapability, cryptoPoolStatus, gitIdentity, gitIdentityKey, ManifestChainError, MAX_MANIFEST_DELTA_CHAIN, type IgnoreMatcher } from "../engine/index.js";
import { loadActivity, type DaemonActivity } from "./activity.js";
import { loadConfig, loadRawState, loadState, repoRecordsForState, syncStreamId, type WorkspaceConfig } from "./config.js";
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
import { pendingGenesisState } from "./genesis-enrollment.js";
import { GENESIS_PENDING_MESSAGE } from "./genesis-durable.js";
import type { E2eeRemote } from "./e2ee-remote.js";
import { readLockingHealth } from "./sync-mutex.js";
import { ResetCorruptionError } from "./reset-io.js";
import { inspectStateReserve, StateFormatTooNewError } from "./state-plane/index.js";
import { GIT_DEFERRAL_REASONS } from "./sync-state-model.js";
import { fetchWithDeadline, transferTimeoutMs } from "./remote/resilient.js";
import { listWorktrees } from "../engine/git/shared.js";
import { formatBinaryBytes } from "./quota-format.js";
import { emitJson } from "./json.js";

const REPORT_CAP_BYTES = 512 * 1024;
const DAEMON_LOG_TAIL_BYTES = 64 * 1024;
const SECTION_STRING_CAP_BYTES = 2 * 1024;
const FETCH_TIMEOUT_MS = 3500;
const STALE_EXCLUDED = { excluded: "stale daemon binding" } as const;
const NOTICE =
  "this includes your daemon log tail, which contains file and folder names/paths from this workspace, your device id, and raw error messages; it is stored UNENCRYPTED for support for 30 days.";
const bunVersion = () => (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun ?? "unknown";
const GIT_DEFERRAL_REASON_SET = new Set<string>(GIT_DEFERRAL_REASONS);

type CheckName = "credentials" | "enrollment" | "device" | "daemon" | "remote" | "version" | "state" | "crypto" | "locking" | "git";

export interface DoctorCheck {
  ok: boolean;
  /** The check could not reach a verdict (network/transport), as opposed to
   * proving a fault. Diagnosis must never report inconclusive as proven. */
  inconclusive?: true;
  label: string;
  message: string;
  hint?: string;
  latencyMs?: number;
  status?: string;
  current?: string;
  latest?: string;
  pid?: number;
}

export type DoctorChecks = Record<CheckName, DoctorCheck> & { chain?: DoctorCheck; reserve?: DoctorCheck };

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
  leftoverWorktrees: DiagnosticsLeftoverWorktreeSection;
  repoResidue: DiagnosticsRepoResidueSection;
}

export interface LocalOnlyLeftoverWorktreeEntry {
  branch?: string;
  path: string;
  prunable: boolean;
  holdsSyncedRef: boolean;
}

export interface DiagnosticsLeftoverWorktreeEntry {
  branch?: string;
  path?: never;
  prunable: boolean;
  holdsSyncedRef: boolean;
}

export interface LocalOnlyLeftoverWorktreeSection {
  count: number;
  entries: LocalOnlyLeftoverWorktreeEntry[];
}

export interface DiagnosticsLeftoverWorktreeSection {
  count: number;
  entries: DiagnosticsLeftoverWorktreeEntry[];
}

export type RepoResidueIdentityVerdict = "match" | "mismatch" | "unknown";

export interface LocalOnlyRepoResidueEntry {
  rel: string;
  path: string;
  gitPresent: boolean;
  rboxPresent: boolean;
  identity: RepoResidueIdentityVerdict;
}

export interface LocalOnlyQuarantineEntry {
  label: string;
  path: string;
  present: boolean;
  bytes?: number;
}

export interface LocalOnlyRepoResidueSection {
  count: number;
  entries: LocalOnlyRepoResidueEntry[];
  quarantine: LocalOnlyQuarantineEntry[];
  bytesMeasured: boolean;
}

export interface DiagnosticsRepoResidueSection {
  count: number;
  gitPresent: number;
  rboxPresent: number;
  identity: Record<RepoResidueIdentityVerdict, number>;
  quarantinePresent: number;
}

type Assert<T extends true> = T;
type _LocalWorktreesExcludedFromBundle = Assert<
  LocalOnlyLeftoverWorktreeSection extends DiagnosticsLeftoverWorktreeSection ? false : true
>;

export interface DoctorContext {
  root: string;
  cfg: WorkspaceConfig;
  creds?: Credentials;
  credentialResult?: CredentialLoadResult;
  checks: DoctorChecks;
  workspaceShape: WorkspaceShape;
  daemonStale: boolean;
  localOnly: {
    leftoverWorktrees: LocalOnlyLeftoverWorktreeSection;
    repoResidue?: LocalOnlyRepoResidueSection;
  };
  diagnostics: {
    leftoverWorktrees: DiagnosticsLeftoverWorktreeSection;
    repoResidue?: DiagnosticsRepoResidueSection;
  };
}

interface DoctorCmdOptions {
  report: boolean;
  yes: boolean;
  diagnostics?: boolean;
  residueBytes?: boolean;
  json?: boolean;
  now?: number;
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
  for (const reason of GIT_DEFERRAL_REASON_SET) {
    if (normalized.includes(reason)) return reason;
  }
  if (/local edits|working (?:tree|files)|unstaged|porcelain/.test(detail.toLowerCase())) return "local-edits";
  if (/local index|\bstaged\b|\bindex\b/.test(detail.toLowerCase())) return "local-index";
  if (/operation|rebase|cherry-pick|sequencer|bisect|revert/.test(detail.toLowerCase())) return "local-operation";
  if (/branch (?:was )?deleted here|deleted (?:local )?branch|finishing (?:a )?branch deletion/.test(detail.toLowerCase())) return "deletion-pending";
  if (/local commits?|diverg|held refs?|\bheads?\b/.test(detail.toLowerCase())) return "local-commits";
  if (/stash/.test(detail.toLowerCase())) return "local-stash";
  if (/conflict/.test(detail.toLowerCase())) return "conflict";
  if (/\bbusy\b|lock/.test(detail.toLowerCase())) return "git-busy";
  if (/ownership|non-owned|does not own|outside workspace/.test(detail.toLowerCase())) return "worktree-ownership";
  if (/ignor/.test(detail.toLowerCase())) return "ignored-target";
  if (/ref-read-unreadable|refs? (?:could not|cannot) be read/.test(detail.toLowerCase())) return "ref-read-unreadable";
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
  const res = await fetchWithDeadline(url, init, timeoutMs);
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
    // A 5xx is the server failing, not this token being refused. Only the
    // rejection statuses prove the credential itself is bad.
    if (res.status >= 500) {
      return { ok: false, inconclusive: true, label: "credentials", message: `could not verify token (server returned ${res.status})`, latencyMs };
    }
    if (!res.ok) return { ok: false, label: "credentials", message: `token rejected (${res.status})`, hint: "run `rbox login` again", latencyMs };
    return { ok: true, label: "credentials", message: `authenticated (${latencyMs}ms)`, latencyMs };
  } catch {
    return { ok: false, inconclusive: true, label: "credentials", message: "could not verify token", hint: "check your network or run `rbox login` again" };
  }
}

async function checkEnrollment(creds: Credentials | undefined): Promise<DoctorCheck> {
  if (!creds?.accountId) return { ok: false, label: "encryption", message: "credential has no account id", hint: "run `rbox login` again" };
  try {
    if(await pendingGenesisState(creds.accountId))return{ok:false,label:"encryption",message:"genesis enrollment is pending",hint:GENESIS_PENDING_MESSAGE};
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
    return { ok: false, inconclusive: true, label: "version", message: "could not verify latest release", current: RBOX_VERSION };
  }
}

async function checkState(root: string, cfg: WorkspaceConfig): Promise<DoctorCheck> {
  const file = path.join(root, ".rbox", "state.json");
  try {
    const parsed = await loadRawState(root);
    if (!parsed) return { ok: true, label: "state", message: "no sync state yet" };
    const expected = syncStreamId(cfg);
    if (parsed.stream !== undefined && parsed.stream !== expected) {
      return { ok: false, status: "stream-mismatch", label: "state", message: ".rbox/state.json belongs to a different stream", hint: "run `rbox status` for the local re-baseline warning" };
    }
    return { ok: true, label: "state", message: "state file parses and matches this stream" };
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (e instanceof StateFormatTooNewError) {
      return {
        ok: false, status: "format-too-new", label: "state",
        message: ".rbox/state.json was written by a newer version of rbox",
        hint: "run `rbox upgrade`; do not delete this file",
      };
    }
    if (e instanceof ResetCorruptionError
      && message.includes(file)
      && (message.includes("malformed JSON") || message.includes("JSON nesting exceeded"))) {
      return { ok: false, status: "malformed", label: "state", message: ".rbox/state.json is not valid JSON", hint: "inspect the file or delete it to intentionally re-baseline" };
    }
    return { ok: false, status: "unreadable", label: "state", message: "could not read .rbox/state.json" };
  }
}

/** The reserved 1 MiB of upgrade runway. Absent is normal (it is created by the
 * first state save); only a foreign occupant of the path is a finding, because
 * rbox will never adopt, shrink, or remove something it did not write. */
async function checkStateReserve(root: string, cfg: WorkspaceConfig): Promise<DoctorCheck> {
  try {
    const outcome = await inspectStateReserve(root, syncStreamId(cfg));
    if (outcome.status === "reserve-foreign") {
      return {
        ok: false, status: "reserve-foreign", label: "upgrade reserve",
        message: `.rbox/state/reserve-1mib.bin is not rbox's own reserved space (${outcome.detail})`,
        hint: "move that file aside yourself, then run `rbox doctor` again",
      };
    }
    if (outcome.status === "unavailable") {
      return { ok: true, label: "upgrade reserve", message: outcome.detail === "absent" ? "not reserved yet" : `not reserved yet (${outcome.detail})` };
    }
    return { ok: true, label: "upgrade reserve", message: "1 MiB reserved for future upgrades" };
  } catch {
    return { ok: true, inconclusive: true, label: "upgrade reserve", message: "could not check the reserved space" };
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
    // Only ManifestChainError establishes an unreadable chain. A timeout or any
    // other transport failure proves nothing about the uploaded history.
    return { ok: false, inconclusive: true, label: "manifest chain", message: error instanceof Error ? error.message : String(error) };
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

export async function collectLeftoverWorktrees(
  root: string,
  cfg: WorkspaceConfig,
): Promise<{
  localOnly: LocalOnlyLeftoverWorktreeSection;
  diagnostics: DiagnosticsLeftoverWorktreeSection;
}> {
  const state = await loadState(root, syncStreamId(cfg));
  const records = repoRecordsForState(state);
  const repos = [...new Set([
    ...Object.keys(state.lastSyncedManifest.gitRepos ?? {}),
    ...Object.keys(records),
  ])].sort();
  const byEntry = new Map<string, LocalOnlyLeftoverWorktreeEntry>();
  for (const rel of repos) {
    const repoDir = rel === "." ? root : path.join(root, rel);
    const self = await fsp.realpath(repoDir).catch(() => path.resolve(repoDir));
    const syncedRefs = new Set([
      ...Object.keys(state.lastSyncedManifest.gitRepos?.[rel]?.refs ?? {}),
      ...Object.keys(records[rel]?.base?.refs ?? {}),
      ...Object.keys(records[rel]?.pending?.refs ?? {}),
      ...Object.keys(records[rel]?.advertised?.refs ?? {}),
    ]);
    for (const entry of await listWorktrees(repoDir)) {
      const absolutePath = path.resolve(entry.path);
      const entryReal = await fsp.realpath(absolutePath).catch(() => absolutePath);
      if (entryReal === self) continue;
      const key = `${absolutePath}\0${entry.branch ?? ""}\0${entry.prunable ? "1" : "0"}`;
      const previous = byEntry.get(key);
      byEntry.set(key, {
        ...(entry.branch ? { branch: entry.branch } : {}),
        path: absolutePath,
        prunable: entry.prunable,
        holdsSyncedRef: previous?.holdsSyncedRef === true
          || (entry.branch !== undefined && syncedRefs.has(entry.branch)),
      });
    }
  }
  const entries = [...byEntry.values()].sort((a, b) =>
    `${a.path}\0${a.branch ?? ""}`.localeCompare(`${b.path}\0${b.branch ?? ""}`));
  return {
    localOnly: { count: entries.length, entries },
    diagnostics: {
      count: entries.length,
      entries: entries.map(({ branch, prunable, holdsSyncedRef }) => ({
        ...(branch ? { branch } : {}),
        prunable,
        holdsSyncedRef,
      })),
    },
  };
}

async function pathPresent(abs: string): Promise<boolean> {
  return fsp.lstat(abs).then(() => true, () => false);
}

async function allocatedBytes(abs: string): Promise<number> {
  let stat: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    stat = await fsp.lstat(abs);
  } catch {
    return 0;
  }
  const self = typeof stat.blocks === "number" ? stat.blocks * 512 : stat.size;
  if (!stat.isDirectory() || stat.isSymbolicLink()) return self;
  let entries: string[];
  try {
    entries = await fsp.readdir(abs);
  } catch {
    return self;
  }
  let total = self;
  for (const entry of entries) total += await allocatedBytes(path.join(abs, entry));
  return total;
}

export async function collectRepoResidue(
  root: string,
  cfg: WorkspaceConfig,
  options: { residueBytes?: boolean } = {},
): Promise<{
  localOnly: LocalOnlyRepoResidueSection;
  diagnostics: DiagnosticsRepoResidueSection;
}> {
  const state = await loadState(root, syncStreamId(cfg));
  const entries: LocalOnlyRepoResidueEntry[] = [];
  for (const [rel, remembered] of Object.entries(state.gitReposRemoved ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const repoDir = rel === "." ? root : path.join(root, rel);
    if (!await pathPresent(repoDir)) continue;
    const gitPresent = await pathPresent(path.join(repoDir, ".git"));
    const rboxPresent = await pathPresent(path.join(repoDir, ".rbox"));
    let identity: RepoResidueIdentityVerdict = "unknown";
    try {
      const live = await gitIdentity(repoDir);
      if (live) identity = gitIdentityKey(live) === remembered ? "match" : "mismatch";
    } catch {
      // An unreadable or no-longer-valid Git repository is informationally unknown.
    }
    entries.push({
      rel,
      path: path.resolve(repoDir),
      gitPresent,
      rboxPresent,
      identity,
    });
  }

  const quarantineCandidates = new Map<string, { label: string; path: string }>();
  const addQuarantine = (label: string, abs: string): void => {
    const resolved = path.resolve(abs);
    if (!quarantineCandidates.has(resolved)) quarantineCandidates.set(resolved, { label, path: resolved });
  };
  addQuarantine("workspace .rbox/git-quarantine", path.join(root, ".rbox", "git-quarantine"));
  const records = repoRecordsForState(state);
  const currentBaseRepos = [...new Set([
    ...Object.keys(state.lastSyncedManifest.gitRepos ?? {}),
    ...Object.entries(records).filter(([, record]) => record.base !== undefined).map(([rel]) => rel),
  ])].sort();
  for (const rel of currentBaseRepos) {
    const repoDir = rel === "." ? root : path.join(root, rel);
    addQuarantine(`${rel}/.rbox/git-quarantine`, path.join(repoDir, ".rbox", "git-quarantine"));
    addQuarantine(`${rel}/.rbox/git-conflicts`, path.join(repoDir, ".rbox", "git-conflicts"));
  }
  const quarantine: LocalOnlyQuarantineEntry[] = [];
  for (const candidate of quarantineCandidates.values()) {
    const present = await pathPresent(candidate.path);
    // Keep the workspace line even when absent; per-repo lines are useful only
    // when an artifact directory actually exists.
    if (!present && candidate.label !== "workspace .rbox/git-quarantine") continue;
    quarantine.push({
      ...candidate,
      present,
      ...(present && options.residueBytes ? { bytes: await allocatedBytes(candidate.path) } : {}),
    });
  }

  const identity: DiagnosticsRepoResidueSection["identity"] = { match: 0, mismatch: 0, unknown: 0 };
  for (const entry of entries) identity[entry.identity] += 1;
  const diagnostics: DiagnosticsRepoResidueSection = {
    count: entries.length,
    gitPresent: entries.filter((entry) => entry.gitPresent).length,
    rboxPresent: entries.filter((entry) => entry.rboxPresent).length,
    identity,
    quarantinePresent: quarantine.filter((entry) => entry.present).length,
  };
  return {
    localOnly: {
      count: entries.length,
      entries,
      quarantine,
      bytesMeasured: options.residueBytes === true,
    },
    diagnostics,
  };
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

export async function collectDoctorContext(
  root: string,
  options: { residueBytes?: boolean } = {},
): Promise<DoctorContext> {
  const rawCfg = await loadConfig(root);
  const loaded = await loadCredentials();
  const creds = loaded.state === "valid" ? loaded.credentials : undefined;
  const cfg = { ...rawCfg, remoteUrl: creds?.remoteUrl ?? rawCfg.remoteUrl };
  const daemon = checkDaemon(root, cfg);
  const [credentials, enrollment, device, remote, version, state, reserve, locking, git, shape, chain, leftoverWorktrees, repoResidue] = await Promise.all([
    loaded.state !== "valid" && loaded.state !== "absent"
      ? Promise.resolve({ ok: false, label: "credentials", message: `credential-degraded: ${credentialFailureMessage(loaded)}`, hint: "repair the credential source, then retry" })
      : checkCredentials(creds),
    checkEnrollment(creds),
    checkDeviceIdentity(creds, cfg),
    checkRemote(creds, cfg),
    checkVersion(creds, cfg),
    checkState(root, cfg),
    checkStateReserve(root, cfg),
    checkLocking(root),
    checkGitCapability(root),
    // An unreadable or foreign-stream state.json is exactly what `checkState`
    // exists to REPORT; letting its shape read abort the whole collection made
    // doctor unusable on the one workspace that needs it most.
    workspaceShape(root, cfg).catch(() => ({ fileCount: 0, totalBytes: 0 })),
    buildAuthedRemote(root, Date.now, undefined, loaded).then((built) => checkManifestChain(built.remote)).catch((error: unknown) => ({
      ok: false, label: "manifest chain", message: error instanceof Error ? error.message : String(error),
    })),
    collectLeftoverWorktrees(root, cfg).catch(() => ({
      localOnly: { count: 0, entries: [] },
      diagnostics: { count: 0, entries: [] },
    })),
    collectRepoResidue(root, cfg, options).catch(() => ({
      localOnly: {
        count: 0,
        entries: [],
        quarantine: [],
        bytesMeasured: options.residueBytes === true,
      },
      diagnostics: {
        count: 0,
        gitPresent: 0,
        rboxPresent: 0,
        identity: { match: 0, mismatch: 0, unknown: 0 },
        quarantinePresent: 0,
      },
    })),
  ]);
  return {
    root,
    cfg,
    creds,
    credentialResult: loaded,
    daemonStale: daemon.stale,
    workspaceShape: shape,
    checks: { credentials, enrollment, device, daemon: daemon.check, remote, version, state, crypto: checkCryptoWorkers(), locking, git, reserve, chain },
    localOnly: {
      leftoverWorktrees: leftoverWorktrees.localOnly,
      repoResidue: repoResidue.localOnly,
    },
    diagnostics: {
      leftoverWorktrees: leftoverWorktrees.diagnostics,
      repoResidue: repoResidue.diagnostics,
    },
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
    leftoverWorktrees: ctx.diagnostics.leftoverWorktrees,
    repoResidue: ctx.diagnostics.repoResidue ?? {
      count: 0,
      gitPresent: 0,
      rboxPresent: 0,
      identity: { match: 0, mismatch: 0, unknown: 0 },
      quarantinePresent: 0,
    },
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

export function renderDoctor(
  checks: DoctorChecks,
  localOnly?: DoctorContext["localOnly"],
): string {
  const lines = [`${style.bold("doctor")} — workspace health`];
  for (const key of ["credentials", "enrollment", "device", "daemon", "remote", "version", "state", "crypto", "locking", "git", "reserve", "chain"] as const) {
    const c = checks[key];
    if (!c) continue;
    lines.push(`  ${c.ok ? style.sym.ok : style.sym.err} ${c.label}: ${c.message}`);
    if (!c.ok && c.hint) lines.push(`      ${style.dim("fix:")} ${c.hint}`);
  }
  if (localOnly) {
    const worktrees = localOnly.leftoverWorktrees;
    lines.push(`  leftover worktrees: ${worktrees.count}`);
    for (const entry of worktrees.entries) {
      lines.push(
        `      branch ${entry.branch ?? "(detached)"} · ${entry.path} · prunable ${entry.prunable ? "yes" : "no"} · holds synced ref ${entry.holdsSyncedRef ? "yes" : "no"}`,
      );
    }
    const residue = localOnly.repoResidue;
    if (residue) {
      lines.push(`  repo residue: ${residue.count}`);
      for (const entry of residue.entries) {
        lines.push(
          `      left behind after '${entry.rel}' was removed on another machine — contains a local Git repository rbox will not delete. review it yourself before removing anything.`,
        );
        lines.push(
          `      ${entry.path} · .git ${entry.gitPresent ? "present" : "absent"} · .rbox ${entry.rboxPresent ? "present" : "absent"} · identity ${entry.identity}`,
        );
        lines.push(`      remove manually: rm -rf -- ${shellQuote(entry.path)}`);
      }
      lines.push("  quarantine residue:");
      for (const entry of residue.quarantine) {
        const detail = !entry.present
          ? "absent"
          : entry.bytes !== undefined
            ? `size on disk ${formatBinaryBytes(entry.bytes)}`
            : "present · size not measured (run `rbox doctor --residue-bytes`)";
        lines.push(`      ${entry.label}: ${detail}`);
      }
    }
  }
  return lines.join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
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
  printDiagnosticsPreview(preview);
  if (opts.yes) return true;
  return promptConfirm({ message: "Upload this plaintext diagnostics report to rbox support?", default: false });
}

function printDiagnosticsPreview(preview: string): void {
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
  // A diagnostics bundle is a variable-size upload (log tails can run to megabytes), so it
  // gets the canonical size-aware transfer deadline rather than the flat control budget.
  const res = await fetchWithDeadline(`${creds.remoteUrl}/v1/diagnostics`, {
    method: "POST",
    headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json" },
    body,
  }, transferTimeoutMs(byteLen(body)));
  if (!res.ok) throw await friendlyHttpError(res, "diagnostics upload");
  const uploaded = (await res.json()) as { id: string; expiresAt: string };
  console.log(`report uploaded — reference ${uploaded.id} (auto-deletes ${uploaded.expiresAt.slice(0, 10)})`);
}

export async function doctorCmd(root: string, opts: DoctorCmdOptions): Promise<void> {
  if (opts.diagnostics === true && !opts.report) {
    throw new Error("--diagnostics uploads the support report — combine it with --report: rbox doctor --report --diagnostics");
  }
  if (opts.json === true && opts.report) {
    throw new Error("--json prints the findings only — drop --report, or drop --json to build the support report");
  }
  const ctx = await collectDoctorContext(
    root,
    opts.residueBytes ? { residueBytes: true } : {},
  );
  const { readTriageInputs, renderWorkspaceTriage, triageWorkspace } = await import("./doctor-triage.js");
  const triage = triageWorkspace(await readTriageInputs(root, ctx.checks, opts.now));
  if (opts.json === true) {
    emitJson(triage);
    if (Object.values(ctx.checks).some((c) => !c.ok)) process.exitCode = 1;
    return;
  }
  for (const line of renderWorkspaceTriage(triage)) console.log(line);
  console.log("");
  console.log(renderDoctor(ctx.checks, ctx.localOnly));
  if (opts.report) {
    const bundle = await buildDiagnosticsBundle(ctx);
    if (diagnosticsUploadEnabled(opts)) {
      if (await presentDiagnosticsPreview(bundle, { yes: opts.yes })) {
        const loaded = ctx.credentialResult ?? (ctx.creds
          ? { state: "valid" as const, source: "disk" as const, credentials: { v: 1, ...ctx.creds }, legacy: false, extensions: {} }
          : { state: "absent" as const, path: "credentials.json" });
        if(loaded.state==="valid"&&loaded.credentials.accountId&&await pendingGenesisState(loaded.credentials.accountId))throw new Error(GENESIS_PENDING_MESSAGE);
        await uploadDiagnostics(loaded, bundle);
      }
      else console.log("diagnostics report not uploaded");
    } else {
      printDiagnosticsPreview(JSON.stringify(bundle, null, 2));
      console.log("nothing was uploaded — add --diagnostics to send this report to rbox support");
    }
  }
  if (Object.values(ctx.checks).some((c) => !c.ok)) process.exitCode = 1;
}
