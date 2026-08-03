/**
 * `rbox upgrade`'s stop window (design 222 §3.2 entry A).
 *
 * The module shipped with zero behavioral tests, and three mutations survived
 * the whole suite: dropping `already-migrated` from the silence list, flipping
 * the unexpected-error report to `ok: true`, and suppressing every line. Each is
 * a way the window stops doing the one job it has — convert quietly, say
 * something when a person must act, and never, ever prevent the restart.
 *
 * Two contracts are pinned here:
 *
 *   1. **Never throws.** The caller restarts the daemon after this returns, so a
 *      throw is a workspace whose background sync does not come back. Asserted
 *      across every shape a workspace can be in, including ones designed to make
 *      the state plane fail.
 *   2. **The silence policy**, in both directions: silent on the states that need
 *      nobody, one line for a blocked one, the full report when rbox acted.
 */
import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig, syncStreamId, type WorkspaceConfig } from "./config.js";
import { migrateCmd } from "./state-plane-cmd.js";
import { lastWriterWitnessPath } from "./state-plane/migration/last-writer-witness.js";
import { saveStateUnsafeLegacyOrTest } from "./sync-state-store.js";
import { migrateStateInUpgradeWindow } from "./upgrade-state-window.js";

const KEY = "ws-0123456789ab";

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

test("the window converts a workspace and says so, once, prefixed by its key", async () => {
  const root = await workspace("rbox-window-convert-");
  const outcome = await migrateStateInUpgradeWindow(root, KEY);

  expect(outcome.ok).toBeTrue();
  expect(outcome.lines.length).toBeGreaterThan(0);
  for (const line of outcome.lines) expect(line.startsWith(`daemon ${KEY}: `)).toBeTrue();
  expect(outcome.lines.join(" ")).toContain("new format");
  // It really converted — the window is the entry point, not a dry run.
  expect((await loadConfig(root)).rootPath).toBe(root);
});

test("an already-converted workspace is SILENT — the mutation that survived", async () => {
  // Dropping `already-migrated` from the silence list left every test passing
  // while turning a fleet upgrade into a paragraph per already-converted
  // workspace, which buries the restart lines that are the command's answer.
  const root = await workspace("rbox-window-silent-");
  expect((await migrateCmd(root, { log: () => undefined })).valueOf()).toBe(0);

  const outcome = await migrateStateInUpgradeWindow(root, KEY);
  expect(outcome.ok).toBeTrue();
  expect(outcome.lines).toEqual([]);
});

test("a workspace with nothing to set up is silent too, and still ok", async () => {
  // No config, no records: genesis refuses `evidence-missing`. Nothing was
  // published and nothing is owed, so an upgrade has nothing to report.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-window-bare-"));
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });

  const outcome = await migrateStateInUpgradeWindow(root, KEY);
  expect(outcome.lines).toEqual([]);
});

test("a BLOCKED workspace gets exactly one line, not silence and not a paragraph", async () => {
  // The hole the `ok` field exists to close: suppressing every refusal meant a
  // workspace rbox cannot convert emitted nothing from `rbox upgrade`, forever.
  // `memory-admission` is the measured case — a small-memory host cannot read the
  // document at all — and the sanctioned override reproduces it exactly.
  const root = await workspace("rbox-window-blocked-");
  const previous = process.env.RBOX_RESET_PARSE_BUDGET_BYTES;
  process.env.RBOX_RESET_PARSE_BUDGET_BYTES = "1";
  try {
    const outcome = await migrateStateInUpgradeWindow(root, KEY);
    expect(outcome.ok).toBeFalse();
    expect(outcome.lines).toHaveLength(1);
    expect(outcome.lines[0]).toContain("sync records not converted");
    expect(outcome.lines[0]).toContain("rbox doctor");
    expect(outcome.lines[0]!.startsWith(`daemon ${KEY}: `)).toBeTrue();
  } finally {
    if (previous === undefined) delete process.env.RBOX_RESET_PARSE_BUDGET_BYTES;
    else process.env.RBOX_RESET_PARSE_BUDGET_BYTES = previous;
  }
});

test("a routine not-yet-eligible workspace stays silent, so a fleet upgrade is not noise", async () => {
  // `barrier-witness-missing` describes every workspace on the fleet until it
  // syncs once with 1.11.0+. A line per workspace per upgrade for a self-clearing
  // condition is exactly the noise the severity discriminator exists to prevent —
  // `ok` alone would have printed it.
  const root = await workspace("rbox-window-routine-");
  // Remove the witness rather than hand-writing a state document: the shape of a
  // legacy state is not this test's subject, and a wrong one produces a DIFFERENT
  // failure that would pass the same assertion for the wrong reason.
  await fs.rm(lastWriterWitnessPath(root), { force: true });

  const outcome = await migrateStateInUpgradeWindow(root, KEY);
  expect(outcome.ok).toBeFalse();
  expect(outcome.lines).toEqual([]);
});

test("the never-throw contract holds across every shape a workspace can be in", async () => {
  const cases: Array<readonly [string, () => Promise<string>]> = [
    ["a directory that is not a workspace at all", async () => fs.mkdtemp(path.join(os.tmpdir(), "rbox-window-nothing-"))],
    ["a malformed state document", async () => {
      const root = await workspace("rbox-window-malformed-");
      await fs.writeFile(path.join(root, ".rbox", "state.json"), "not json at all");
      return root;
    }],
    ["a marker with no records behind it", async () => {
      const root = await workspace("rbox-window-corrupt-");
      await fs.writeFile(path.join(root, ".rbox", "state.json"), `RBOX-SQLITE-AUTHORITY-v1\n${"a".repeat(32)}\n`);
      return root;
    }],
    ["a truncated migration control", async () => {
      const root = await workspace("rbox-window-control-");
      await fs.writeFile(path.join(root, ".rbox", "state", "migration-v1.json"), "{ truncated");
      return root;
    }],
    ["a state path that is a directory", async () => {
      const root = await workspace("rbox-window-dir-");
      await fs.rm(path.join(root, ".rbox", "state.json"));
      await fs.mkdir(path.join(root, ".rbox", "state.json"));
      return root;
    }],
  ];

  for (const [name, build] of cases) {
    const root = await build();
    const outcome = await migrateStateInUpgradeWindow(root, KEY).catch((error: unknown) => error);
    expect(outcome, `${name}: the window threw, so the daemon restart after it would not run`)
      .not.toBeInstanceOf(Error);
    const window = outcome as Awaited<ReturnType<typeof migrateStateInUpgradeWindow>>;
    expect(typeof window.ok, name).toBe("boolean");
    // Whatever it says, it never says it with a stack frame.
    expect(window.lines.join(" "), name).not.toMatch(/\bat \/|node_modules|Error:/);
  }
});

test("an unexpected failure is reported as NOT ok, and names a command", async () => {
  // The surviving mutation flipped this to `ok: true`, which would tell an
  // upgrade that a workspace it could not read is fine. The report is built by
  // the module's own catch-all, so it is asserted through the same shape a
  // defect would take.
  const root = await workspace("rbox-window-corrupt-report-");
  await fs.writeFile(path.join(root, ".rbox", "state.json"), `RBOX-SQLITE-AUTHORITY-v1\n${"a".repeat(32)}\n`);

  const outcome = await migrateStateInUpgradeWindow(root, KEY);
  expect(outcome.ok).toBeFalse();
  expect(outcome.lines.length).toBeGreaterThan(0);
  expect(outcome.lines.join(" ")).toMatch(/rbox adopt|rbox migrate|rbox doctor/);
});
