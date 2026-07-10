import { Buffer } from "node:buffer";
import { isSafeRelPath, restoreEntryToPath } from "../engine/index.js";
import { openTrashBatch } from "../engine/trash.js";
import { buildAuthedRemote } from "./e2ee-client.js";
import { NeedsRebaselineError } from "./remote.js";
import { emitJson } from "./json.js";
import { style } from "./style.js";

/**
 * `rbox versions` / `rbox restore` under full E2EE (design 12 §15, D11 made real).
 *
 * Both route through `E2eeRemote`, which verifies the signed commit chain against
 * the trusted head and decrypts under each commit's own `keyEpoch` — the plaintext
 * `manifestAt` path is NEVER taken, and every failure is fail-closed (a tampered
 * chain, a missing key, or a sequence pruned past the retention window all throw).
 */

const DEFAULT_LIMIT = 50;
type BuildAuthedRemote = typeof buildAuthedRemote;

/** Normalize a user-supplied restore/versions path to the manifest's POSIX-relative
 *  form and reject anything unsafe (absolute, traversal, NUL/backslash). */
function toRelPath(input: string): string {
  const rel = input.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!isSafeRelPath(rel)) throw new Error(`unsafe or absolute path: '${input}' — use a workspace-relative path`);
  return rel;
}

/** Format an advisory server timestamp (ms) for display; em-dash when unknown. */
function fmtTime(ms: number | undefined): string {
  if (!ms) return style.dim("—");
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

export async function versionsCmd(
  root: string,
  pathArg: string | undefined,
  limit = DEFAULT_LIMIT,
  opts: { json?: boolean; buildAuthedRemote?: BuildAuthedRemote } = {}
): Promise<void> {
  const { remote } = await (opts.buildAuthedRemote ?? buildAuthedRemote)(root);

  if (pathArg) {
    const rel = toRelPath(pathArg);
    const [changes, times] = await Promise.all([remote.pathHistory(rel, limit), remote.advisoryTimes(limit).catch(() => new Map<number, number>())]);
    if (opts.json) {
      emitJson({ versions: changes.map((c) => ({ sequence: c.seq, committedAt: times.get(c.seq) ?? null, path: rel })) });
      return;
    }
    if (changes.length === 0) {
      console.log(`no changes to ${style.cyan(rel)} in the last ${limit} versions (or the file is unknown here)`);
      return;
    }
    console.log(`${style.bold("versions where")} ${style.cyan(rel)} ${style.bold("changed")} ${style.dim("(newest first)")}`);
    for (const c of changes) {
      const what = c.sha256 ? style.dim(c.sha256.slice(0, 12)) : style.yellow("(deleted)");
      console.log(`  @${style.cyan(String(c.seq))}  ${what}  ${style.dim(c.deviceId)}`);
    }
    console.log(style.dim(`\nrestore with:  rbox restore ${rel}@<seq>`));
    return;
  }

  // The verified chain listing and the advisory display timestamps are independent —
  // fetch them concurrently. Timestamps are best-effort (authenticity comes from the
  // signed chain, never the D1 mirror); a failure/lag just shows an em-dash.
  const [versions, times] = await Promise.all([remote.history(limit), remote.advisoryTimes(limit).catch(() => new Map<number, number>())]);
  if (opts.json) {
    emitJson({ versions: versions.map((v) => ({ sequence: v.seq, committedAt: times.get(v.seq) ?? null, path: null })) });
    return;
  }
  if (versions.length === 0) {
    console.log("no versions yet — push something first");
    return;
  }
  console.log(`${style.bold("versions")} ${style.dim("(newest first)")}`);
  for (const v of versions) {
    console.log(`  @${style.cyan(String(v.seq))}  ${fmtTime(times.get(v.seq))}  ${style.dim(v.deviceId)}`);
  }
  console.log(style.dim("\nrestore a file:  rbox restore <path>@<seq>"));
}

export async function restoreCmd(root: string, spec: string): Promise<void> {
  const at = spec.lastIndexOf("@");
  if (at < 1) throw new Error("usage: rbox restore <path>@<seq>  (e.g. rbox restore src/app.ts@3)");
  const rel = toRelPath(spec.slice(0, at));
  const seq = Number(spec.slice(at + 1));
  if (!Number.isInteger(seq) || seq < 1) throw new Error(`bad version sequence in '${spec}' — expected a positive integer after '@'`);

  const { remote } = await buildAuthedRemote(root);

  let manifest;
  let kek: Uint8Array;
  try {
    ({ manifest, kek } = await remote.manifestAtSeq(seq));
  } catch (e) {
    if (e instanceof NeedsRebaselineError) {
      throw new Error(`version @${seq} has aged out of your plan's retention window — it can no longer be restored.`);
    }
    throw e;
  }

  const entry = manifest.files.find((f) => f.path === rel);
  if (!entry) throw new Error(`'${rel}' did not exist at version @${seq} — nothing to restore.`);
  if (entry.type === "file" && !entry.encSha) {
    throw new Error("refusing to restore: file entry has no ciphertext address (encSha) — workspace is not E2EE-consistent.");
  }

  const batch = openTrashBatch(root);
  let previousCopyTrashed = false;
  try {
    ({ previousCopyTrashed } = await restoreEntryToPath(root, entry, remote.blobStore(), Buffer.from(kek), { trash: batch }));
  } finally {
    await batch.finish();
  }
  console.log(`${style.green("restored")} ${style.cyan(rel)} ${style.dim("←")} version @${style.cyan(String(seq))}`);
  if (previousCopyTrashed) {
    console.log(style.dim(`previous copy of ${rel} moved to the local trash — undo with: rbox trash restore ${rel}`));
  }
  console.log(style.dim("(written to disk as a local change — run `rbox push`/`rbox sync` to publish it as a new version)"));
}
