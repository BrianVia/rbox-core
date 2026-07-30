/**
 * The operator commands, driven the way a user and the rig drive them
 * (design 222 §3.2, §7.3, wave 5B).
 *
 * The value here is not that a happy path prints something — the snapshot-replay
 * harness proves the happy path against real data. It is that NOTHING these
 * commands can meet escapes as a stack trace, every verdict is exit-coded, and
 * the two zero-mutation promises are measured against the whole `.rbox` tree
 * rather than asserted.
 */
import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig, saveConfig, syncStreamId, type WorkspaceConfig } from "./config.js";
import { checkState, checkStateMigration } from "./doctor-state-plane.js";
import { saveStateUnsafeLegacyOrTest } from "./sync-state-store.js";
import { abortStateMigrationCmd, migrateCmd, retryStateMigrationCmd } from "./state-plane-cmd.js";

// Deliberately no `RBOX_HOME` override: M0's liveness condition only READS the
// daemon pid records under it, and mutating a process-wide env var at module load
// leaks into every other suite in the same bun process — `credentials.test.ts`
// asserts exactly that isolation.

/** A bound workspace carrying legacy sync records, published WITHOUT the
 * last-writer witness M0 requires — which is the shape 222 §6.1's
 * `barrier-witness-missing` refusal exists for. */
async function workspace(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const config: WorkspaceConfig = {
    schema: "e2ee/v1", remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev",
    rootPath: root, remoteUrl: "https://example.invalid", token: "",
  };
  await saveConfig(root, config);
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  await saveStateUnsafeLegacyOrTest(root, {
    stream: syncStreamId(config), lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
  });
  return root;
}

/**
 * A digest of the whole `.rbox` tree, sidecars included.
 *
 * 222 §7.1's r6 amendment: comparing one file is too narrow, because a stray
 * `-wal` beside an untouched document passes. The lock files this suite's own
 * acquisition creates and removes are excluded by name — they are the fence, not
 * the state.
 */
async function rboxTree(root: string): Promise<string> {
  const dir = path.join(root, ".rbox");
  const parts: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        parts.push(`d ${path.relative(dir, file)}`);
        await walk(file);
        continue;
      }
      if (entry.name.endsWith(".lock") || entry.name === "locking-health.json") continue;
      parts.push(`f ${path.relative(dir, file)} ${crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex")}`);
    }
  };
  await walk(dir);
  return parts.join("\n");
}

interface Run { readonly code: number; readonly lines: string[] }

const run = async (
  command: (root: string, options: { json?: boolean; log?: (line: string) => void }) => Promise<number>,
  root: string, json = false,
): Promise<Run> => {
  const lines: string[] = [];
  const code = await command(root, { json, log: (line) => lines.push(line) });
  return { code, lines };
};

test("abort on a workspace that was never converting says so, and mutates nothing", async () => {
  const root = await workspace("rbox-operator-abort-");
  const before = await rboxTree(root);
  const { code, lines } = await run(abortStateMigrationCmd, root);

  expect(code).toBe(0);
  // The 5A outcome member rendered distinctly: a pristine workspace must never be
  // told its records were migrated.
  expect(lines.join(" ")).toContain("nothing to stop");
  expect(lines.join(" ")).not.toContain("new format");
  expect(await rboxTree(root)).toBe(before);
});

test("retry with no paused conversion is a typed verdict, not a thrown error", async () => {
  const root = await workspace("rbox-operator-retry-");
  const before = await rboxTree(root);
  const { code, lines } = await run(retryStateMigrationCmd, root);

  expect(code).toBe(1);
  // It reaches the user as copy with a next step, which is the whole point of
  // "no bare throws to the CLI".
  expect(lines.some((line) => line.startsWith("Next: "))).toBeTrue();
  expect(lines.join(" ")).not.toContain("Error:");
  expect(await rboxTree(root)).toBe(before);
});

/**
 * The re-entry debt, closed (222 §3.2's annotation).
 *
 * The second `rbox migrate` is the assertion that matters. Before wave 5B the
 * lock bundle's inventory refused any workspace whose `state.json` is the
 * authority marker, so `rbox migrate` could not report success on the workspace
 * it had just converted — it threw `StateFormatTooNewError` at a user whose
 * binary is the newest one there is.
 */
test("migrate converts a workspace, then reports cleanly when run again on its own work", async () => {
  const root = await workspace("rbox-operator-migrate-");
  const first = await run(migrateCmd, root);
  expect(first.code).toBe(0);
  expect(first.lines.join(" ")).toContain("new format");

  const again = await run(migrateCmd, root);
  expect(again.code).toBe(0);
  expect(again.lines.join(" ")).toContain("already in rbox's new format");
  expect(again.lines.join(" ")).not.toMatch(/newer version of rbox|StateFormatTooNew/);
});

test("abort after the flip refuses on its own identity, not merely with a non-zero exit", async () => {
  // 222 §7.3: post-`Q` there is no abort, and `halt-recovery.ts` is what refuses.
  //
  // The first version of this test asserted `code === 1` and the presence of a
  // `Next:` line — both of which the FALL-THROUGH also produces, so deleting the
  // guard left it green. It now asserts the machine identity, which only the
  // guard can produce. The other three rows are covered against real records in
  // `authority-behavior.test.ts`; this is the surface half.
  const root = await workspace("rbox-operator-post-q-abort-");
  expect((await run(migrateCmd, root)).code).toBe(0);

  const { code, lines } = await run(abortStateMigrationCmd, root, true);
  expect(code).toBe(1);
  const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
  expect(parsed.outcome).toBe("halted:reserved-path:abort-after-flip");
  expect(parsed.id).toBe("state-migration/abort-after-flip");
  // And it reads as what it is, not as the catch-all's generic sentence.
  expect(String(parsed.problem)).toContain("already been converted");
  expect(String(parsed.command)).toContain("rbox adopt");

  const human = await run(abortStateMigrationCmd, root);
  expect(human.lines.some((line) => line.startsWith("Next: "))).toBeTrue();
  expect(human.lines.join(" ")).not.toMatch(/\bat \/|node_modules|Error:/);
});

test("the 5-second progress rule is real: silence under it, one plain-English line past it", async () => {
  // 222 §6.4 — "the `migrating` state renders in plain English past 5 s per
  // phase". The threshold seam existed for this and no test used it, so the rule
  // was unverified in both directions: a build that printed on every event and one
  // that never printed would both have passed.
  const quiet = await workspace("rbox-operator-progress-quiet-");
  const quietLines: string[] = [];
  // A clock that never advances: no phase can exceed the threshold.
  await migrateCmd(quiet, { log: (line) => quietLines.push(line), now: () => 0 });
  expect(quietLines.filter((line) => line.startsWith("still "))).toEqual([]);

  const slow = await workspace("rbox-operator-progress-slow-");
  const slowLines: string[] = [];
  let ticks = 0;
  // A clock that jumps a minute per reading: every phase is over the threshold.
  await migrateCmd(slow, { log: (line) => slowLines.push(line), now: () => (ticks += 60_000) });
  const announced = slowLines.filter((line) => line.startsWith("still "));
  expect(announced.length).toBeGreaterThan(0);
  for (const line of announced) {
    expect(line).not.toMatch(/\bM[0-7]\b/);      // never a phase name
    expect(line.endsWith("…")).toBeTrue();
  }
  // Both runs still converted: progress rendering is not part of the outcome.
  expect(quietLines.join(" ")).toContain("new format");
  expect(slowLines.join(" ")).toContain("new format");
});

test("--json emits one parseable object with a stable id, and prints no prose beside it", async () => {
  const root = await workspace("rbox-operator-json-");
  const { code, lines } = await run(migrateCmd, root, true);

  expect(code).toBe(0);
  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
  expect(parsed.schemaVersion).toBe(1);
  expect(parsed.ok).toBeTrue();
  expect(parsed.id).toBe("state-migration/migrated");
  expect(parsed.outcome).toBe("migrated");
  expect(typeof parsed.problem).toBe("string");
  expect(typeof parsed.safety).toBe("string");
  // The `--json` twin is the WHOLE surface in that mode: a progress line beside
  // it would make the output unparseable for the rig that drives it.
  expect(parsed.facts).toEqual([]);
});

/**
 * The §C4 requirement the 2C review flagged as blocking before any 2.0 tag: a
 * healthy migrated workspace must NOT tell the user to upgrade a current binary.
 *
 * This is the same assertion the copy tests cannot make, because it needs a real
 * SQLite authority behind a real marker — which is exactly what `rbox migrate`
 * just produced.
 */
test("doctor reports a freshly migrated workspace as healthy, never as a too-new format", async () => {
  const root = await workspace("rbox-operator-doctor-");
  expect((await run(migrateCmd, root)).code).toBe(0);

  const state = await checkState(root, await loadConfig(root));
  expect(state.ok).toBeTrue();
  expect(state.status).toBe("sqlite");
  expect(state.hint).toBeUndefined();

  const migration = checkStateMigration(root);
  // The one thing doctor must never do to a current binary.
  expect(JSON.stringify([state, migration])).not.toContain("rbox upgrade");
  expect(migration.ok).toBeTrue();
  expect(migration.message).toBe("no conversion in progress");
});

test("all three commands survive a workspace whose .rbox is a mess, without throwing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-operator-mess-"));
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "state.json"), "not json at all");
  await fs.writeFile(path.join(root, ".rbox", "state", "migration-v1.json"), "{ truncated");

  for (const command of [migrateCmd, retryStateMigrationCmd, abortStateMigrationCmd]) {
    const { code, lines } = await run(command, root);
    expect(code).toBe(1);
    expect(lines.length).toBeGreaterThan(1);
    // A non-developer must not see a class name or a stack frame.
    expect(lines.join(" ")).not.toMatch(/Error:|\bat \/|node_modules/);
  }
});
