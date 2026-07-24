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

test("a shutdown mid-pull aborts the repo loop instead of deferring the repos it never touched", async () => {
  const section = await captureGitState(sender, store, KEK) as GitSection;
  expect(section).toBeTruthy();
  const remote: Manifest = {
    generatedAt: "", files: [], manifestSchema: 2,
    gitRepos: Object.fromEntries(REPOS.map((rel) => [rel, section])),
  };
  const state: SyncState = {
    stream: "shutdown-gate",
    stateNonce: "c".repeat(32),
    lastSyncedSequence: 1,
    lastSyncedManifest: { generatedAt: "", files: [] },
    repoRecords: Object.fromEntries(REPOS.slice(1).map((rel) =>
      [rel, { repoGen: 1, sourceSeq: 1, attempt: heldAttempt() }])),
  };

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
  const outcome = await applyGitSections(
    workspace, cfg, state, remote, store, buildIgnoreMatcher(workspace), (line) => logs.push(line),
    {
      mutationBoundary: boundary,
      disableConfigLane: true,
      onProgress: (done) => { if (done === 1) gate.close(); },
    },
  ).then((value) => ({ status: "resolved" as const, value }), (error: unknown) => ({ status: "rejected" as const, error }));

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
