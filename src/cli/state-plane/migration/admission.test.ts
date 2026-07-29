import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { daemonPidPath } from "../../rbox-paths.js";
import { saveStateUnsafeLegacyOrTest } from "../../sync-state-store.js";
import type { SyncMutexOptions } from "../../sync-mutex.js";
import { withStatePlaneLocks, type EntryProof } from "../locks.js";
import { migrationPaths, statePath } from "../paths.js";
import {
  admitMigration,
  admitMigrationBudget,
  evaluateAdmission,
  MIGRATION_ADMISSION_CONDITIONS,
  type AdmissionCondition,
  type AdmissionConditionName,
  type AdmissionVerdict,
} from "./admission.js";
import { stateReservePath, streamDigest } from "./reserve.js";

const STREAM = "stream";

// `~/.rbox` holds the daemon pid records this suite writes; keep them out of the
// developer's real home.
process.env.RBOX_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-admit-home-"));

async function workspace(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  return root;
}

const legacyState = (marker = 0) => ({
  stream: STREAM,
  lastSyncedSequence: marker,
  lastSyncedManifest: { generatedAt: "", files: [] },
});

/** A workspace one barrier-capable legacy writer has published, which is the
 * only shape the five conditions can admit. */
async function migratableWorkspace(prefix: string): Promise<string> {
  const root = await workspace(prefix);
  await saveStateUnsafeLegacyOrTest(root, legacyState());
  return root;
}

/** A real degraded-unlocked workspace: the production mutex degrades when lock
 * identity is unavailable, so break identity rather than forging a handle. */
const DEGRADED: SyncMutexOptions = {
  lock: { identity: { current: async () => { throw new Error("identity unavailable"); } } },
  onDegraded: () => undefined,
};

/** Run the real bundle and the real conditions, optionally with one or more
 * conditions subtracted — the negative controls use the production evaluation,
 * not a reimplementation of it. */
async function admitUnderLocks(
  root: string,
  without: AdmissionConditionName[] = [],
  options: { sleep?: (ms: number) => Promise<void>; degraded?: boolean } = {},
): Promise<AdmissionVerdict> {
  const conditions: readonly AdmissionCondition[] = MIGRATION_ADMISSION_CONDITIONS
    .filter((condition) => !without.includes(condition.name));
  return withStatePlaneLocks(root, async (locks) => {
    const entry: EntryProof = { entry: "foreground-migrate", locks };
    return evaluateAdmission(conditions, { root, entry, sleep: options.sleep ?? (async () => undefined) });
  }, options.degraded ? { mutex: DEGRADED } : {});
}

/** Nothing an admission refusal touched: no control, no staging, no Q sibling. */
async function noMigrationArtifact(root: string): Promise<void> {
  await expect(fs.lstat(migrationPaths.control(root))).rejects.toThrow();
  const stateDir = await fs.readdir(path.join(root, ".rbox", "state"));
  expect(stateDir.filter((name) => name.startsWith("migration-") || name.startsWith("state.db"))).toEqual([]);
  const rboxDir = await fs.readdir(path.join(root, ".rbox"));
  expect(rboxDir.filter((name) => name.includes(".migrate."))).toEqual([]);
}

test("the five conditions are exactly 163's, in 163's order", () => {
  expect(MIGRATION_ADMISSION_CONDITIONS.map((condition) => condition.name)).toEqual([
    "locking-health",
    "no-live-workspace-operation",
    "quarantine-absent",
    "barrier-witness",
    "exclusivity-window",
  ]);
});

test("a quiet barrier-capable workspace is admitted under the real lock bundle", async () => {
  const root = await migratableWorkspace("rbox-admit-ok-");
  expect(await admitUnderLocks(root)).toEqual({ outcome: "admitted" });
});

test("condition 3 refuses any occupant of the quarantine path", async () => {
  const root = await migratableWorkspace("rbox-admit-quarantine-");
  await fs.mkdir(migrationPaths.quarantine(root));
  const verdict = await admitUnderLocks(root);
  expect(verdict.outcome).toBe("refused");
  expect(verdict.outcome === "refused" && verdict.refusal.code).toBe("quarantine-pending");
  await noMigrationArtifact(root);
});

test("condition 4 refuses a workspace whose live document has no matching witness", async () => {
  const root = await migratableWorkspace("rbox-admit-witness-");
  const published = await fs.readFile(statePath(root), "utf8");
  await fs.writeFile(statePath(root), `${published} `);
  const verdict = await admitUnderLocks(root);
  expect(verdict.outcome).toBe("refused");
  expect(verdict.outcome === "refused" && verdict.refusal.code).toBe("barrier-witness-missing");
});

test("condition 2 refuses when a daemon record cannot be read at all", async () => {
  const root = await migratableWorkspace("rbox-admit-pid-unreadable-");
  const pid = daemonPidPath(root);
  await fs.mkdir(path.dirname(pid), { recursive: true });
  await fs.writeFile(pid, "not a pid record\n");
  const verdict = await admitUnderLocks(root);
  expect(verdict.outcome).toBe("refused");
  expect(verdict.outcome === "refused" && verdict.refusal.code).toBe("migration-not-exclusive");
});

test("condition 2's bounded wait sees a daemon that appears after the first sample", async () => {
  const root = await migratableWorkspace("rbox-admit-pid-late-");
  const pid = daemonPidPath(root);
  await fs.mkdir(path.dirname(pid), { recursive: true });
  // The wait is where "recently held" is observed; the writer runs inside it.
  const sleep = async (): Promise<void> => {
    await fs.writeFile(pid, "not a pid record\n");
  };
  const verdict = await admitUnderLocks(root, [], { sleep });
  expect(verdict.outcome).toBe("refused");
  expect(verdict.outcome === "refused" && verdict.refusal.code).toBe("migration-not-exclusive");

  // Negative control for the second sample: with nothing appearing during the
  // wait, the same fixture admits — so the refusal above is the second sample.
  await fs.rm(pid);
  expect(await admitUnderLocks(root)).toEqual({ outcome: "admitted" });
});

test("condition 5 refuses an entry proof whose state lock names another workspace", async () => {
  const root = await migratableWorkspace("rbox-admit-window-");
  const other = await migratableWorkspace("rbox-admit-window-other-");
  const verdict = await withStatePlaneLocks(other, async (locks) =>
    admitMigration(root, { entry: "foreground-migrate", locks }, { sleep: async () => undefined }));
  expect(verdict.outcome).toBe("refused");
  expect(verdict.outcome === "refused" && verdict.refusal.code).toBe("migration-not-exclusive");
});

// F1 — the degraded fence does what M0 says (163:2446).
test("F1: a degraded-unlocked workspace refuses degraded-fence and creates nothing", async () => {
  const root = await migratableWorkspace("rbox-f1-");
  const verdict = await admitUnderLocks(root, [], { degraded: true });
  expect(verdict).toEqual({ outcome: "refused", refusal: { code: "degraded-fence", detail: "identity-unavailable" } });
  await noMigrationArtifact(root);
});

test("F1 negative control: subtracting the fence changes the outcome, twice over", async () => {
  const root = await migratableWorkspace("rbox-f1-negative-");
  // Subtract the fence: the window check independently refuses a degraded
  // mutex, so removing condition 1 does not let the migration proceed — it only
  // loses the refusal that names what is actually wrong.
  const behind = await admitUnderLocks(root, ["locking-health"], { degraded: true });
  expect(behind.outcome === "refused" && behind.refusal.code).toBe("migration-not-exclusive");

  // Subtract both guards and the same fixture is admitted, so the two refusals
  // above are these guards rather than some unrelated condition.
  expect(await admitUnderLocks(root, ["locking-health", "exclusivity-window"], { degraded: true }))
    .toEqual({ outcome: "admitted" });
});

test("F1, the live-writer half: a lock-respecting legacy writer cannot write inside the window", async () => {
  const root = await migratableWorkspace("rbox-f1-window-");
  // The parked-car rule as a property, not a claim: a barrier-capable writer is
  // refused the state lock for as long as the bundle is held.
  const refused = await withStatePlaneLocks(root, async () =>
    saveStateUnsafeLegacyOrTest(root, legacyState(9)).then(() => undefined, (error: unknown) => error));
  expect((refused as { reason?: string }).reason).toBe("state-lock-unavailable");
  // ...and lands normally once the window closes.
  await saveStateUnsafeLegacyOrTest(root, legacyState(9));
});

// F4 — concurrency (163:2467): assert the refusal, not last-writer-wins.
// A degraded writer is by construction lock-ignoring — that is what degraded
// means — so these two race on the document itself.
async function degradedWrite(root: string, marker: number): Promise<void> {
  await fs.writeFile(statePath(root), JSON.stringify(legacyState(marker)));
}

test("F4: two concurrent degraded writers are refused, not resolved to a winner", async () => {
  const root = await migratableWorkspace("rbox-f4-");
  await Promise.all([degradedWrite(root, 11), degradedWrite(root, 22)]);

  const verdict = await admitUnderLocks(root, [], { degraded: true });
  expect(verdict).toEqual({ outcome: "refused", refusal: { code: "degraded-fence", detail: "identity-unavailable" } });
  await noMigrationArtifact(root);

  // The document really did resolve to one writer; admission refused anyway,
  // which is the whole assertion.
  const survivor = JSON.parse(await fs.readFile(statePath(root), "utf8")) as { lastSyncedSequence: number };
  expect([11, 22]).toContain(survivor.lastSyncedSequence);
});

test("F4 negative control: the fence, the window, and the witness each refuse in turn", async () => {
  const root = await migratableWorkspace("rbox-f4-negative-");
  await Promise.all([degradedWrite(root, 11), degradedWrite(root, 22)]);

  // Neither racing writer maintained the witness, so the raced document is
  // refused on that axis too.
  const behindFence = await admitUnderLocks(root, ["locking-health"], { degraded: true });
  expect(behindFence.outcome === "refused" && behindFence.refusal.code).toBe("barrier-witness-missing");

  const behindWitness = await admitUnderLocks(root, ["locking-health", "barrier-witness"], { degraded: true });
  expect(behindWitness.outcome === "refused" && behindWitness.refusal.code).toBe("migration-not-exclusive");

  // With all three subtracted the fixture is admitted, so each refusal above is
  // its own guard rather than an unrelated condition.
  expect(await admitUnderLocks(root, ["locking-health", "barrier-witness", "exclusivity-window"], { degraded: true }))
    .toEqual({ outcome: "admitted" });
});

test("the budget halts outside 163's envelope and admits inside it", async () => {
  const root = await migratableWorkspace("rbox-admit-budget-");
  const oversize = await admitMigrationBudget(root, 513 * 1024 * 1024, STREAM);
  expect(oversize.outcome === "halted" && oversize.halt.code).toBe("source-oversize");

  const starved = await admitMigrationBudget(root, 64 * 1024 * 1024, STREAM, {
    budgetBytes: 1024 * 1024 * 1024, currentRssBytes: 1024 * 1024 * 1024,
  });
  expect(starved.outcome === "halted" && starved.halt.code).toBe("memory-admission");

  const admitted = await admitMigrationBudget(root, 1024, STREAM, {
    budgetBytes: 8 * 1024 * 1024 * 1024, currentRssBytes: 0,
  });
  expect(admitted.outcome).toBe("admitted");
  expect(admitted.outcome === "admitted" && admitted.proof.sourceBytes).toBe(1024);
});

test("the budget refuses a reserve this workspace's barrier did not create", async () => {
  const root = await migratableWorkspace("rbox-admit-reserve-");
  expect(streamDigest(STREAM)).toHaveLength(64);
  await fs.writeFile(stateReservePath(root), Buffer.alloc(1024));
  const verdict = await admitMigrationBudget(root, 1024, STREAM, {
    budgetBytes: 8 * 1024 * 1024 * 1024, currentRssBytes: 0,
  });
  expect(verdict).toEqual({ outcome: "refused", refusal: { code: "reserve-foreign", detail: "wrong-size" } });
});

test("v11 deleted the live-writer sampling, and it stays deleted", async () => {
  const sweep = Bun.spawnSync(["git", "grep", "-lIE", "legacy-writer-live|paired-interval", "--", "src"], {
    cwd: path.resolve(import.meta.dir, "../../../.."),
  });
  expect(new TextDecoder().decode(sweep.stdout).trim()).toBe("");
});
