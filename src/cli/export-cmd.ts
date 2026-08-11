import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pull } from "./sync.js";
import { assertNoPendingGenesis, buildAuthedRemote, hasDevice } from "./e2ee-client.js";
import { findRoot, RBOX_DIR, saveConfig, type WorkspaceConfig } from "./config.js";
import { requireCredentials, type Credentials } from "./credentials.js";
import { fetchAccountWorkspaces, type AccountWorkspace } from "./workspace-picker.js";
import { accountHex16, defaultKitTargetDir, displayPath, localYmd } from "./recovery-kit.js";
import { progressLabel } from "./status-view.js";
import type { TransferProgress } from "./transfer-progress.js";
import { writeFileAtomic } from "../engine/fsutil.js";
import { spinner } from "./spinner.js";
import { style } from "./style.js";

const MARKER_NAME = "rbox-export.json";

type PullProgress = TransferProgress;

function sanitizeWorkspaceName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 64)
    .replace(/[-.]+$/, "");
}

function workspaceIdBody8(workspaceId: string): string {
  const m = /^[A-Za-z]+_(.+)$/.exec(workspaceId);
  return (m?.[1] ?? workspaceId).slice(0, 8);
}

function exportSubdirName(name: string | null | undefined, workspaceId: string): string {
  const id8 = workspaceIdBody8(workspaceId);
  const clean = name ? sanitizeWorkspaceName(name) : "";
  return clean ? `${clean}-${id8}` : id8;
}

function defaultExportDirName(accountId: string, now: Date): string {
  return `rbox-export-${accountHex16(accountId)}-${localYmd(now)}`;
}

async function defaultExportDir(accountId: string, now: Date, homeDir = os.homedir()): Promise<string> {
  return path.join(await defaultKitTargetDir(homeDir), defaultExportDirName(accountId, now));
}

function resolveUserPath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith(`~${path.sep}`) || p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

function markerBesideTarball(tarball: string): string {
  return `${tarball.replace(/\.tar\.gz$/i, "")}.${MARKER_NAME}`;
}

type ExportTarget =
  | { mode: "dir"; finalDir: string }
  | { mode: "tar"; tarball: string; markerBeside: string };

function resolveExportTarget(out: string | undefined, defaultDir: string): ExportTarget {
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

// Injectable boundary for production IO and offline disk-safety tests.
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
  throw overwriteRefusal(p);
}

async function refuseInsideWorkspace(p: string): Promise<void> {
  const root = await findRoot(p);
  if (root) {
    throw new Error(`refusing to export inside an rbox workspace: ${root}`);
  }
}

function overwriteRefusal(p: string): Error {
  return new Error(`refusing to overwrite: ${p}`);
}

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
    // Hard-link publish fails with EEXIST, so the marker never overwrites.
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
    // Hard-link publish gives no-overwrite semantics for tarballs; rename would replace.
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
 * Export workspaces to a directory tree or tarball.
 * Directory exports write the marker before the final rename; no marker means incomplete.
 */
export async function runExportCore(req: ExportRequest, accountId: string, seams: ExportSeams): Promise<ExportResult> {
  if (!seams.enrolled) {
    throw new Error("encryption key missing on this machine; run `rbox key recover`, then retry.");
  }

  const target = resolveExportTarget(req.out, await defaultExportDir(accountId, seams.now(), seams.homeDir));
  const finalArtifact = target.mode === "dir" ? target.finalDir : target.tarball;

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
  // Fail closed rather than merge two workspaces into one export directory.
  const seenSubdirs = new Map<string, string>();
  for (const { ws, subName } of selected) {
    const prev = seenSubdirs.get(subName);
    if (prev) throw new Error(`export subdir collision: workspaces ${prev} and ${ws.workspaceId} both map to \`${subName}\`.`);
    seenSubdirs.set(subName, ws.workspaceId);
  }

  const parent = path.dirname(finalArtifact);
  await fs.mkdir(parent, { recursive: true });
  // Same-directory staging keeps final publication atomic.
  const stageDir = path.join(parent, `.rbox-export-staging-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  await fs.mkdir(stageDir, { recursive: true });
  try {
    const summaries: WorkspaceExportSummary[] = [];
    let totalFiles = 0;
    let totalBytes = 0;
    for (const { ws, subName } of selected) {
      seams.onProgress?.(`exporting ${subName}`);
      const wsStaging = path.join(stageDir, `.pull-${crypto.randomBytes(6).toString("hex")}`);
      await fs.mkdir(wsStaging, { recursive: true });
      await seams.pullWorkspace(wsStaging, { workspaceId: ws.workspaceId, projectId: ws.projectId }, (done, total, phase, detail, bytes) =>
        seams.onProgress?.(`${subName}: ${progressLabel(phase, done, total, detail, bytes)}`)
      );
      const subdir = path.join(stageDir, subName);
      await fs.mkdir(subdir, { recursive: true });
      // rename moves symlinks as links; it does not follow them out of staging.
      for (const entry of await fs.readdir(wsStaging)) {
        if (entry === RBOX_DIR) continue;
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
      // Marker-before-rename: a published directory is complete.
      await writeMarker(path.join(stageDir, MARKER_NAME), marker);
      await fsyncDir(stageDir);
      await refuseIfExists(target.finalDir);
      await fs.rename(stageDir, target.finalDir);
      return { outPath: target.finalDir, markerPath: path.join(target.finalDir, MARKER_NAME), marker };
    }

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

interface EphemeralExportPolicy {
  syncGit: true;
  git: { incremental: true };
  respectGitignore: false;
  noDrift: false;
  trash: { days: 0; maxBytes: 2147483648 };
}

const EPHEMERAL_EXPORT_POLICY: EphemeralExportPolicy = {
  syncGit: true,
  git: { incremental: true },
  respectGitignore: false,
  noDrift: false,
  trash: { days: 0, maxBytes: 2147483648 },
};

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
    ...EPHEMERAL_EXPORT_POLICY,
  };
  await saveConfig(stagingRoot, synthetic);
  const { cfg, deps } = await buildAuthedRemote(stagingRoot);
  deps.onProgress = onProgress;
  // Design 93 §6 explicit mutex exemption: stagingRoot is a unique, ephemeral,
  // process-private export tree. It cannot mutate a live workspace tree/state and
  // is removed or atomically published after this pull.
  await pull(stagingRoot, cfg, deps);
}

interface BunSpawn {
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}
const bunRuntime = (): {
  which(cmd: string): string | null;
  spawn(argv: string[], opts: { stdout: "ignore"; stderr: "pipe" }): BunSpawn;
} => (globalThis as unknown as { Bun: { which(c: string): string | null; spawn(a: string[], o: unknown): BunSpawn } }).Bun;

async function systemTarGzip(stageDir: string, tarball: string): Promise<void> {
  const Bun = bunRuntime();
  const tar = Bun.which("tar");
  if (!tar) {
    throw new Error("`tar` not found; export to a directory or install tar.");
  }
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

export async function runExport(flags: Record<string, string>): Promise<void> {
  const all = flags.all === "true";
  const workspaceId = flags.workspace && flags.workspace !== "true" ? flags.workspace : undefined;
  if (flags.workspace === "true") throw new Error("`--workspace` needs a workspace id.");
  if (workspaceId && all) throw new Error("use `--workspace <id>` or `--all`, not both.");
  if (flags.out === "true") throw new Error("`--out` needs a directory or .tar.gz path.");
  const out = flags.out && flags.out !== "true" ? flags.out : undefined;

  const creds = await requireCredentials();
  if (!creds.accountId) throw new Error("credential has no account; run `rbox login`.");
  await assertNoPendingGenesis(creds.accountId);
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
