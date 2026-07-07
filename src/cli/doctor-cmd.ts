import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIgnoreMatcher, type IgnoreMatcher } from "../engine/index.js";
import { loadActivity, type DaemonActivity } from "./activity.js";
import { loadConfig, loadState, syncStreamId, type WorkspaceConfig } from "./config.js";
import { loadCredentials, type Credentials } from "./credentials.js";
import { currentWorkspaceId, daemonBindingStatus, daemonLogPaths, readDaemonBindingRecord } from "./daemon-control.js";
import { loadDevice } from "./e2ee-keystore.js";
import { loadMetrics, type SyncMetrics } from "./metrics.js";
import { promptConfirm } from "./prompt.js";
import { verifyAndParseManifest } from "./upgrade-cmd.js";
import { RBOX_VERSION } from "./version.js";
import { semverGt } from "./semver.js";
import { style } from "./style.js";

const REPORT_CAP_BYTES = 512 * 1024;
const DAEMON_LOG_TAIL_BYTES = 64 * 1024;
const SECTION_STRING_CAP_BYTES = 2 * 1024;
const FETCH_TIMEOUT_MS = 3500;
const STALE_EXCLUDED = { excluded: "stale daemon binding" } as const;
export const DIAGNOSTICS_UPLOAD_DISABLED_MESSAGE =
  "diagnostics upload is off by default; re-run with --diagnostics (or set RBOX_DIAGNOSTICS=1) to enable for this invocation";
const NOTICE =
  "this includes your daemon log tail, which contains file and folder names/paths from this workspace, your device id, and raw error messages; it is stored UNENCRYPTED for support for 30 days.";
const bunVersion = () => (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun ?? "unknown";

type CheckName = "credentials" | "enrollment" | "daemon" | "remote" | "version" | "state";

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

export type DoctorChecks = Record<CheckName, DoctorCheck>;

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

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<{ res: Response; latencyMs: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return { res, latencyMs: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
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
    if (!loaded) return { ok: false, label: "encryption", message: "device key is missing", hint: "run `rbox pair` or `rbox recover`" };
    if (!("secrets" in loaded)) return { ok: false, label: "encryption", message: "device key is present but master key is missing", hint: "run `rbox recover` or sync once to self-heal if possible" };
    return { ok: true, label: "encryption", message: "device key and master key present" };
  } catch {
    return { ok: false, label: "encryption", message: "could not read local key material", hint: "check `~/.rbox/e2ee` permissions" };
  }
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
    const raw = await fsp.readFile(file, "utf8");
    let parsed: { stream?: unknown };
    try {
      parsed = JSON.parse(raw) as { stream?: unknown };
    } catch {
      return { ok: false, label: "state", message: ".rbox/state.json is not valid JSON", hint: "inspect the file or delete it to intentionally re-baseline" };
    }
    const expected = syncStreamId(cfg);
    if (parsed.stream !== undefined && parsed.stream !== expected) {
      return { ok: false, label: "state", message: ".rbox/state.json belongs to a different stream", hint: "run `rbox status` for the local re-baseline warning" };
    }
    return { ok: true, label: "state", message: "state file parses and matches this stream" };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, label: "state", message: "no sync state yet" };
    return { ok: false, label: "state", message: "could not read .rbox/state.json" };
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

export async function collectDoctorContext(root: string): Promise<DoctorContext> {
  const rawCfg = await loadConfig(root);
  const creds = await loadCredentials();
  const cfg = { ...rawCfg, remoteUrl: creds?.remoteUrl ?? rawCfg.remoteUrl };
  const daemon = checkDaemon(root, cfg);
  const [credentials, enrollment, remote, version, state, shape] = await Promise.all([
    checkCredentials(creds),
    checkEnrollment(creds),
    checkRemote(creds, cfg),
    checkVersion(creds, cfg),
    checkState(root, cfg),
    workspaceShape(root, cfg),
  ]);
  return {
    root,
    cfg,
    creds,
    daemonStale: daemon.stale,
    workspaceShape: shape,
    checks: { credentials, enrollment, daemon: daemon.check, remote, version, state },
  };
}

async function readTailBytes(file: string, maxBytes: number): Promise<string | undefined> {
  try {
    const fd = await fsp.open(file, "r");
    try {
      const { size } = await fd.stat();
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, size - len);
      return buf.toString("utf8");
    } finally {
      await fd.close();
    }
  } catch {
    return undefined;
  }
}

async function daemonLogTail(root: string): Promise<string> {
  const paths = daemonLogPaths(root);
  return (await readTailBytes(paths.primary, DAEMON_LOG_TAIL_BYTES)) ?? (await readTailBytes(paths.legacy, DAEMON_LOG_TAIL_BYTES)) ?? "";
}

function pickMetrics(m: SyncMetrics): MetricsSection {
  const out: Partial<SyncMetrics> = {
    syncs: Number.isFinite(m.syncs) ? Math.max(0, Math.trunc(m.syncs)) : 0,
    commitConflicts409: Number.isFinite(m.commitConflicts409) ? Math.max(0, Math.trunc(m.commitConflicts409)) : 0,
    fileConflicts: Number.isFinite(m.fileConflicts) ? Math.max(0, Math.trunc(m.fileConflicts)) : 0,
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
        daemonLogTail: await daemonLogTail(ctx.root),
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
  for (const key of ["credentials", "enrollment", "daemon", "remote", "version", "state"] as const) {
    const c = checks[key];
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

export function refuseDisabledDiagnosticsUpload(opts: { report: boolean; diagnostics?: boolean }): boolean {
  if (!opts.report || diagnosticsUploadEnabled(opts)) return false;
  console.log(DIAGNOSTICS_UPLOAD_DISABLED_MESSAGE);
  process.exitCode = 1;
  return true;
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

async function uploadDiagnostics(creds: Credentials | undefined, bundle: DiagnosticsBundle): Promise<void> {
  if (!creds?.token) throw new Error("not logged in — run `rbox login` before uploading diagnostics");
  const body = JSON.stringify(bundle, null, 2);
  const res = await fetch(`${creds.remoteUrl}/v1/diagnostics`, {
    method: "POST",
    headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`diagnostics upload failed: ${res.status} ${await res.text()}`);
  const uploaded = (await res.json()) as { id: string; expiresAt: string };
  console.log(`report uploaded — reference ${uploaded.id} (auto-deletes ${uploaded.expiresAt.slice(0, 10)})`);
}

export async function doctorCmd(root: string, opts: DoctorCmdOptions): Promise<void> {
  if (refuseDisabledDiagnosticsUpload(opts)) return;
  const ctx = await collectDoctorContext(root);
  console.log(renderDoctor(ctx.checks));
  if (opts.report) {
    const bundle = await buildDiagnosticsBundle(ctx);
    if (await presentDiagnosticsPreview(bundle, { yes: opts.yes })) await uploadDiagnostics(ctx.creds, bundle);
    else console.log("diagnostics report not uploaded");
  }
  if (Object.values(ctx.checks).some((c) => !c.ok)) process.exitCode = 1;
}
