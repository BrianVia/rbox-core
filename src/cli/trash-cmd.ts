/**
 * `rbox trash` (design 50 §2): the user-facing surface over the local trash tier —
 * the recoverable-delete net the pull writer moves bytes into instead of `fs.rm`.
 *   list                          — what's recoverable, newest batch first
 *   restore <path> [--batch <n>]  — rename it back (collision → visible conflict copy)
 *   empty                         — permanently free everything eligible
 * Presentation only; all trash mechanics live in the engine's frozen trash module.
 */
import { listTrash, pruneTrash, restoreFromTrash } from "../engine/trash.js";
import { humanBytes } from "./status-view/text.js";
import { emitJson } from "./json.js";
import { confirmDestructive } from "./prompt.js";
import { workspaceRelPath } from "./rbox-paths.js";
import { fail, style } from "./style.js";

export async function trashCmd(root: string, positional: string[], flags: Record<string, string>): Promise<void> {
  const sub = positional[0] ?? "list";
  if (sub === "list") {
    await trashList(root, flags.json === "true");
  } else if (sub === "restore") {
    await trashRestore(root, positional[1], flags.batch);
  } else if (sub === "empty") {
    await trashEmpty(root, flags.yes === "true");
  } else {
    fail("usage: rbox trash <list | restore <path> [--batch <name>] | empty> [--path <dir>]");
  }
}

function deletedAtFromBatch(batch: string): string | null {
  const m = batch.match(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

async function trashList(root: string, json = false): Promise<void> {
  const entries = await listTrash(root);
  if (json) {
    emitJson({
      entries: entries.map((e) => ({
        path: e.path,
        deletedAt: deletedAtFromBatch(e.batch),
        size: e.bytes,
        batch: e.batch || null,
      })),
      totalBytes: entries.reduce((n, e) => n + e.bytes, 0),
    });
    return;
  }
  if (entries.length === 0) {
    console.log(style.dim("trash is empty — nothing to recover"));
    return;
  }
  const totalBytes = entries.reduce((n, e) => n + e.bytes, 0);
  console.log(`${style.bold(`${entries.length} file${entries.length === 1 ? "" : "s"}`)} in trash ${style.dim(`(${humanBytes(totalBytes)})`)}`);
  // listTrash returns newest batch first; the batch name is the pull's wall-clock stamp.
  for (const e of entries) {
    console.log(`  ${style.dim(e.batch)}  ${e.path} ${style.dim(`(${humanBytes(e.bytes)})`)}`);
  }
  console.log(style.dim(`restore with \`rbox trash restore <path>\``));
}

async function trashRestore(root: string, pathArg: string | undefined, batch: string | undefined): Promise<void> {
  if (!pathArg) throw new Error("usage: rbox trash restore <path> [--batch <name>] [--path <dir>]");
  try {
    // Resolved against the CWD, not silently read as workspace-root-relative (#516).
    const rel = workspaceRelPath(root, pathArg);
    const { restoredTo } = await restoreFromTrash(root, rel, { batch });
    if (restoredTo === rel) {
      console.log(`restored ${style.cyan(rel)}`);
    } else {
      // The target path was occupied — never overwrite (trash.ts M4): landed at a conflict copy.
      console.log(`restored ${style.cyan(rel)} ${style.sym.arrow} ${style.yellow(restoredTo)} ${style.dim("(a file already occupied that path — kept both)")}`);
    }
  } catch (e) {
    // Unknown path / occupied ancestor: report on stderr, non-zero exit — never a stack trace.
    fail(e instanceof Error ? e.message : String(e));
  }
}

async function trashEmpty(root: string, yes: boolean): Promise<void> {
  const ok = await confirmDestructive({
    message: "Permanently delete every eligible trashed file? This cannot be undone.",
    yes,
    default: false,
    headless: "require-yes",
    headlessError: "refusing to empty the trash without --yes in non-interactive mode",
  });
  if (!ok) {
    process.stderr.write("trash empty cancelled — nothing deleted.\n");
    return;
  }
  // {days:0, maxBytes:0} = evict every ELIGIBLE batch; the engine still protects an
  // in-progress `.active` batch and anything younger than its 15-minute floor by design.
  const { removedBatches, freedBytes } = await pruneTrash(root, { days: 0, maxBytes: 0 });
  if (removedBatches === 0) {
    console.log(style.dim("nothing to empty — trash is empty or holds only in-progress/very-recent batches"));
    return;
  }
  console.log(`emptied ${removedBatches} batch${removedBatches === 1 ? "" : "es"} ${style.dim(`(${humanBytes(freedBytes)} freed)`)}`);
}
