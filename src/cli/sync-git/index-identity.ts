/** Never: follow authorization or live-index mutation. */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { hashBytes } from "../../engine/hash.js";
import { gitWithIndexFile } from "../../engine/git-spawn.js";

function records(raw: string): string[] {
  return raw.split("\0").filter((record) => record.length > 0);
}

function frame(kind: string, values: readonly string[]): string {
  return values.map((value) => `${kind}:${Buffer.byteLength(value)}:${value}`).join("\n");
}

function semanticDebugFlags(raw: string): string[] {
  // `--debug -z` emits: path NUL followed by five stat/debug lines. Git 2.51
  // makes intent-to-add otherwise indistinguishable from a staged empty blob;
  // retain only CE_INTENT_TO_ADD/CE_SKIP_WORKTREE/CE_VALID bits and discard the
  // volatile stat fields. This supplements the four normative plumbing views.
  const out: string[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const nul = raw.indexOf("\0", offset);
    if (nul < 0) throw new Error("unterminated ls-files --debug path");
    const entryPath = raw.slice(offset, nul);
    const lines: string[] = [];
    offset = nul + 1;
    for (let i = 0; i < 5; i++) {
      const nl = raw.indexOf("\n", offset);
      if (nl < 0) {
        if (i !== 4 || offset >= raw.length) throw new Error("truncated ls-files --debug record");
        lines.push(raw.slice(offset));
        offset = raw.length;
      } else {
        lines.push(raw.slice(offset, nl));
        offset = nl + 1;
      }
    }
    const match = /flags:\s*([0-9a-fA-F]+)\s*$/.exec(lines[4]!);
    if (!match) throw new Error("missing ls-files --debug flags");
    const flags = Number.parseInt(match[1]!, 16);
    const semantic = flags & 0x60008000;
    out.push(`${entryPath}\0${semantic.toString(16)}`);
  }
  return out.sort();
}

/**
 * Design 116's index oracle compares Git semantics, not the volatile index
 * serialization.  Copying first is load-bearing: every plumbing probe below is
 * lock-free with respect to the receiver and can only refresh the private copy.
 * The sibling location also keeps split-index sharedindex lookup working.
 */
export async function indexIdentityV2(repoDir: string, indexFilePath: string): Promise<string | undefined> {
  const privateIndex = path.join(path.dirname(indexFilePath), `.rbox-index-projection-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  try {
    await fs.copyFile(indexFilePath, privateIndex);
    // SEQUENTIAL on purpose: all five probes share ONE private index copy, and
    // git may opportunistically refresh-write an index it reads (taking
    // `<index>.lock`). Concurrent probes intermittently collide on that lock
    // and a spurious throw would read as indeterminate — a flaky false defer.
    const stagedRaw = await gitWithIndexFile(repoDir, privateIndex, ["ls-files", "-z", "--stage"]);
    const flagsRaw = await gitWithIndexFile(repoDir, privateIndex, ["ls-files", "-z", "-v"]);
    const sparseRaw = await gitWithIndexFile(repoDir, privateIndex, ["ls-files", "-z", "--stage", "--sparse"]);
    const undoRaw = await gitWithIndexFile(repoDir, privateIndex, ["ls-files", "-z", "--resolve-undo"]);
    const debugRaw = await gitWithIndexFile(repoDir, privateIndex, ["ls-files", "-z", "--debug"]);

    // ls-files --stage supplies mode/OID/stage (including conflict stages and
    // zero-OID intent-to-add); -v supplies assume-unchanged/skip-worktree; and
    // --sparse/--resolve-undo expose the two semantic extensions. Sorting makes
    // index v2/v3/v4 encoding and extension order irrelevant (design 116).
    const staged = records(stagedRaw).sort();
    const flags = records(flagsRaw).sort();
    const sparse = records(sparseRaw).sort();
    const undo = records(undoRaw).sort();
    const debugFlags = semanticDebugFlags(debugRaw);
    const canonical = ["GitIndexIdentityV2", frame("entry", staged), frame("flag", flags), frame("sparse", sparse), frame("undo", undo), frame("extended", debugFlags)].join("\n");
    return `v2:${hashBytes(Buffer.from(canonical))}`;
  } catch {
    // Any unreadable index or failed semantic probe is indeterminate. It must
    // never become permission to overwrite receiver staging (design 116).
    return undefined;
  } finally {
    await fs.rm(privateIndex, { force: true }).catch(() => {});
  }
}
