/**
 * The `db.query` gate.
 *
 * `db.query` caches its statement on the connection. Once enough cached
 * statements accumulate, `close()` cannot finalize them all, SQLite zombie-
 * closes the connection, and `-wal`/`-shm` survive beside the main file — the
 * exact signature the reset classifier reads as `W1`, a WAL crash. A read that
 * leaves that signature is a read that mutated the workspace, which 163 v13
 * forbids, and it stopped `rbox status` and the daemon's sync gate on healthy
 * migrated workspaces.
 *
 * The property is cumulative, so no single call site is safe to exempt: the
 * leak appears at whichever statement happens to cross the threshold, which is
 * why this gate is textual and total rather than a curated allowlist.
 * `store/statements.ts` is the one owner; everything in this vertical goes
 * through it.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const STATE_PLANE = path.resolve(import.meta.dir, "..");

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Comments are stripped first: several modules explain the ban in prose, and a
 * gate that fires on its own explanation teaches people to delete the
 * explanation. */
const code = (file: string): string =>
  fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("no state-plane module runs SQL through the connection's statement cache", () => {
  const offenders = sourceFiles(STATE_PLANE)
    .filter((file) => /\.query\(/.test(code(file)))
    .map((file) => path.relative(STATE_PLANE, file));
  expect(offenders).toEqual([]);
});
