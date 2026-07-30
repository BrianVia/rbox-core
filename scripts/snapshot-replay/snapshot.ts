/**
 * The snapshot child: a stability-checked copy of a REAL workspace's `.rbox`
 * into a sandbox, plus the minimum surrounding structure the migration's
 * evidence observes.
 *
 * It opens the real workspace READ-ONLY and takes no lock on it — the workspace
 * may be live with a daemon writing, and locking it to get consistency is
 * exactly what this harness must never do. Consistency comes from copying
 * twice and comparing: two consecutive copies that hash identically bracket a
 * window in which nothing under `.rbox` changed.
 *
 * Four things beyond the copy, each of them reported as a named fixup rather
 * than done quietly:
 *
 * 1. Repository stubs. `withStatePlaneLocks` derives its fence from the repos
 *    the legacy state names and REFUSES when one has no resolvable identity, so
 *    a state-only copy cannot be entered at all. Each named repo gets an empty
 *    `.git` DIRECTORY — never a pointer file, even where the real repo is one,
 *    because a faithful pointer would aim the fence's locks at the real
 *    repository outside the sandbox.
 * 2. The last-writer witness is re-anchored to the copy's inode. The witness
 *    pins `{dev, ino, mtimeMs}` of the document it describes, so ANY copy of a
 *    workspace fails admission with `barrier-witness-identity-drift`. The body
 *    hash is NOT rewritten: it is verified against the copied bytes, which is
 *    what proves the snapshot captured the witnessed document exactly.
 * 3. `workspace.json`'s recorded `rootPath` is repointed at the sandbox.
 * 4. Live lock artifacts are excluded. `state/sync.lock` names the real
 *    daemon's live pid; copying it would hand the replay a mutex that a running
 *    process appears to hold.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { repoRecordsForState, type SyncState } from "../../src/cli/sync-state-model.js";
import { RBOX_DIR } from "../../src/cli/workspace-config.js";
import { sandboxLayout, SNAPSHOT_EXCLUDES, type SnapshotReport } from "./layout.js";

const MAX_COPY_ATTEMPTS = 6;
const EXCLUDED_LOCKS = ["state/sync.lock", "state/git-lock-transactions"] as const;
const EXCLUDED = [...SNAPSHOT_EXCLUDES, ...EXCLUDED_LOCKS];

interface Entry { readonly rel: string; readonly kind: string; readonly bytes: number; readonly sha256: string }

function walk(root: string, rel = "", out: Entry[] = []): Entry[] {
  const dir = rel === "" ? root : path.join(root, rel);
  for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const childRel = rel === "" ? item.name : `${rel}/${item.name}`;
    const abs = path.join(root, childRel);
    if (item.isDirectory()) {
      out.push({ rel: childRel, kind: "dir", bytes: 0, sha256: "" });
      walk(root, childRel, out);
    } else if (item.isSymbolicLink()) {
      out.push({ rel: childRel, kind: "link", bytes: 0, sha256: fs.readlinkSync(abs) });
    } else if (item.isFile()) {
      const bytes = fs.readFileSync(abs);
      out.push({
        rel: childRel, kind: "file", bytes: bytes.byteLength,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      });
    } else {
      out.push({ rel: childRel, kind: "other", bytes: 0, sha256: "" });
    }
  }
  return out;
}

const fingerprint = (entries: readonly Entry[]): string =>
  entries.map((e) => `${e.rel}\0${e.kind}\0${e.bytes}\0${e.sha256}`).join("\n");

function copyRbox(sourceRbox: string, destRbox: string): void {
  fs.rmSync(destRbox, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destRbox), { recursive: true });
  fs.cpSync(sourceRbox, destRbox, {
    recursive: true, preserveTimestamps: true, dereference: false, force: true,
    filter: (src) => {
      const rel = path.relative(sourceRbox, src).split(path.sep).join("/");
      return rel === "" || !EXCLUDED.some((skip) => rel === skip || rel.startsWith(`${skip}/`));
    },
  });
}

/**
 * Copy, copy again, compare — until two consecutive copies are byte-identical.
 *
 * What this does and does not buy: the legacy document is published by
 * temp-and-rename, so any single read of it is one whole revision rather than a
 * tear. The double copy is what rules out a snapshot that straddles two
 * revisions ACROSS files, which is the failure a live daemon actually produces.
 */
function stableCopy(sourceRbox: string, stageRbox: string, keepRbox: string): { attempts: number; entries: Entry[] } {
  let previous: string | undefined;
  for (let attempt = 1; attempt <= MAX_COPY_ATTEMPTS; attempt++) {
    copyRbox(sourceRbox, attempt % 2 === 1 ? stageRbox : keepRbox);
    const entries = walk(attempt % 2 === 1 ? stageRbox : keepRbox);
    const current = fingerprint(entries);
    if (previous === current) {
      if (attempt % 2 === 1) {
        // The identical pair is stage+keep in the other order; the odd copy is
        // the newer one, so promote it.
        fs.rmSync(keepRbox, { recursive: true, force: true });
        fs.renameSync(stageRbox, keepRbox);
      }
      fs.rmSync(stageRbox, { recursive: true, force: true });
      return { attempts: attempt, entries };
    }
    previous = current;
  }
  throw new Error(`the source .rbox never held still for two consecutive copies (${MAX_COPY_ATTEMPTS} attempts)`);
}

/** Re-anchor the witness to the copy's inode, and verify its body hash against
 * the copied bytes first — a mismatch means the copy is not the document the
 * witness describes, which is a snapshot failure, not something to paper over. */
function reanchorWitness(ws: string, fixups: string[]): void {
  const file = path.join(ws, RBOX_DIR, "state", "last-writer.json");
  if (!fs.existsSync(file)) {
    fixups.push("last-writer witness absent in the source; left absent (admission will refuse `absent`)");
    return;
  }
  const witness = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const statePath = path.join(ws, RBOX_DIR, "state.json");
  const bytes = fs.readFileSync(statePath);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (witness.stateBodySha256 !== sha256 || witness.stateSizeBytes !== bytes.byteLength) {
    throw new Error("the copied legacy document is not the one the source's last-writer witness describes");
  }
  const stat = fs.statSync(statePath);
  const next = {
    ...witness,
    stateMtimeMs: Math.floor(stat.mtimeMs), stateDev: Number(stat.dev), stateIno: Number(stat.ino),
  };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  fixups.push(
    `last-writer witness re-anchored to the copy's inode (dev ${witness.stateDev}->${next.stateDev}, `
    + `ino ${witness.stateIno}->${next.stateIno}); body hash verified unchanged, writerVersion `
    + `${String(witness.writerVersion)} preserved`,
  );
}

function repointConfig(ws: string, fixups: string[]): void {
  const file = path.join(ws, RBOX_DIR, "workspace.json");
  if (!fs.existsSync(file)) return;
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  if (typeof config.rootPath !== "string" || config.rootPath === ws) return;
  const before = config.rootPath;
  fs.writeFileSync(file, `${JSON.stringify({ ...config, rootPath: ws }, null, 2)}\n`);
  fixups.push(`workspace.json rootPath repointed from ${before} to the sandbox`);
}

/** One empty `.git` directory per repo the legacy state names, so
 * `inspectInventory` can resolve an identity for each and the fence has
 * something inside the sandbox to lock. */
function stubRepos(source: string, ws: string, state: SyncState): { stubs: number; pointers: string[] } {
  const pointers: string[] = [];
  let stubs = 0;
  for (const relPath of Object.keys(repoRecordsForState(state)).sort()) {
    const dir = relPath === "." ? ws : path.join(ws, ...relPath.split("/"));
    const realGit = path.join(relPath === "." ? source : path.join(source, ...relPath.split("/")), ".git");
    const realKind = fs.lstatSync(realGit, { throwIfNoEntry: false });
    if (realKind?.isFile()) pointers.push(relPath);
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    stubs++;
  }
  return { stubs, pointers };
}

function argOf(flag: string): string {
  const index = process.argv.indexOf(flag);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`missing ${flag}`);
  return path.resolve(value);
}

const startedAt = Date.now();
const source = argOf("--source");
const layout = sandboxLayout(argOf("--sandbox"));
const sourceRbox = path.join(source, RBOX_DIR);
if (!fs.existsSync(path.join(sourceRbox, "state.json"))) {
  throw new Error(`${source} has no legacy ${RBOX_DIR}/state.json to snapshot`);
}

fs.mkdirSync(layout.ws, { recursive: true });
fs.mkdirSync(layout.home, { recursive: true });
fs.mkdirSync(layout.probe, { recursive: true });
fs.mkdirSync(path.dirname(layout.pristineState), { recursive: true });

const copied = stableCopy(sourceRbox, path.join(layout.stage, RBOX_DIR), path.join(layout.ws, RBOX_DIR));
const stateJson = path.join(layout.ws, RBOX_DIR, "state.json");
fs.copyFileSync(stateJson, layout.pristineState);

const fixups: string[] = [`excluded from the copy: ${EXCLUDED.join(", ")}`];
reanchorWitness(layout.ws, fixups);
repointConfig(layout.ws, fixups);
const state = JSON.parse(fs.readFileSync(layout.pristineState, "utf8")) as SyncState;
const { stubs, pointers } = stubRepos(source, layout.ws, state);
if (pointers.length) {
  fixups.push(`${pointers.length} repos whose real .git is a pointer file were stubbed as directories`);
}

const report: SnapshotReport = {
  source,
  sandbox: layout.root,
  copyAttempts: copied.attempts,
  excluded: EXCLUDED,
  bytes: copied.entries.reduce((sum, e) => sum + e.bytes, 0),
  files: copied.entries.filter((e) => e.kind === "file").length,
  stateJsonBytes: fs.statSync(stateJson).size,
  repoStubs: stubs,
  pointerRepos: pointers,
  fixups,
  elapsedMs: Date.now() - startedAt,
};
fs.writeFileSync(path.join(layout.probe, "snapshot.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
