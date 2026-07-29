import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireLock } from "../../../engine/git/lockfile.js";
import { daemonPidPath } from "../../rbox-paths.js";
import { saveStateUnsafeLegacyOrTest } from "../../sync-state-store.js";
import {
  acquireWorkspaceSyncMutex,
  lockingHealthPath,
  releaseWorkspaceSyncMutex,
  syncMutexPath,
  type SyncMutexOptions,
} from "../../sync-mutex.js";
import {
  withStatePlaneLocks,
  type EntryProof,
  type HeldStatePlaneLocks,
  type StatePlaneLockStage,
} from "../locks.js";
import { migrationPaths, stateLockPath, statePath } from "../paths.js";
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
  lock: {
    identity: {
      current: async () => { throw new Error("identity unavailable"); },
      probe: async () => { throw new Error("identity unavailable"); },
    },
  },
  onDegraded: () => undefined,
};

/** Run the real bundle and the real conditions, optionally with one or more
 * conditions subtracted — the negative controls use the production evaluation,
 * not a reimplementation of it.
 *
 * `sleep` defaults to a no-op so the suite does not pay condition 2's bounded
 * wait 15 times; one test below exercises the production wait unmocked. */
async function admitUnderLocks(
  root: string,
  without: AdmissionConditionName[] = [],
  options: { sleep?: (ms: number) => Promise<void>; realWait?: boolean } = {},
): Promise<AdmissionVerdict> {
  const conditions: readonly AdmissionCondition[] = MIGRATION_ADMISSION_CONDITIONS
    .filter((condition) => !without.includes(condition.name));
  const outcome = await withStatePlaneLocks(root, async (locks) => {
    const entry: EntryProof = { entry: "foreground-migrate", locks };
    const sleep = options.realWait ? undefined : options.sleep ?? (async () => undefined);
    return evaluateAdmission(conditions, { root, entry, ...(sleep ? { sleep } : {}) });
  });
  if (!outcome.held) throw new Error(`bundle refused: ${outcome.refusal.code}`);
  return outcome.value;
}

interface BundleOptions {
  readonly degraded?: boolean;
  readonly without?: AdmissionConditionName[];
  /** Runs with the bundle held, immediately before admission is evaluated. */
  readonly mutate?: () => Promise<void>;
}

/**
 * Admission on a bundle assembled by hand, which the production path refuses to
 * mint. The cast is the point, and this is the file's only one: conditions 1
 * and 5 guard states `withStatePlaneLocks` now prevents, so a forged bundle is
 * the only way to prove they are not dead code. 222 §7.9 exempts tests, and
 * `locks.test.ts` enforces that production has no second cast site.
 */
async function admitWithBundle(root: string, options: BundleOptions = {}): Promise<AdmissionVerdict> {
  const conditions: readonly AdmissionCondition[] = MIGRATION_ADMISSION_CONDITIONS
    .filter((condition) => !(options.without ?? []).includes(condition.name));
  const mutex = await acquireWorkspaceSyncMutex(root, "cli", options.degraded ? DEGRADED : undefined);
  const acquired = await acquireLock(stateLockPath(root));
  if (acquired.status !== "acquired") throw new Error("fixture could not take the state lock");
  try {
    await options.mutate?.();
    const locks = { mutex, stateLock: acquired.lock, underRepositoryFence: true } as unknown as HeldStatePlaneLocks;
    return await evaluateAdmission(conditions, {
      root, entry: { entry: "foreground-migrate", locks }, sleep: async () => undefined,
    });
  } finally {
    // Tolerant: a fixture that takes the mutex marker away has, by
    // construction, made an exact release impossible.
    await acquired.lock.release().catch(() => undefined);
    await releaseWorkspaceSyncMutex(mutex).catch(() => undefined);
  }
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

test("the production bounded wait, unmocked, still admits a quiet workspace", async () => {
  const root = await migratableWorkspace("rbox-admit-real-wait-");
  const started = Date.now();
  expect(await admitUnderLocks(root, [], { realWait: true })).toEqual({ outcome: "admitted" });
  // The clock advances across the wait, so a wait that stopped happening would
  // show up here rather than passing silently.
  expect(Date.now() - started).toBeGreaterThanOrEqual(200);
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
  const outcome = await withStatePlaneLocks(other, async (locks) =>
    admitMigration(root, { entry: "foreground-migrate", locks }, { sleep: async () => undefined }));
  const verdict = outcome.held ? outcome.value : undefined;
  expect(verdict?.outcome).toBe("refused");
  expect(verdict?.outcome === "refused" && verdict.refusal.code).toBe("migration-not-exclusive");
});

test("condition 5 refuses when mutex ownership is lost inside the window", async () => {
  const root = await migratableWorkspace("rbox-admit-lease-");
  // The window is a live property, not a fact cached at acquisition — which is
  // why admission is re-called verbatim immediately before the M6 rename. Same
  // bundle, same workspace; the only difference is the mutex marker going away.
  expect(await admitWithBundle(root)).toEqual({ outcome: "admitted" });
  expect(await admitWithBundle(root, { mutate: () => fs.rm(syncMutexPath(root)) }))
    .toEqual({
      outcome: "refused",
      refusal: { code: "migration-not-exclusive", detail: "workspace sync mutex ownership was lost" },
    });
});

// F1 — the degraded fence does what M0 says (163:2446).
//
// The fence lives at the mutex stage, ahead of everything `withStatePlaneLocks`
// does, because standing-reset recovery COPIES, CREATES and RENAMES. A degraded
// workspace must not reach that, so the assertion is on the stage trace, not
// only on the refusal.
//
// Not "no write occurs": acquiring the handle necessarily records the
// degradation (`sync-mutex.ts:142` writes `locking-health.json`), because you
// need the handle to judge its health. The property is no STATE-PLANE
// mutation — one health marker, and nothing else.
test("F1: a degraded-unlocked workspace is refused before any state-plane mutation", async () => {
  const root = await migratableWorkspace("rbox-f1-");
  const stages: StatePlaneLockStage[] = [];
  const outcome = await withStatePlaneLocks(root, async () => "body ran", {
    mutex: DEGRADED, onStage: (stage) => void stages.push(stage),
  });

  expect(outcome).toEqual({ held: false, refusal: { code: "degraded-fence", detail: "identity-unavailable" } });
  // No inventory, no fence, no state lock, and above all no reset recovery.
  expect(stages).toEqual([]);
  await noMigrationArtifact(root);
  // The one write the refusal does make, asserted rather than glossed: the
  // mutex records the degradation it just observed.
  expect(await fs.readFile(lockingHealthPath(root), "utf8")).toContain("degraded-unlocked");
  // The state document is byte-identical to what the last writer published.
  expect(JSON.parse(await fs.readFile(statePath(root), "utf8"))).toMatchObject({ lastSyncedSequence: 0 });
});

test("F1 negative control: the same call on a healthy workspace runs every stage", async () => {
  const root = await migratableWorkspace("rbox-f1-negative-");
  const stages: StatePlaneLockStage[] = [];
  const outcome = await withStatePlaneLocks(root, async () => "body ran", {
    onStage: (stage) => void stages.push(stage),
  });

  expect(outcome).toEqual({ held: true, value: "body ran" });
  expect(stages).toEqual(["mutex", "inventory", "fence", "state-lock", "fenced-recheck", "reset-recovery", "body"]);
});

test("F1, the admission half: condition 1 refuses a degraded mutex on a forged bundle", async () => {
  const root = await migratableWorkspace("rbox-f1-condition-");
  const verdict = await admitWithBundle(root, { degraded: true });
  expect(verdict).toEqual({ outcome: "refused", refusal: { code: "degraded-fence", detail: "identity-unavailable" } });

  // Subtract condition 1 and the window check refuses independently; subtract
  // both and the fixture is admitted, so each is its own guard.
  const behind = await admitWithBundle(root, { degraded: true, without: ["locking-health"] });
  expect(behind.outcome === "refused" && behind.refusal.code).toBe("migration-not-exclusive");
  expect(await admitWithBundle(root, { degraded: true, without: ["locking-health", "exclusivity-window"] }))
    .toEqual({ outcome: "admitted" });
});

test("F1, the live-writer half: a lock-respecting legacy writer cannot write inside the window", async () => {
  const root = await migratableWorkspace("rbox-f1-window-");
  // The parked-car rule as a property, not a claim: a barrier-capable writer is
  // refused the state lock for as long as the bundle is held.
  const outcome = await withStatePlaneLocks(root, async () =>
    saveStateUnsafeLegacyOrTest(root, legacyState(9)).then(() => undefined, (error: unknown) => error));
  expect(outcome.held && (outcome.value as { reason?: string })?.reason).toBe("state-lock-unavailable");
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

  const verdict = await admitWithBundle(root, { degraded: true });
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
  const behindFence = await admitWithBundle(root, { degraded: true, without: ["locking-health"] });
  expect(behindFence.outcome === "refused" && behindFence.refusal.code).toBe("barrier-witness-missing");

  const behindWitness = await admitWithBundle(root, { degraded: true, without: ["locking-health", "barrier-witness"] });
  expect(behindWitness.outcome === "refused" && behindWitness.refusal.code).toBe("migration-not-exclusive");

  // With all three subtracted the fixture is admitted, so each refusal above is
  // its own guard rather than an unrelated condition.
  expect(await admitWithBundle(root, { degraded: true, without: ["locking-health", "barrier-witness", "exclusivity-window"] }))
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
  // This file names the deleted mechanisms, so it must be excluded or the gate
  // matches itself. The exclusion covers EVERY test file, not just this one —
  // acceptable, since 163 forbids the mechanisms in production code and a test
  // naming them is how they stay forbidden.
  //
  // `git grep` reads only tracked files, so an uncommitted production file
  // carrying either literal is invisible to this gate regardless of pathspec.
  // CI always runs a committed tree, which is what makes that acceptable.
  const sweep = Bun.spawnSync([
    "git", "grep", "-lIE", "legacy-writer-live|paired-interval", "--", "src", ":!*.test.ts",
  ], { cwd: path.resolve(import.meta.dir, "../../../..") });
  expect(sweep.exitCode, "git grep failed to run").toBeLessThanOrEqual(1);
  expect(new TextDecoder().decode(sweep.stdout).trim()).toBe("");
});
