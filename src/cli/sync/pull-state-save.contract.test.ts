/**
 * Design 279 §0 (#785) — the pull's one state save composes its packet from the
 * outcome the CAS window LEFT, not the one it opened with.
 *
 * The CAS window may withdraw a repository (an unreadable ref database, a ref
 * moved by a concurrent writer). Every such withdrawal reassigns outcome
 * containers; a packet captured before the window keeps only the withdrawals
 * that happened to mutate in place, which is a half-persisted state.
 */
import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PhaseReport, type GitSection, type Manifest } from "../../engine/index.js";
import type { MutationBoundary } from "../../engine/mutation-gate.js";
import { loadRawState, type SyncState } from "../config.js";
import { applyStateSavePacket } from "../state-plane/adapters/whole-state-compat.js";
import { authorityMarkerBytes } from "../state-plane/authority-marker.js";
import { sqliteResetPaths, statePath } from "../state-plane/paths.js";
import { createStateStore } from "../state-plane/store/open.js";
import { observedRepoKeys } from "../sync-state.js";
import { saveConfig, syncStreamId, type WorkspaceConfig } from "../workspace-config.js";
import type { GitPullOutcome } from "../sync-git/apply.js";
import { withRevalidatedGitPartialApplies } from "../sync-git.js";
import { outcomeRepoValues, savePulledState, type PullStateSave } from "./pull-state-save.js";

const exec = promisify(execFile);
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox", GIT_AUTHOR_EMAIL: "rbox@local",
  GIT_COMMITTER_NAME: "rbox", GIT_COMMITTER_EMAIL: "rbox@local",
};

const REL = "repo";
const REF = "refs/heads/topic";
const TAG = "refs/tags/v1";
const AUTHORITY = "a".repeat(32);
const LINEAGE = "b".repeat(32);
const NONCE = "c".repeat(32);
const SEQ = 7;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function section(refs: Record<string, string>): GitSection {
  return {
    bundleSha: "b".repeat(64), bundleEncSha: "a".repeat(64), bundleCipherSize: 1, head: `ref: ${REF}`,
    refs, refScope: "all", generatedAt: "2026-07-16T12:00:00.000Z",
  };
}

interface Fixture {
  root: string;
  repo: string;
  cfg: WorkspaceConfig;
  state: SyncState;
  git: (...args: string[]) => Promise<string>;
}

/** A workspace on the real state authority, holding one initialized git repo. */
async function fixture(prefix: string): Promise<Fixture> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `rbox-279-${prefix}-`));
  roots.push(root);
  await fsp.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  const cfg: WorkspaceConfig = {
    schema: "e2ee/v1", remoteWorkspaceId: "ws_279", projectId: "root", deviceId: "dev",
    rootPath: root, remoteUrl: "https://api.test", token: "",
  };
  await saveConfig(root, cfg);
  const stream = syncStreamId(cfg);
  createStateStore(sqliteResetPaths.active(root), {
    authorityId: AUTHORITY, lineageId: LINEAGE, stream,
    createdBy: "test", stateNonce: NONCE, stateRevision: 0,
  }).close();
  await fsp.writeFile(statePath(root), authorityMarkerBytes(AUTHORITY));
  const seeded = await applyStateSavePacket(root, {
    expectedStream: stream, expectedNonce: NONCE, sourceGlobalSeq: SEQ,
    global: { manifest: { generatedAt: "old", files: [] } }, repos: [],
  });
  if (seeded.status !== "accepted") throw new Error(`seed refused (${seeded.status})`);

  const repo = path.join(root, REL);
  await fsp.mkdir(repo);
  const git = (...args: string[]) =>
    exec("git", ["-C", repo, ...args], { env: gitEnv }).then(({ stdout }) => stdout.toString().trim());
  await git("init", "-qb", "topic");
  await fsp.writeFile(path.join(repo, "tracked"), "prior\n");
  await git("add", "tracked");
  await git("commit", "-qm", "prior");
  return { root, repo, cfg, state: (await loadRawState(root))!, git };
}

/** Install one repo record with the supplied BASE, under an observed landing. */
async function seedRecordWithBase(fx: Fixture, base: GitSection): Promise<SyncState> {
  const accepted = await applyStateSavePacket(fx.root, {
    expectedStream: fx.state.stream, expectedNonce: NONCE, sourceGlobalSeq: SEQ,
    repos: [{
      relPath: REL,
      expectedRepoGen: 0,
      newRecord: { sourceSeq: SEQ, base },
      baseProof: {
        authority: { kind: "observed-landing", lineageHash: "L", observedRefs: base.refs },
        lockedProof: { repoKind: "dir", effectiveRefScope: "all", checkoutComplete: true, branches: {}, safeRefs: {} },
      },
    }],
  });
  if (accepted.status !== "accepted") throw new Error(`record seed refused (${accepted.status})`);
  return (await loadRawState(fx.root))!;
}

const REMOTE_MANIFEST: Manifest = { generatedAt: "new", files: [] };

/** The production save, called exactly as `pull()` calls it. */
function saveInput(fx: Fixture, state: SyncState, gitOutcome: GitPullOutcome, deps: PullStateSave["deps"] = {}): PullStateSave {
  return {
    root: fx.root, cfg: fx.cfg, deps, report: PhaseReport.disabled("pull"), state,
    scoped: {
      reconcileBase: state.lastSyncedManifest, local: REMOTE_MANIFEST, remote: REMOTE_MANIFEST,
      storedBase: REMOTE_MANIFEST, storedBaseIsRemote: true, probeKeys: (keys) => keys,
    },
    gitOutcome, sequence: SEQ + 1, noActions: false, provenance: "standalone",
  };
}

/** An observed-landing pull over `landed`, withdrawn inside the CAS window by an
 * unreadable ref database — the #785 arm whose reassignments must survive. */
function landingOutcome(landed: GitSection): GitPullOutcome {
  return {
    repoProofs: {
      [REL]: {
        authority: { kind: "observed-landing", lineageHash: "L", observedRefs: landed.refs },
        lockedProof: { repoKind: "dir", effectiveRefScope: "all", checkoutComplete: true, branches: {}, safeRefs: {} },
      },
    },
    gitRepos: { [REL]: landed },
  };
}

async function breakRefDatabase(fx: Fixture): Promise<void> {
  await fsp.writeFile(path.join(fx.repo, ".git", "packed-refs"), "garbage\n");
}

test("a CAS-window withdrawal with a prior BASE persists the carry, not the withdrawn candidate", async () => {
  const fx = await fixture("carry-present");
  const prior = await fx.git("rev-parse", REF);
  const priorBase = section({ [REF]: prior });
  const state = await seedRecordWithBase(fx, priorBase);
  const landed = section({ [REF]: prior, [TAG]: prior });
  await breakRefDatabase(fx);

  const saved = await savePulledState(saveInput(fx, state, landingOutcome(landed)));

  const record = saved.repoRecords![REL]!;
  expect(record.base).toEqual(priorBase);
  expect(record.pending).toEqual(landed);
  expect(record.deferrals?.apply).toMatchObject({ lane: "apply", reason: "ref-read-unreadable" });
});

test("a CAS-window withdrawal with no prior BASE restores pending and defers, never the half-state", async () => {
  const fx = await fixture("carry-absent");
  const tip = await fx.git("rev-parse", REF);
  const landed = section({ [REF]: tip });
  await breakRefDatabase(fx);

  const saved = await savePulledState(saveInput(fx, fx.state, landingOutcome(landed)));

  const record = saved.repoRecords![REL];
  expect(record?.base).toBeUndefined();
  // The half-state #785 produced: BASE gone AND no pending AND no deferral.
  expect(record?.pending).toEqual(landed);
  expect(record?.deferrals?.apply).toMatchObject({ lane: "apply", reason: "ref-read-unreadable" });
});

test("a withdrawn repository leaves the settlement authority set, and its withdrawal survives settlement", async () => {
  const fx = await fixture("settlement");
  const prior = await fx.git("rev-parse", REF);
  const priorBase = section({ [REF]: prior });
  const state = await seedRecordWithBase(fx, priorBase);
  const landed = section({ [REF]: prior, [TAG]: prior });
  await breakRefDatabase(fx);
  const phases: string[] = [];
  const boundary: MutationBoundary = {
    enter: (request) => {
      phases.push(request.phase);
      return { get abortRequested() { return false; }, beginCommit: () => true, finish: () => {} };
    },
  };

  const settled = await savePulledState(saveInput(fx, state, landingOutcome(landed), { mutationBoundary: boundary }));

  // The withdrawn repository contributes no settlement authority, so settlement
  // takes no git-prepare lease at all — and it never undoes the withdrawal.
  expect(phases).toEqual(["state-cas"]);
  expect(settled.repoRecords![REL]!.base).toEqual(priorBase);
  expect(settled.repoRecords![REL]!.pending).toEqual(landed);
  expect(settled.repoRecords![REL]!.deferrals?.apply).toMatchObject({ reason: "ref-read-unreadable" });
});

test("the CAS window never changes the observed-repo key set the packet was scoped to", async () => {
  const fx = await fixture("observed-keys");
  const prior = await fx.git("rev-parse", REF);
  const state = await seedRecordWithBase(fx, section({ [REF]: prior }));
  const landed = section({ [REF]: prior, [TAG]: prior });
  const outcome = landingOutcome(landed);
  const remoteGitRepos = { [REL]: landed };

  const before = observedRepoKeys(state, remoteGitRepos, outcomeRepoValues(outcome, state));
  await breakRefDatabase(fx);
  await withRevalidatedGitPartialApplies(fx.root, state, outcome, async () => undefined);
  const after = observedRepoKeys(state, remoteGitRepos, outcomeRepoValues(outcome, state));

  expect(after).toEqual(before);
  // The window did move members around — the invariance is not vacuous.
  expect(outcome.gitPendingRemote).toEqual({ [REL]: landed });
});
