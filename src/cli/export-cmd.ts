/**
 * `rbox export [--all | --workspace <id>] [--out <dir | *.tar.gz>]` — data takeout
 * for an E2EE product (design 65). "Give me all my files back."
 *
 * Because the server only ever holds ciphertext (design 12), export MUST run
 * client-side under the device keys. The whole tree is already reconstructible from
 * the network alone: `pull()` on a fresh root with an EMPTY_MANIFEST baseline writes
 * the entire decrypted tree. So export is that machinery pointed at a THROWAWAY
 * staging dir instead of a real binding (design 65 §3):
 *
 *   temp staging dir → saveConfig a synthetic e2ee/v1 config → buildAuthedRemote →
 *   pull (fresh baseline → every file is a `write`) → move everything EXCEPT `.rbox/`
 *   into the export subdir → discard staging.
 *
 * It creates NO durable binding (the staging config is deleted) and starts NO daemon.
 * The ONE intentional durable side effect is the per-device anti-rollback pin
 * advancing for each exported workspace (design 65 §3) — a true observation, kept.
 *
 * This file owns only the export-specific shell: enumerate workspaces, synthesize a
 * config, strip `.rbox`, stage-then-rename, the completion marker, and the tar/summary.
 * The hardened pull/reconcile/decrypt path is reused unchanged.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pull } from "./sync.js";
import { buildAuthedRemote, hasDevice } from "./e2ee-client.js";
import { findRoot, RBOX_DIR, saveConfig, type WorkspaceConfig } from "./config.js";
import { requireCredentials, type Credentials } from "./credentials.js";
import { fetchAccountWorkspaces, type AccountWorkspace } from "./workspace-picker.js";
import { accountHex16, defaultKitTargetDir, displayPath, localYmd } from "./recovery-kit.js";
import { progressLabel } from "./status-view.js";
import { writeFileAtomic } from "../engine/fsutil.js";
import { spinner } from "./spinner.js";
import { style } from "./style.js";

/** The completion marker (design 65 §2.6): its presence means a finished export;
 *  a crashed/interrupted export never renames its staging into place, so it never
 *  drops a marker — a half-finished export is detectable by its absence. */
export const MARKER_NAME = "rbox-export.json";

type PullProgress = (done: number, total: number, phase: "encrypt" | "upload" | "download") => void;

// ── pure naming (design 65 §2) ───────────────────────────────────────────────

/** Reduce an arbitrary workspace name to a single filesystem-safe path component.
 *  Anything outside `[A-Za-z0-9._-]` collapses to `-`; leading/trailing `-`/`.`
 *  are trimmed (no hidden dirs, no dangling separators); bounded length. May reduce
 *  to `""` (all-unsafe name) — the caller then falls back to the id-only form. */
export function sanitizeWorkspaceName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 64)
    .replace(/[-.]+$/, "");
}

/** The per-workspace export subdir name (design 65 §2, codex 2026-07-03 amendment):
 *  ALWAYS `<sanitized-name>-<workspaceId-first8>`, with the name part omitted when a
 *  workspace is unnamed (or sanitizes to empty). The id suffix is mandatory because
 *  workspace names are NOT unique — two workspaces both named `app` must NOT merge
 *  into one export dir. The export loop still fail-closes on the unlikely event that
 *  two selected workspaces map to the same short name. */
function workspaceIdBody8(workspaceId: string): string {
  const m = /^[A-Za-z]+_(.+)$/.exec(workspaceId);
  return (m?.[1] ?? workspaceId).slice(0, 8);
}

export function exportSubdirName(name: string | null | undefined, workspaceId: string): string {
  const id8 = workspaceIdBody8(workspaceId);
  const clean = name ? sanitizeWorkspaceName(name) : "";
  return clean ? `${clean}-${id8}` : id8;
}

/** The default export dir basename — the recovery-kit slug convention (design 58),
 *  `rbox-export-<acct16>-<YYYYMMDD>`, reusing the SAME account/date helpers. */
export function defaultExportDirName(accountId: string, now: Date): string {
  return `rbox-export-${accountHex16(accountId)}-${localYmd(now)}`;
}

/** The default absolute export dir: `~/Downloads` when it exists, else `$HOME`
 *  (never CREATE Downloads — headless Linux often lacks it), reusing design 58's
 *  `defaultKitTargetDir` verbatim. */
export async function defaultExportDir(accountId: string, now: Date, homeDir = os.homedir()): Promise<string> {
  return path.join(await defaultKitTargetDir(homeDir), defaultExportDirName(accountId, now));
}

/** Expand a leading `~` and resolve to an absolute path (for `--out`). */
function resolveUserPath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith(`~${path.sep}`) || p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

/** Marker path for a tarball export: beside the archive, `<name>.rbox-export.json`. */
function markerBesideTarball(tarball: string): string {
  return `${tarball.replace(/\.tar\.gz$/i, "")}.${MARKER_NAME}`;
}

type ExportTarget =
  | { mode: "dir"; finalDir: string }
  | { mode: "tar"; tarball: string; markerBeside: string };

/** Resolve where the export lands: `--out` overrides (a directory, or a `*.tar.gz`
 *  file → a single tarball), else the default dir under `~/Downloads`/`$HOME`. */
export function resolveExportTarget(out: string | undefined, defaultDir: string): ExportTarget {
  if (out) {
    const abs = resolveUserPath(out);
    if (abs.toLowerCase().endsWith(".tar.gz")) return { mode: "tar", tarball: abs, markerBeside: markerBesideTarball(abs) };
    return { mode: "dir", finalDir: abs };
  }
  return { mode: "dir", finalDir: defaultDir };
}

// ── the injectable core (design 09 style: seams for offline unit tests) ───────

export interface WorkspaceExportSummary {
  workspaceId: string;
  name: string | null;
  dir: string;
  files: number;
  bytes: number;
}

export interface ExportMarker {
  account: string;
  workspaces: WorkspaceExportSummary[];
  files: number;
  bytes: number;
  finishedAt: string;
}

export interface ExportResult {
  outPath: string;
  markerPath: string;
  marker: ExportMarker;
}

export interface ExportRequest {
  workspaceId?: string;
  out?: string;
}

/**
 * The seams the core turns on — production wires the real network/pull; tests inject
 * offline fakes so the disk-safety / staging / naming / marker logic is exercised
 * without a server. `enrolled` is pre-probed (`hasDevice`) so the not-enrolled
 * refusal can fail closed BEFORE any staging (export must never bind — design 65 §2.5).
 */
export interface ExportSeams {
  enrolled: boolean;
  homeDir: string;
  now(): Date;
  listWorkspaces(): Promise<AccountWorkspace[]>;
  pullWorkspace(stagingRoot: string, target: { workspaceId: string; projectId: string }, onProgress: PullProgress): Promise<void>;
  tarGzip(stageDir: string, tarball: string): Promise<void>;
  onProgress?(line: string): void;
}

async function refuseIfExists(p: string): Promise<void> {
  try {
    await fs.lstat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  throw new Error(`refusing to overwrite existing path: ${p} — move it aside or pass a different \`--out\`.`);
}

async function refuseInsideWorkspace(p: string): Promise<void> {
  const root = await findRoot(p);
  if (root) {
    throw new Error(`refusing to write export inside an rbox workspace (${root}) — choose a path outside synced folders.`);
  }
}

function overwriteRefusal(p: string): Error {
  return new Error(`refusing to overwrite existing path: ${p} — move it aside or pass a different \`--out\`.`);
}

/** Regular-file count + plaintext byte total under `dir` (the stripped export tree). */
async function countTree(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (d: string): Promise<void> => {
    for (const ent of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) await walk(p);
      else {
        files++;
        if (ent.isFile()) bytes += (await fs.lstat(p)).size;
      }
    }
  };
  await walk(dir);
  return { files, bytes };
}

/** Best-effort directory fsync so a rename publishes a durable tree (design 65 §2.6). */
async function fsyncDir(dir: string): Promise<void> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(dir, "r");
    await fh.sync();
  } catch {
    // Not every platform fsyncs a directory handle; durability of the entries
    // themselves is covered by pull's own atomic writes.
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function writeMarker(file: string, marker: ExportMarker): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(marker, null, 2)}\n`);
}

async function writeMarkerExclusive(file: string, marker: ExportMarker): Promise<void> {
  const tmp = path.join(path.dirname(file), `.rbox-export-marker-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(tmp, "wx");
    await fh.writeFile(`${JSON.stringify(marker, null, 2)}\n`);
    await fh.sync();
    await fh.close();
    fh = undefined;
    await fs.link(tmp, file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw overwriteRefusal(file);
    throw e;
  } finally {
    await fh?.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

async function publishFileNoOverwrite(tmpFile: string, finalFile: string): Promise<void> {
  try {
    await fs.link(tmpFile, finalFile);
    await fsyncDir(path.dirname(finalFile));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw overwriteRefusal(finalFile);
    throw e;
  } finally {
    await fs.rm(tmpFile, { force: true }).catch(() => {});
  }
}

/**
 * Export one-or-all workspaces to a directory tree or a gzipped tarball. Fails closed
 * on an existing target, materializes into a temp staging dir, and only renames into
 * place after the completion marker is written — so a crash leaves an unmarked,
 * discardable staging dir and never a half-finished export at the destination.
 */
export async function runExportCore(req: ExportRequest, accountId: string, seams: ExportSeams): Promise<ExportResult> {
  // Not-enrolled → refuse with the recover hint (design 65 §2.4), BEFORE any staging.
  if (!seams.enrolled) {
    throw new Error(
      "this machine isn't enrolled for encryption — run `rbox recover` (paste your 24-word recovery phrase), then re-run `rbox export`."
    );
  }

  const target = resolveExportTarget(req.out, await defaultExportDir(accountId, seams.now(), seams.homeDir));
  const finalArtifact = target.mode === "dir" ? target.finalDir : target.tarball;

  // Disk-safety (design 65 §2.6): refuse to overwrite. Checked before any work.
  await refuseIfExists(finalArtifact);
  if (target.mode === "tar") await refuseIfExists(target.markerBeside);
  await refuseInsideWorkspace(finalArtifact);

  let workspaces = await seams.listWorkspaces();
  if (req.workspaceId) {
    workspaces = workspaces.filter((w) => w.workspaceId === req.workspaceId);
    if (workspaces.length === 0) throw new Error(`no workspace \`${req.workspaceId}\` on this account.`);
  }
  if (workspaces.length === 0) throw new Error("this account has no workspaces to export.");
  const selected = workspaces.map((ws) => ({ ws, subName: exportSubdirName(ws.name, ws.workspaceId) }));
  const seenSubdirs = new Map<string, string>();
  for (const { ws, subName } of selected) {
    const prev = seenSubdirs.get(subName);
    if (prev) throw new Error(`export subdir collision: workspaces ${prev} and ${ws.workspaceId} both map to \`${subName}\`.`);
    seenSubdirs.set(subName, ws.workspaceId);
  }

  const parent = path.dirname(finalArtifact);
  await fs.mkdir(parent, { recursive: true });
  // Staging sits BESIDE the final artifact so the publishing rename is same-filesystem
  // (and therefore atomic). It is removed on every exit path (success or throw).
  const stageDir = path.join(parent, `.rbox-export-staging-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  await fs.mkdir(stageDir, { recursive: true });
  try {
    const summaries: WorkspaceExportSummary[] = [];
    let totalFiles = 0;
    let totalBytes = 0;
    for (const { ws, subName } of selected) {
      seams.onProgress?.(`exporting ${subName}`);
      // Pull materializes the plaintext tree PLUS a `.rbox/` (state + hashcache) into
      // this throwaway root (design 65 §3); we strip `.rbox/` in the move below.
      const wsStaging = path.join(stageDir, `.pull-${crypto.randomBytes(6).toString("hex")}`);
      await fs.mkdir(wsStaging, { recursive: true });
      await seams.pullWorkspace(wsStaging, { workspaceId: ws.workspaceId, projectId: ws.projectId }, (done, total, phase) =>
        seams.onProgress?.(`${subName}: ${progressLabel(phase, done, total)}`)
      );
      const subdir = path.join(stageDir, subName);
      await fs.mkdir(subdir, { recursive: true });
      for (const entry of await fs.readdir(wsStaging)) {
        if (entry === RBOX_DIR) continue; // strip metadata: a clean plain tree only
        await fs.rename(path.join(wsStaging, entry), path.join(subdir, entry));
      }
      await fs.rm(wsStaging, { recursive: true, force: true });
      const { files, bytes } = await countTree(subdir);
      totalFiles += files;
      totalBytes += bytes;
      summaries.push({ workspaceId: ws.workspaceId, name: ws.name, dir: subName, files, bytes });
    }

    const marker: ExportMarker = {
      account: accountId,
      workspaces: summaries,
      files: totalFiles,
      bytes: totalBytes,
      finishedAt: seams.now().toISOString(),
    };

    if (target.mode === "dir") {
      await writeMarker(path.join(stageDir, MARKER_NAME), marker);
      await fsyncDir(stageDir);
      await refuseIfExists(target.finalDir);
      await fs.rename(stageDir, target.finalDir);
      return { outPath: target.finalDir, markerPath: path.join(target.finalDir, MARKER_NAME), marker };
    }

    // Tarball: gzip the stripped tree to a temp archive, then rename into place; the
    // marker lands beside it. Stage-then-rename so a failed tar leaves no partial file.
    const tmpTar = path.join(parent, `.rbox-export-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tar.gz`);
    try {
      await seams.tarGzip(stageDir, tmpTar);
      await publishFileNoOverwrite(tmpTar, target.tarball);
    } catch (e) {
      await fs.rm(tmpTar, { force: true }).catch(() => {});
      throw e;
    }
    try {
      await writeMarkerExclusive(target.markerBeside, marker);
    } catch (e) {
      await fs.rm(target.tarball, { force: true }).catch(() => {});
      throw e;
    }
    await fsyncDir(parent);
    return { outPath: target.tarball, markerPath: target.markerBeside, marker };
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── production wiring ─────────────────────────────────────────────────────────

/** The real per-workspace mechanism (design 65 §3): a synthetic e2ee/v1 config in a
 *  throwaway staging root, then the SAME authed pull sync uses — fresh EMPTY_MANIFEST
 *  baseline, so reconcile emits a `write` for every file and the mass-delete guard
 *  never fires. Trash off (`trash:{days:0}`) so pull skips the trash tier. */
async function defaultPullWorkspace(
  stagingRoot: string,
  target: { workspaceId: string; projectId: string },
  creds: Credentials,
  onProgress: PullProgress
): Promise<void> {
  const synthetic: WorkspaceConfig = {
    schema: "e2ee/v1",
    remoteWorkspaceId: target.workspaceId,
    projectId: target.projectId,
    deviceId: creds.deviceId,
    rootPath: stagingRoot,
    remoteUrl: creds.remoteUrl,
    token: "",
    syncGit: true, // git repos rematerialize as real working repos (design 65 §3)
    trash: { days: 0 }, // throwaway staging needs no trash tier (persisted field, not trashConfig())
  };
  await saveConfig(stagingRoot, synthetic);
  const { cfg, deps } = await buildAuthedRemote(stagingRoot);
  deps.onProgress = onProgress;
  await pull(stagingRoot, cfg, deps);
}

/** Bun runtime accessor (typed off globalThis — the same shape runtime.ts uses, so
 *  the tsc build under `types:["node"]` stays clean without pulling in @types/bun). */
interface BunSpawn {
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}
const bunRuntime = (): {
  which(cmd: string): string | null;
  spawn(argv: string[], opts: { stdout: "ignore"; stderr: "pipe" }): BunSpawn;
} => (globalThis as unknown as { Bun: { which(c: string): string | null; spawn(a: string[], o: unknown): BunSpawn } }).Bun;

/** Shell out to the system `tar` (Bun has no built-in tar). Abort clearly if absent. */
async function systemTarGzip(stageDir: string, tarball: string): Promise<void> {
  const Bun = bunRuntime();
  const tar = Bun.which("tar");
  if (!tar) {
    throw new Error("`tar` is not on PATH — cannot build a `.tar.gz` export. Export to a directory instead (drop the `.tar.gz` from `--out`).");
  }
  // cwd = the staging tree; `.` archives the workspace subdirs with relative paths.
  const proc = Bun.spawn([tar, "-czf", tarball, "-C", stageDir, "."], { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = (await new Response(proc.stderr).text()).trim();
    throw new Error(`tar failed (exit ${code})${err ? `: ${err}` : ""}`);
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** CLI entry point for `rbox export`. */
export async function runExport(flags: Record<string, string>): Promise<void> {
  const all = flags.all === "true";
  const workspaceId = flags.workspace && flags.workspace !== "true" ? flags.workspace : undefined;
  if (flags.workspace === "true") throw new Error("`--workspace` needs a workspace id.");
  if (workspaceId && all) throw new Error("pass either `--workspace <id>` or `--all` (the default), not both.");
  if (flags.out === "true") throw new Error("`--out` needs a path (a directory, or a `*.tar.gz` file).");
  const out = flags.out && flags.out !== "true" ? flags.out : undefined;

  const creds = await requireCredentials();
  if (!creds.accountId) throw new Error("credential has no account — re-run `rbox login`.");
  const enrolled = await hasDevice(creds.accountId);

  const sp = spinner("exporting");
  const seams: ExportSeams = {
    enrolled,
    homeDir: os.homedir(),
    now: () => new Date(),
    listWorkspaces: () => fetchAccountWorkspaces(creds.remoteUrl, creds.token),
    pullWorkspace: (stagingRoot, target, onProgress) => defaultPullWorkspace(stagingRoot, target, creds, onProgress),
    tarGzip: systemTarGzip,
    onProgress: (line) => sp.update(line),
  };
  try {
    const res = await runExportCore({ workspaceId, out }, creds.accountId, seams);
    const n = res.marker.workspaces.length;
    sp.succeed(
      `exported ${n} workspace${n === 1 ? "" : "s"}, ${res.marker.files.toLocaleString("en-US")} files, ${formatBytes(res.marker.bytes)} ` +
        `${style.sym.arrow} ${style.cyan(displayPath(res.outPath))}`
    );
  } catch (e) {
    sp.fail("export failed");
    throw e;
  }
}
