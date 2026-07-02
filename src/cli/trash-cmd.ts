/**
 * `rbox trash` (design 50 §2): the user-facing surface over the local trash tier —
 * the recoverable-delete net the pull writer moves bytes into instead of `fs.rm`.
 *   list                          — what's recoverable, newest batch first
 *   restore <path> [--batch <n>]  — rename it back (collision → visible conflict copy)
 *   empty                         — permanently free everything eligible
 * Presentation only; all trash mechanics live in the engine's frozen trash module.
 */
import { listTrash, pruneTrash, restoreFromTrash } from "../engine/trash.js";
import { humanBytes } from "./status-view.js";
import { style } from "./style.js";

export async function trashCmd(root: string, positional: string[], flags: Record<string, string>): Promise<void> {
  const sub = positional[0] ?? "list";
  if (sub === "list") {
    await trashList(root);
  } else if (sub === "restore") {
    await trashRestore(root, positional[1], flags.batch);
  } else if (sub === "empty") {
    await trashEmpty(root);
  } else {
    console.log("usage: rbox trash <list | restore <path> [--batch <name>] | empty>");
    process.exitCode = 1;
  }
}

async function trashList(root: string): Promise<void> {
  const entries = await listTrash(root);
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

async function trashRestore(root: string, rel: string | undefined, batch: string | undefined): Promise<void> {
  if (!rel) throw new Error("usage: rbox trash restore <path> [--batch <name>]");
  try {
    const { restoredTo } = await restoreFromTrash(root, rel, { batch });
    if (restoredTo === rel) {
      console.log(`restored ${style.cyan(rel)}`);
    } else {
      // The target path was occupied — never overwrite (trash.ts M4): landed at a conflict copy.
      console.log(`restored ${style.cyan(rel)} ${style.sym.arrow} ${style.yellow(restoredTo)} ${style.dim("(a file already occupied that path — kept both)")}`);
    }
  } catch (e) {
    // Unknown path / occupied ancestor: report on stderr, non-zero exit — never a stack trace.
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}

async function trashEmpty(root: string): Promise<void> {
  // {days:0, maxBytes:0} = evict every ELIGIBLE batch; the engine still protects an
  // in-progress `.active` batch and anything younger than its 15-minute floor by design.
  const { removedBatches, freedBytes } = await pruneTrash(root, { days: 0, maxBytes: 0 });
  if (removedBatches === 0) {
    console.log(style.dim("nothing to empty — trash is empty or holds only in-progress/very-recent batches"));
    return;
  }
  console.log(`emptied ${removedBatches} batch${removedBatches === 1 ? "" : "es"} ${style.dim(`(${humanBytes(freedBytes)} freed)`)}`);
}
