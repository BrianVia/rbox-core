import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type GitSection } from "../../engine/index.js";
import { repoCtxFromDisk } from "./git-state.js";
import type { GitConfig } from "./config-sync.js";
import {
  readConfigSnapshot,
  type ConfigStatToken,
  type ConfigTransactionResult,
} from "./config-txn.js";
import type { ConfigStoreIdentity, RepoRecordInput } from "../config.js";
import type { ConfigLaneState } from "../sync-state.js";
import { configReceiver, gitConfigHash } from "./config-lane.js";
import { createReceivedGitConfig } from "./received-git-config.js";
import { chainLock, type HeldChainLock } from "./shared.js";

const exec = promisify(execFile);
const INCOMING: GitConfig = { "core.bare": ["false"] };
const OTHER: GitConfig = { "core.bare": ["false"], "user.name": ["x"] };

const token = (value: string): ConfigStatToken =>
  ({ dev: "1", ino: "9", size: "1", mtimeNs: value, ctimeNs: value });

const section = (
  config: GitConfig | undefined,
  refScope: GitSection["refScope"] = "all",
): GitSection => ({
  bundleSha: "bundle",
  bundleEncSha: "encrypted",
  bundleCipherSize: 1,
  head: "ref: refs/heads/main\n",
  refs: {},
  refScope,
  generatedAt: "test",
  ...(config === undefined ? {} : { config }),
});

const completedTransaction = (
  over: Partial<Extract<ConfigTransactionResult, { status: "completed" }>> = {},
): ConfigTransactionResult => ({
  status: "completed",
  preHash: "pre",
  postHash: "post",
  incomingHash: gitConfigHash(INCOMING),
  postToken: token("post"),
  warnings: [],
  attempts: 1,
  ...over,
});

let tmp = "";
let root = "";
let repoDir = "";
let standalone: ConfigStoreIdentity;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-received-config-"));
  root = path.join(tmp, "workspace");
  repoDir = path.join(root, "repo");
  await fs.mkdir(repoDir, { recursive: true });
  await exec("git", ["-C", repoDir, "init", "-q"]);
  const ctx = await repoCtxFromDisk(repoDir);
  standalone = (await configReceiver(root, ctx!)).storeIdentity;
});

afterAll(async () => fs.rm(tmp, { recursive: true, force: true }));

interface HarnessOptions {
  priorLane?: ConfigLaneState;
  wireSection?: GitSection;
  incoming?: GitConfig;
  incomingAbsent?: boolean;
  leftoverPresent?: boolean;
  result?: ConfigTransactionResult;
  fresh?: { storeIdentity: ConfigStoreIdentity; config: GitConfig; token: ConfigStatToken };
  laneDisabled?: boolean;
  priorRecord?: () => RepoRecordInput;
  observeLeftover?: () => boolean;
}

function harness(lock: HeldChainLock, options: HarnessOptions = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const incoming = options.incomingAbsent ? undefined : options.incoming ?? INCOMING;
  const receiver = createReceivedGitConfig({
    root,
    relPath: "repo",
    repoDir,
    wireSection: options.wireSection ?? section(incoming),
    incoming,
    laneDisabled: options.laneDisabled === true,
    priorRecord: options.priorRecord ?? (() => ({
      sourceSeq: 4,
      ...(options.priorLane ?? {}),
    })),
    leftoverPresent: options.observeLeftover ?? (() => options.leftoverPresent !== false),
    commonDirLock: lock,
    repoContext: () => repoCtxFromDisk(repoDir),
    async materializeFresh() {
      calls.push("materializeFresh");
    },
    async inspectFreshInstall() {
      calls.push("inspectFreshInstall");
      if (!options.fresh) throw new Error("no fresh install configured");
      return options.fresh;
    },
    async applyExisting() {
      calls.push("applyExisting");
      if (!options.result) throw new Error("no transaction result configured");
      return options.result;
    },
    log(message) {
      logs.push(message);
    },
  });
  return { receiver, calls, logs };
}

async function withHarness<T>(
  options: HarnessOptions,
  operation: (value: ReturnType<typeof harness>) => Promise<T>,
): Promise<T> {
  return chainLock(new Map(), path.join(repoDir, ".git"), async (lock) =>
    operation(harness(lock, options)));
}

test("one repository-bound operation applies an existing target and records warnings", async () => {
  await withHarness({
    priorLane: { cfgStore: standalone },
    result: completedTransaction({ warnings: ["dropped credential"], baseHash: "basePre" }),
  }, async ({ receiver, calls, logs }) => {
    expect(await receiver.prepare(undefined)).toMatchObject({ due: true, requiresMaterialization: false });
    expect(await receiver.applyExisting()).toEqual({
      cfgApplied: gitConfigHash(INCOMING),
      cfgToken: token("post"),
      cfgStore: standalone,
    });
    expect(calls).toEqual(["applyExisting"]);
    expect(logs).toEqual(["git-sync WARNING repo: config dropped credential"]);
  });
});

test("independent retry leaves the config transition byte-exact on failure", async () => {
  await withHarness({
    priorLane: { cfgApplied: "old", cfgToken: token("old"), cfgStore: standalone },
    result: { status: "deferred", attempts: 3, fault: { disposition: "transient", reason: "unstable" } },
  }, async ({ receiver }) => {
    await receiver.prepare(undefined);
    const before = JSON.stringify(receiver.transition());
    await expect(receiver.applyExisting()).rejects.toThrow("config deferred: unstable");
    expect(JSON.stringify(receiver.transition())).toBe(before);
  });
});

test("fresh config is unrepresentable in existing and follow windows", async () => {
  await withHarness({
    leftoverPresent: false,
    fresh: { storeIdentity: standalone, config: INCOMING, token: token("fresh") },
  }, async ({ receiver, calls }) => {
    expect(await receiver.prepare(undefined)).toMatchObject({ due: true, requiresMaterialization: true });
    expect(await receiver.applyExisting()).toBeUndefined();
    expect(await receiver.applyWhileCommonDirLocked()).toBeUndefined();
    expect(calls).toEqual([]);
    expect(await receiver.applyAfterMaterialization()).toBeDefined();
    expect(calls).toEqual(["materializeFresh", "inspectFreshInstall"]);
  });
});

test("clean materialization window applies a due existing receiver", async () => {
  await withHarness({
    priorLane: { cfgStore: standalone },
    result: completedTransaction(),
  }, async ({ receiver, calls }) => {
    expect(await receiver.prepare(undefined)).toMatchObject({
      due: true,
      requiresMaterialization: false,
    });
    expect(await receiver.applyAfterMaterialization()).toBeDefined();
    expect(calls).toEqual(["applyExisting"]);
  });
});

test("follow config refuses an escaped common-directory lock scope", async () => {
  let escaped: ReturnType<typeof harness> | undefined;
  await chainLock(new Map(), path.join(repoDir, ".git"), async (lock) => {
    escaped = harness(lock, {
      priorLane: { cfgStore: standalone },
      result: completedTransaction(),
    });
    await escaped.receiver.prepare(undefined);
  });
  await expect(escaped!.receiver.applyWhileCommonDirLocked()).rejects.toThrow("chain lock is no longer held");
  expect(escaped!.calls).toEqual([]);
});

test("follow config refuses a live lock for another common directory", async () => {
  await chainLock(new Map(), path.join(root, "other", ".git"), async (lock) => {
    const { receiver, calls } = harness(lock, {
      priorLane: { cfgStore: standalone },
      result: completedTransaction(),
    });
    await receiver.prepare(undefined);
    await expect(receiver.applyWhileCommonDirLocked()).rejects.toThrow(
      "received git config common-directory lock mismatch",
    );
    expect(calls).toEqual([]);
  });
});

test("follow config executes while the actual common-directory lock is held", async () => {
  await withHarness({
    priorLane: { cfgStore: standalone },
    result: completedTransaction(),
  }, async ({ receiver, calls }) => {
    await receiver.prepare(undefined);
    expect(await receiver.applyWhileCommonDirLocked()).toBeDefined();
    expect(calls).toEqual(["applyExisting"]);
  });
});

test("production follow selects the common-directory-lock asserting config window", async () => {
  const child = Bun.spawn([
    process.execPath,
    new URL("./follow-config-lock.fixture.js", import.meta.url).pathname,
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual(["applyWhileCommonDirLocked"]);
});

test("prepare observes recovery quarantining a partial fresh repository", async () => {
  let leftoverPresent = true;
  await withHarness({
    observeLeftover: () => leftoverPresent,
    fresh: { storeIdentity: standalone, config: INCOMING, token: token("fresh") },
  }, async ({ receiver, calls }) => {
    leftoverPresent = false;
    expect(await receiver.prepare(undefined)).toMatchObject({
      due: true,
      requiresMaterialization: true,
    });
    await receiver.applyAfterMaterialization();
    expect(calls).toEqual(["materializeFresh", "inspectFreshInstall"]);
  });
});

test("prepare observes the config lane landed by published-journal recovery", async () => {
  const snapshot = await readConfigSnapshot(path.join(repoDir, ".git", "config"));
  if (!snapshot.ok) throw new Error("test config unreadable");
  let prior: RepoRecordInput = { sourceSeq: 4 };
  await withHarness({
    priorRecord: () => prior,
    result: completedTransaction(),
  }, async ({ receiver, calls }) => {
    prior = {
      sourceSeq: 9,
      cfgApplied: gitConfigHash(INCOMING),
      cfgToken: snapshot.snapshot.token,
      cfgStore: standalone,
    };
    expect(await receiver.prepare(undefined)).toEqual({
      due: false,
      requiresMaterialization: false,
      transition: undefined,
    });
    expect(await receiver.applyExisting()).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

test("after-materialization derives state from the installed config", async () => {
  await withHarness({
    incoming: OTHER,
    leftoverPresent: false,
    fresh: { storeIdentity: standalone, config: INCOMING, token: token("fresh") },
  }, async ({ receiver }) => {
    await receiver.prepare({ "core.bare": ["true"] });
    expect(await receiver.applyAfterMaterialization()).toEqual({
      cfgApplied: gitConfigHash(OTHER),
      cfgToken: token("fresh"),
      cfgStore: standalone,
    });
  });
});

test("after-materialization claims authorship only when install equals incoming", async () => {
  await withHarness({
    leftoverPresent: false,
    fresh: { storeIdentity: standalone, config: INCOMING, token: token("fresh") },
  }, async ({ receiver }) => {
    await receiver.prepare(undefined);
    expect((await receiver.applyAfterMaterialization())?.cfgSynced).toBe(gitConfigHash(INCOMING));
  });
});

test("sanitize-present seeds the local hash and preserves a same-shape baseline", async () => {
  await withHarness({
    priorLane: { cfgSynced: "hash-A", cfgApplied: "applied-A", cfgStore: standalone },
    wireSection: section(INCOMING, "scoped"),
    incomingAbsent: true,
  }, async ({ receiver }) => {
    const transition = await receiver.recordBaseline();
    expect(transition?.cfgSynced).toBe("hash-A");
    expect(transition?.cfgApplied).toBe("applied-A");
    expect(transition?.cfgStore).toEqual(standalone);
  });
});

test("sanitize-present resets a foreign shape before seeding the local hash", async () => {
  const pointer: ConfigStoreIdentity = {
    repoKind: "worktree",
    commonDir: { realpath: "/foreign/.git", dev: "1", ino: "2", birthtime: "3" },
  };
  await withHarness({
    priorLane: {
      cfgSynced: "hash-A",
      cfgApplied: "applied-A",
      cfgToken: token("old"),
      cfgStore: pointer,
    },
    wireSection: section(INCOMING, "scoped"),
    incomingAbsent: true,
  }, async ({ receiver }) => {
    const transition = await receiver.recordBaseline();
    expect(transition).toEqual({
      cfgSynced: gitConfigHash({}),
      cfgStore: standalone,
    });
  });
});

test("wire absence consumes only the authorship marker", async () => {
  await withHarness({
    priorLane: {
      cfgSynced: "hash-A",
      cfgApplied: "applied-A",
      cfgToken: token("old"),
      cfgStore: standalone,
    },
    wireSection: section(undefined),
    incomingAbsent: true,
  }, async ({ receiver }) => {
    expect(await receiver.recordBaseline()).toEqual({
      cfgApplied: "applied-A",
      cfgToken: token("old"),
      cfgStore: standalone,
    });
  });
});

test("wire absence with no authorship marker is a no-op", async () => {
  await withHarness({
    priorLane: { cfgApplied: "applied-A", cfgStore: standalone },
    wireSection: section(undefined),
    incomingAbsent: true,
  }, async ({ receiver }) => {
    expect(await receiver.recordBaseline()).toBeUndefined();
    expect(receiver.transition()).toBeUndefined();
  });
});

test("shape invalidation returns the existing ConfigLaneState shape exactly once", async () => {
  const pointer: ConfigStoreIdentity = {
    repoKind: "worktree",
    commonDir: { realpath: "/foreign/.git", dev: "1", ino: "2", birthtime: "3" },
  };
  await withHarness({
    priorLane: { cfgSynced: "s", cfgApplied: "a", cfgToken: token("t"), cfgStore: pointer },
  }, async ({ receiver }) => {
    const first = await receiver.prepare(undefined);
    expect(first.transition).toEqual({ cfgStore: standalone });
    const second = await receiver.prepare(undefined);
    expect(second.transition).toEqual({ cfgStore: standalone });
    expect(receiver.transition()).toEqual({ cfgStore: standalone });
  });
});

test("unchanged hash and stat token perform no config effect or state transition", async () => {
  const snapshot = await readConfigSnapshot(path.join(repoDir, ".git", "config"));
  if (!snapshot.ok) throw new Error("test config unreadable");
  await withHarness({
    priorLane: {
      cfgApplied: gitConfigHash(INCOMING),
      cfgToken: snapshot.snapshot.token,
      cfgStore: standalone,
    },
    result: completedTransaction(),
  }, async ({ receiver, calls }) => {
    expect(await receiver.prepare(undefined)).toEqual({
      due: false,
      requiresMaterialization: false,
      transition: undefined,
    });
    expect(await receiver.applyExisting()).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

test("the config-lane kill switch preserves the prior lane and performs no effects", async () => {
  await withHarness({
    priorLane: { cfgSynced: "s", cfgApplied: "a", cfgToken: token("t"), cfgStore: standalone },
    laneDisabled: true,
    result: completedTransaction(),
  }, async ({ receiver, calls }) => {
    expect(await receiver.recordBaseline()).toBeUndefined();
    expect(await receiver.prepare(undefined)).toEqual({
      due: false,
      requiresMaterialization: false,
      transition: undefined,
    });
    expect(await receiver.applyExisting()).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
