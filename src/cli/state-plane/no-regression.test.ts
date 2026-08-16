/**
 * The no-regression gate for U3 (design 222 §7.6, wave 5C).
 *
 * Every other suite in this plane asks "did the migration move the records
 * correctly?". This one asks the question a user would: does the PRODUCT behave
 * the same afterwards? A conversion can be byte-perfect and still break `rbox
 * status`, doctor, or an exit code, and nothing else here would notice.
 *
 * The method is deliberately fixture-free. Eight prior lanes lost time to
 * hand-planted "migrated" records that were self-consistent and wrong, so
 * nothing below writes a post-migration byte by hand: a real legacy workspace is
 * built with the real legacy writer, an OBSERVATION VECTOR is captured from the
 * real command surfaces, `migrateCmd` — the actual `rbox migrate` entry point —
 * runs, and the same vector is captured again. The assertion is deep equality.
 *
 * WHAT THE VECTOR COVERS (all offline, no remote):
 *   - the whole `SyncState` through the SELECTING seam (files, gitRepos,
 *     manifestMeta, removal memories, every RepoRecord field)
 *   - `rbox status --json` and the human brief, through `statusCmd`
 *   - doctor's `state` and `migration` checks, which 5B made read through that
 *     same seam
 *   - the exit code / result of each
 * WHAT NEEDS THE RIG: anything with a server in it — `rbox sync`/push/pull
 * planning is not drivable without an authenticated remote, so reconcile
 * fidelity stays the snapshot-replay harness's job.
 */
import { expect, test } from "bun:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GitSection, Manifest } from "../../engine/types.js";
import type { DoctorCheck } from "../doctor-cmd.js";
import { checkState, checkStateMigration } from "../doctor-state-plane.js";
import { migrateCmd } from "../state-plane-cmd.js";
import { statusCmd } from "../status-cmd.js";
import {
  type RepoRecord, type SyncState,
} from "../sync-state-model.js";
import {
  repoRecordsForState, stateFromRepoRecords,
} from "../sync-state-records.js";
import { saveStateUnsafeLegacyOrTest } from "../sync-state-store.js";
import { saveConfig, syncStreamId, type WorkspaceConfig } from "../workspace-config.js";
import { AUTHORITY_MARKER_MAGIC } from "./authority-marker.js";
import { statePath, sqliteResetPaths } from "./paths.js";
import { loadRawState, loadState } from "./adapters/whole-state-compat.js";

process.env.RBOX_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), "rbox-u3-5c-noreg-home-"));

const configOf = (root: string): WorkspaceConfig => ({
  schema: "e2ee/v1", remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev",
  rootPath: root, remoteUrl: "https://example.invalid", token: "",
});

/**
 * A real legacy workspace, published by the real legacy writer.
 *
 * The state is put through `stateFromRepoRecords` first — the SAME composer the
 * transactional legacy writer uses — so the document on disk carries the legacy
 * physical projections (`gitNeedsResolution`, `gitReposRemoved`, …) that a real
 * save derives from the records. `saveStateUnsafeLegacyOrTest` deliberately
 * preserves caller-supplied projections instead of deriving them, so skipping
 * this step publishes a document no production writer emits, and the resulting
 * "divergence" after migration is the fixture's, not the migration's.
 */
async function legacyWorkspace(prefix: string, state: (stream: string) => SyncState): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `rbox-u3-5c-noreg-${prefix}-`));
  const config = configOf(root);
  await saveConfig(root, config);
  await fsp.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  const composed = state(syncStreamId(config));
  await saveStateUnsafeLegacyOrTest(root, stateFromRepoRecords(composed, repoRecordsForState(composed)));
  return root;
}

const section = (n: number, refs: Record<string, string>): GitSection => ({
  bundleSha: `${n}`.padStart(64, "a"), bundleEncSha: `${n}`.padStart(64, "b"), bundleCipherSize: 4096 + n,
  head: "ref: refs/heads/main", refs, refScope: "all", generatedAt: "2026-01-01T00:00:00.000Z",
  indexTree: `${n}`.padStart(40, "c"), config: { "core.ignorecase": ["false"] },
  // `manifest-validate.ts` requires these two together and requires the
  // generation to dominate every retained entry. A section carrying only the
  // generation is a shape no publisher emits and the migration correctly
  // refuses — the exact "fixture encodes a state the machine cannot produce"
  // trap, hit here and corrected rather than worked around.
  refTombstones: {}, refTombstoneGeneration: 0,
});

const file = (n: number) => ({
  path: `dir${n % 17}/file-${n}.bin`, sha256: `${n}`.padStart(64, "d"),
  size: n * 3, mode: n % 2 === 0 ? 0o644 : 0o755, mtimeMs: 1_700_000_000_000 + n, type: "file" as const,
});

/**
 * The observation vector — the whole reachable-offline product surface.
 *
 * ORDER IS STABLE and is the same on both sides: `statusCmd` runs first so the
 * user surface is observed before the state and doctor consumers. Each scenario
 * declares which surface (`--json` or the human brief) it measures. Repeated
 * reads and SQLite sidecar cleanliness are positively covered by
 * `store/reads-leave-the-store-at-rest.test.ts`.
 */
type StatusSurface = "json" | "brief";

interface Observation {
  statusOut: readonly string[];
  statusResult: unknown;
  state: SyncState;
  rawState: SyncState | undefined;
  doctorState: DoctorCheck;
  doctorMigration: DoctorCheck;
}

const NOW = new Date("2026-02-01T00:00:00.000Z");

async function captureConsole<T>(body: () => Promise<T>): Promise<{ value: T; out: string[] }> {
  const out: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const log = console.log;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : chunk);
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => { out.push(args.map(String).join(" ")); };
  try {
    return { value: await body(), out };
  } finally {
    process.stdout.write = stdout;
    console.log = log;
  }
}

async function observe(root: string, surface: StatusSurface): Promise<Observation> {
  const config = configOf(root);
  const stream = syncStreamId(config);
  const status = await captureConsole(() => statusCmd(root, { json: surface === "json", now: NOW }));
  return {
    statusOut: status.out.map((line) => line.replace(path.basename(root), "<workspace>")),
    statusResult: status.value,
    state: await loadState(root, stream, () => undefined),
    rawState: await loadRawState(root),
    doctorState: await checkState(root, config),
    doctorMigration: checkStateMigration(root),
  };
}

/**
 * TWO named, justified authority-dependent exemptions. Nothing else in the
 * vector gets any latitude at all.
 *
 * 1. doctor's `state` check reports WHICH format it read (163 §C4). Both sides
 *    must be `ok`; the post side must be the `sqlite` verdict and must never be
 *    `format-too-new`, which is the 5B correction.
 * 2. `SyncState.repoRecords` is ABSENT in a legacy document that never had a
 *    transactional write and is a materialized (possibly empty) map in the
 *    store. This is not normalized away: both sides are put through
 *    `repoRecordsForState` — the one function every consumer of the repo plane
 *    reads through, which folds the legacy physical maps — and the FOLDED
 *    records are compared in full. That is strictly stronger than comparing the
 *    raw field, because it also proves the legacy sidecar maps
 *    (`gitReposRemoved`, `gitNeedsResolution`, `gitDeferrals`, …) fold to the
 *    same records on both sides.
 */
function assertDifferential(before: Observation, after: Observation): void {
  expect(before.doctorState.ok).toBeTrue();
  expect(after.doctorState.ok).toBeTrue();
  expect(before.doctorState.status).toBeUndefined();
  expect(after.doctorState.status).toBe("sqlite");
  expect(`${after.doctorState.message} ${after.doctorState.hint ?? ""}`).not.toMatch(/newer version|upgrade|delete/i);

  expect(repoRecordsForState(after.state)).toEqual(repoRecordsForState(before.state));
  if (before.rawState && after.rawState) {
    expect(repoRecordsForState(after.rawState)).toEqual(repoRecordsForState(before.rawState));
  } else {
    expect(after.rawState).toEqual(before.rawState);
  }

  const strip = (o: Observation) => ({
    ...o,
    doctorState: { ok: o.doctorState.ok, label: o.doctorState.label },
    state: { ...o.state, repoRecords: undefined },
    rawState: o.rawState === undefined ? undefined : { ...o.rawState, repoRecords: undefined },
  });
  expect(strip(after)).toEqual(strip(before));
}

async function differential(
  root: string, surface: StatusSurface = "json",
): Promise<{ before: Observation; after: Observation }> {
  const before = await observe(root, surface);
  const lines: string[] = [];
  const code = await migrateCmd(root, { log: (line) => lines.push(line) });
  expect(code, lines.join(" ")).toBe(0);
  expect(lines.join(" ")).toContain("new format");
  const after = await observe(root, surface);
  assertDifferential(before, after);
  return { before, after };
}

// ---------------------------------------------------------------------------
// Scenarios.

test("an empty-manifest workspace behaves identically after migration", async () => {
  const root = await legacyWorkspace("empty", (stream) => ({
    stream, lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] },
  }));
  const { after } = await differential(root);
  expect(after.state.lastSyncedManifest.files).toEqual([]);
});

test("the human `rbox status` brief is identical after migration", async () => {
  const root = await legacyWorkspace("brief", (stream) => ({
    stream, lastSyncedSequence: 3,
    lastSyncedManifest: { generatedAt: "2026-01-01T00:00:00.000Z", files: [file(1)], manifestSchema: 2 },
  }));
  const { before, after } = await differential(root, "brief");
  // Proof the surface was really rendered, not an empty capture on both sides.
  expect(before.statusOut.join(" ")).toContain("<workspace>");
  expect(after.statusOut.join(" ")).not.toContain("halted");
});

test("a large file corpus behaves identically after migration", async () => {
  const files = Array.from({ length: 2000 }, (_, i) => file(i)).sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest: Manifest = { generatedAt: "2026-01-01T00:00:00.000Z", files, manifestSchema: 2 };
  const root = await legacyWorkspace("corpus", (stream) => ({
    stream, lastSyncedSequence: 512, lastSyncedManifest: manifest,
    // A meta `validManifestMeta` actually accepts: both byte counters, a
    // self-excluding deduped chain, and the git layer key. A partial one is
    // dropped on read by the legacy store AND by the migration, which would
    // have made this scenario assert nothing.
    manifestMeta: {
      encManifestSha: "e".repeat(64), manifestHash: "f".repeat(64),
      accountEpoch: 3, keyEpoch: 2, chain: ["0".repeat(64), "1".repeat(64)],
      chainBytes: 8192, snapshotBytes: 65_536, gitRepos: {},
    },
  }));
  const { after } = await differential(root);
  expect(after.state.lastSyncedManifest.files).toHaveLength(2000);
  expect(after.state.manifestMeta?.chain).toEqual(["0".repeat(64), "1".repeat(64)]);
  expect(after.state.manifestMeta?.snapshotBytes).toBe(65_536);
});

/**
 * 101 repositories is the real-corpus shape. Every one is a REAL `git init` on
 * disk, because the lock bundle's inventory refuses a record whose branch refs
 * name a repository it cannot see — a hand-planted repo plane would simply fail
 * to migrate, which is exactly the class of fixture this wave exists to avoid.
 */
async function gitCorpus(prefix: string, extra: (i: number) => Partial<RepoRecord>): Promise<string> {
  const relPaths = Array.from({ length: 101 }, (_, i) => `repos/r${`${i}`.padStart(3, "0")}`);
  const root = await legacyWorkspace(prefix, (stream) => {
    const gitRepos: Record<string, GitSection> = {};
    const repoRecords: Record<string, RepoRecord> = {};
    relPaths.forEach((rel, i) => {
      const sec = section(i, { "refs/heads/main": `${i}`.padStart(40, "e"), "refs/tags/v1": `${i}`.padStart(40, "f") });
      gitRepos[rel] = sec;
      repoRecords[rel] = {
        repoGen: i + 1, sourceSeq: 40, base: sec, advertised: sec,
        capturePolicy: { syncGit: true, respectGitignore: i % 2 === 0, incremental: true },
        cfgSynced: `${i}`, cfgApplied: `${i}`, ...extra(i),
      };
    });
    return {
      stream, lastSyncedSequence: 40,
      lastSyncedManifest: { generatedAt: "2026-01-01T00:00:00.000Z", files: [file(1)], manifestSchema: 2, gitRepos },
      repoRecords,
    };
  });
  await Promise.all(relPaths.map(async (rel) => {
    const dir = path.join(root, ...rel.split("/"));
    await fsp.mkdir(dir, { recursive: true });
    await Bun.$`git init -q ${dir}`.quiet();
  }));
  return root;
}

test("101 real git repositories with deferrals behave identically after migration", async () => {
  const at = "2026-01-01T00:00:00.000Z";
  const root = await gitCorpus("git", (i) => (i % 3 === 0
    ? {
      deferrals: {
        capture: { lane: "capture", deferredSince: at, reasonSince: at, lastSeen: at, reason: "git-busy" },
      },
    }
    : {}));
  const { after } = await differential(root);
  expect(Object.keys(after.state.repoRecords ?? {})).toHaveLength(101);
  expect(Object.keys(after.state.lastSyncedManifest.gitRepos ?? {})).toHaveLength(101);
}, 120_000);

/**
 * Conflict suppressions ride on repos that ARE still in the manifest — that is
 * the shape design 43 §7 describes. A removal memory is the opposite: §9 makes
 * the repo ABSENT, so it belongs to the scenario below, on paths the manifest
 * does not name. Putting one on a repo with a live section produced a state no
 * publisher emits, and the migration answered by dropping the section — which
 * is a correct read of a contradictory input, not a fidelity result worth
 * pinning.
 */
test("conflict suppressions survive with identical behavior", async () => {
  const root = await gitCorpus("memories", (i) => (i % 5 === 0 ? { resolutionKey: `ident-${i}` } : {}));
  const before = await loadState(root, syncStreamId(configOf(root)), () => undefined);
  expect(Object.values(before.repoRecords ?? {}).filter((r) => r.resolutionKey).length).toBe(21);
  const { after } = await differential(root);
  expect(Object.entries(after.state.repoRecords ?? {}).filter(([, r]) => r.resolutionKey)).toHaveLength(21);
});

test("removal memories at a non-zero lastSyncedSequence behave identically", async () => {
  const root = await legacyWorkspace("seq", (stream) => ({
    stream, lastSyncedSequence: 987_654,
    lastSyncedManifest: { generatedAt: "2026-01-01T00:00:00.000Z", files: [file(2), file(3)], manifestSchema: 2 },
    gitReposRemoved: { "gone/a": "identity-a", "gone/b": "identity-b" },
    gitNeedsResolution: { "conflicted/c": "identity-c" },
  }));
  const { before, after } = await differential(root);
  expect(after.state.lastSyncedSequence).toBe(987_654);
  expect(after.state.gitReposRemoved).toEqual({ "gone/a": "identity-a", "gone/b": "identity-b" });
  // The legacy physical maps fold to records on BOTH sides — proved, not assumed.
  expect(repoRecordsForState(before.state)["conflicted/c"]?.resolutionKey).toBe("identity-c");
  expect(repoRecordsForState(after.state)["conflicted/c"]?.resolutionKey).toBe("identity-c");
});

// ---------------------------------------------------------------------------
// Negative control. Without it every assertion above could be vacuous.

test("the differential FAILS when one post-migration value is perturbed", async () => {
  const root = await legacyWorkspace("control", (stream) => ({
    stream, lastSyncedSequence: 11,
    lastSyncedManifest: { generatedAt: "2026-01-01T00:00:00.000Z", files: [file(9)], manifestSchema: 2 },
  }));
  const before = await observe(root, "json");
  expect(await migrateCmd(root, { log: () => undefined })).toBe(0);
  assertDifferential(before, await observe(root, "json"));

  // A REAL perturbation of real post-migration state: one byte of the authority
  // id `Q` names. The database is untouched and self-consistent; only the marker
  // now names a different authority, which is precisely the class of drift a
  // migration must never produce.
  const marker = await fsp.readFile(statePath(root), "latin1");
  const id = marker.slice(AUTHORITY_MARKER_MAGIC.length + 1, -1);
  const flipped = `${id[0] === "0" ? "1" : "0"}${id.slice(1)}`;
  await fsp.writeFile(statePath(root), `${AUTHORITY_MARKER_MAGIC}\n${flipped}\n`, "latin1");

  // Two legal outcomes, and the branch taken is RECORDED rather than silently
  // returned from: either capturing the vector throws (a corrupted authority id
  // is refused outright), or it captures and the differential rejects it. An
  // untracked early return would let this control quietly become a no-op the day
  // capture starts throwing, which is the same "passes for the wrong reason"
  // defect the wave exists to close.
  let perturbed: unknown;
  try {
    perturbed = await observe(root, "json");
  } catch (error) {
    perturbed = error;
  }
  const branch = perturbed instanceof Error ? "capture-refused" : "differential-rejected";
  if (branch === "differential-rejected") {
    expect(() => assertDifferential(before, perturbed as Observation)).toThrow();
  }
  expect(["capture-refused", "differential-rejected"]).toContain(branch);
});

test("the comparator is not satisfied by a merely-similar vector", async () => {
  const root = await legacyWorkspace("control2", (stream) => ({
    stream, lastSyncedSequence: 2, lastSyncedManifest: { generatedAt: "", files: [file(5)] },
  }));
  const before = await observe(root, "json");
  expect(await migrateCmd(root, { log: () => undefined })).toBe(0);
  const after = await observe(root, "json");
  assertDifferential(before, after);
  const bent: Observation = { ...after, state: { ...after.state, lastSyncedSequence: 3 } };
  expect(() => assertDifferential(before, bent)).toThrow();
});
