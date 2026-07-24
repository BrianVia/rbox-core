import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  LocalBlobStore,
  buildIgnoreMatcher,
  captureGitState,
  type GitSection,
  type Manifest,
} from "../../engine/index.js";
import { MutationGateClosedError, ShutdownMutationGate, type MutationBoundary } from "../../engine/mutation-gate.js";
import type { GitHeldAttempt, SyncState, WorkspaceConfig } from "../config.js";
import { applyGitSections } from "./apply.js";

const exec = promisify(execFile);
const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox test", GIT_AUTHOR_EMAIL: "rbox-test@local",
  GIT_COMMITTER_NAME: "rbox test", GIT_COMMITTER_EMAIL: "rbox-test@local",
};
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args], { env: TEST_GIT_ENV });
const KEK = Buffer.alloc(32, 41);
const REPOS = ["r1", "r2", "r3"] as const;

let tmp: string;
let sender: string;
let workspace: string;
let store: LocalBlobStore;
let cfg: WorkspaceConfig;
let priorConcurrency: string | undefined;

beforeEach(async () => {
  priorConcurrency = process.env.RBOX_GIT_APPLY_CONCURRENCY;
  // One worker: the repo loop visits r1, r2, r3 in order, so "the repos after
  // the shutdown" is an exact set rather than a race.
  process.env.RBOX_GIT_APPLY_CONCURRENCY = "1";
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-apply-shutdown-"));
  sender = path.join(tmp, "sender");
  workspace = path.join(tmp, "workspace");
  await fs.mkdir(sender, { recursive: true });
  await fs.mkdir(path.join(workspace, ".rbox", "state"), { recursive: true });
  await git(sender, "init", "-qb", "main");
  await git(sender, "config", "user.email", "shutdown@example.invalid");
  await git(sender, "config", "user.name", "shutdown");
  await fs.writeFile(path.join(sender, "tracked.txt"), "one");
  await git(sender, "add", "tracked.txt");
  await git(sender, "commit", "-qm", "one");
  store = new LocalBlobStore(path.join(tmp, "blobs"));
  cfg = {
    remoteWorkspaceId: "ws_shutdown",
    projectId: "root",
    deviceId: "receiver",
    rootPath: workspace,
    remoteUrl: "https://example.invalid",
    token: "",
    syncGit: true,
    encrypted: true,
    kek: KEK,
    accountId: "acct",
    accountEpoch: 0,
    keyEpoch: 0,
  };
});

afterEach(async () => {
  if (priorConcurrency === undefined) delete process.env.RBOX_GIT_APPLY_CONCURRENCY;
  else process.env.RBOX_GIT_APPLY_CONCURRENCY = priorConcurrency;
  await fs.rm(tmp, { recursive: true, force: true });
});

const heldAttempt = (): GitHeldAttempt => ({
  incomingKey: "held-incoming",
  localFingerprint: "held-fingerprint",
  fingerprintVersion: "held-version",
  effectiveBaseIndexProjection: null,
  effectiveIncomingIndexProjection: null,
  incomingIndexArtifactDescriptor: "null",
  reflogs: [],
  blockers: [{ provenance: "checkout", reason: "local-commits" }],
  repoIdentity: "held-identity",
  stateNonce: "c".repeat(32),
  baseOriginsHash: "held-origins",
  partialDisposition: "held",
  at: "2026-07-21T12:00:00.000Z",
});

const exists = (target: string): Promise<boolean> => fs.lstat(target).then(() => true, () => false);

const remoteOf = (section: GitSection, rels: readonly string[]): Manifest => ({
  generatedAt: "", files: [], manifestSchema: 2,
  gitRepos: Object.fromEntries(rels.map((rel) => [rel, section])),
});

/** Every repo but the first carries a held attempt: clearing one is destructive,
 * so a repo the shutdown never touched must come out of the run untouched. */
const stateHolding = (rels: readonly string[]): SyncState => ({
  stream: "shutdown-gate",
  stateNonce: "c".repeat(32),
  lastSyncedSequence: 1,
  lastSyncedManifest: { generatedAt: "", files: [] },
  repoRecords: Object.fromEntries(rels.slice(1).map((rel) =>
    [rel, { repoGen: 1, sourceSeq: 1, attempt: heldAttempt() }])),
});

const settle = <T>(promise: Promise<T>) =>
  promise.then((value) => ({ status: "resolved" as const, value }), (error: unknown) => ({ status: "rejected" as const, error }));

test("a shutdown mid-pull aborts the repo loop instead of deferring the repos it never touched", async () => {
  const section = await captureGitState(sender, store, KEK) as GitSection;
  expect(section).toBeTruthy();
  const remote = remoteOf(section, REPOS);
  const state = stateHolding(REPOS);

  // A stop request lands mid-pull: after the first repo is fully applied and
  // before the second one starts.
  const gate = new ShutdownMutationGate();
  const entered: string[] = [];
  const boundary: MutationBoundary = {
    enter(descriptor) {
      entered.push(path.basename(descriptor.repository ?? "?"));
      return gate.enter(descriptor);
    },
  };

  const logs: string[] = [];
  const outcome = await settle(applyGitSections(
    workspace, cfg, state, remote, store, buildIgnoreMatcher(workspace), (line) => logs.push(line),
    {
      mutationBoundary: boundary,
      disableConfigLane: true,
      onProgress: (done) => { if (done === 1) gate.close(); },
    },
  ));

  // r1 applied, then the gate closed and r2 hit it. r2 and r3 did not FAIL, so
  // nothing may be recorded against them — clearing a held attempt is destructive
  // and a spurious "other" deferral rewrites the user-visible reason.
  const untouched = new Set<string>(REPOS.slice(1));
  const recorded = (map: Record<string, unknown> | undefined): string[] =>
    Object.keys(map ?? {}).filter((rel) => untouched.has(rel)).sort();
  expect(outcome.status === "resolved" ? recorded(outcome.value.attempt) : []).toEqual([]);
  expect(outcome.status === "resolved" ? recorded(outcome.value.deferrals) : []).toEqual([]);
  // The abort propagates to the caller rather than resolving as an ordinary pull.
  expect(outcome.status === "rejected" ? outcome.error : undefined).toBeInstanceOf(MutationGateClosedError);
  // r3 is never started at all: no preflight, no artifact staging, no ref reads.
  // (r1 legitimately takes more than one lease while applying.)
  expect([...new Set(entered)]).toEqual(["r1", "r2"]);
  expect(await exists(path.join(workspace, "r1", ".git"))).toBe(true);
  expect(await exists(path.join(workspace, "r3"))).toBe(false);
  expect(logs.filter((line) => line.startsWith("git-sync deferred"))).toEqual([]);
});

test("the abort waits for the in-flight sibling workers before it escapes the pool", async () => {
  // Two workers, four sibling chains: r1 and r2 start together, r3 and r4 are
  // only ever reached by a worker that comes back for more. This is the case the
  // latch exists for — poolMap has no cancellation, so a bare re-throw would
  // reject Promise.all while r2 kept mutating disk behind an unwound caller.
  process.env.RBOX_GIT_APPLY_CONCURRENCY = "2";
  const rels = ["r1", "r2", "r3", "r4"] as const;
  const section = await captureGitState(sender, store, KEK) as GitSection;
  const remote = remoteOf(section, rels);
  const state = stateHolding(rels);
  const held = structuredClone(state.repoRecords);

  // The stop request lands on r1's first mutation. r2's remaining work is the
  // ungated preparation (pack import, scratch refs, journal writes) that must not
  // outlive the caller, so it keeps running against an open gate.
  const closed = new ShutdownMutationGate();
  closed.close();
  const open = new ShutdownMutationGate();
  const entered: string[] = [];
  const boundary: MutationBoundary = {
    enter(descriptor) {
      const rel = path.basename(descriptor.repository ?? "?");
      entered.push(rel);
      return (rel === "r1" ? closed : open).enter(descriptor);
    },
  };

  const logs: string[] = [];
  const progress: number[] = [];
  const outcome = await settle(applyGitSections(
    workspace, cfg, state, remote, store, buildIgnoreMatcher(workspace), (line) => logs.push(line),
    { mutationBoundary: boundary, disableConfigLane: true, onProgress: (done) => progress.push(done) },
  ));

  expect(outcome.status === "rejected" ? outcome.error : undefined).toBeInstanceOf(MutationGateClosedError);
  // Only the two repos that were already in flight ran at all.
  expect([...new Set(entered)].sort()).toEqual(["r1", "r2"]);
  expect(await exists(path.join(workspace, "r3"))).toBe(false);
  expect(await exists(path.join(workspace, "r4"))).toBe(false);
  // The drain: r2's apply is FINISHED — not merely started — by the time the
  // abort reaches the caller. A detached sibling would still be mid-apply here.
  expect(await exists(path.join(workspace, "r2", ".git"))).toBe(true);
  const applied = await git(path.join(workspace, "r2"), "rev-parse", "HEAD").then((r) => r.stdout.trim(), () => "unapplied");
  expect(applied).toBe((await git(sender, "rev-parse", "HEAD")).stdout.trim());
  // onProgress is the last statement of the per-repo body, so exactly two
  // observations means both in-flight repos ran to the end — r1 (aborted at its
  // first lease) and r2 (applied) — and neither r3 nor r4 ever entered the body.
  expect(progress.length).toBe(2);
  // Nothing was recorded against the repos the shutdown never touched, and the
  // caller's held-attempt state is byte-identical to what it passed in.
  expect(state.repoRecords).toEqual(held);
  expect(logs.filter((line) => line.startsWith("git-sync deferred"))).toEqual([]);
});

test("a throwing progress sink cannot replace the shutdown abort", async () => {
  const section = await captureGitState(sender, store, KEK) as GitSection;
  const gate = new ShutdownMutationGate();
  const boundary: MutationBoundary = { enter: (descriptor) => gate.enter(descriptor) };
  const outcome = await settle(applyGitSections(
    workspace, cfg, stateHolding(REPOS), remoteOf(section, REPOS), store, buildIgnoreMatcher(workspace), () => {},
    {
      mutationBoundary: boundary,
      disableConfigLane: true,
      onProgress: (done) => {
        if (done === 1) gate.close();
        // Fires for r2, i.e. AFTER the gate closure has been latched.
        if (done === 2) throw new Error("progress sink exploded");
      },
    },
  ));
  expect(outcome.status === "rejected" ? outcome.error : undefined).toBeInstanceOf(MutationGateClosedError);
});

test("a throwing git logger cannot replace the shutdown abort", async () => {
  const section = await captureGitState(sender, store, KEK) as GitSection;
  const gate = new ShutdownMutationGate();
  const boundary: MutationBoundary = { enter: (descriptor) => gate.enter(descriptor) };
  const outcome = await settle(applyGitSections(
    workspace, cfg, stateHolding(REPOS), remoteOf(section, REPOS), store, buildIgnoreMatcher(workspace),
    (line) => { if (line.startsWith("git-sync aborted")) throw new Error("git log sink exploded"); },
    { mutationBoundary: boundary, disableConfigLane: true, onProgress: (done) => { if (done === 1) gate.close(); } },
  ));
  expect(outcome.status === "rejected" ? outcome.error : undefined).toBeInstanceOf(MutationGateClosedError);
});

test("outside a shutdown a throwing progress sink still surfaces", async () => {
  const section = await captureGitState(sender, store, KEK) as GitSection;
  const outcome = await settle(applyGitSections(
    workspace, cfg, stateHolding(REPOS), remoteOf(section, REPOS), store, buildIgnoreMatcher(workspace), () => {},
    { disableConfigLane: true, onProgress: () => { throw new Error("progress sink exploded"); } },
  ));
  expect(outcome.status).toBe("rejected");
  expect(outcome.status === "rejected" ? outcome.error : undefined).not.toBeInstanceOf(MutationGateClosedError);
  expect(outcome.status === "rejected" ? (outcome.error as Error).message : "").toBe("progress sink exploded");
});
