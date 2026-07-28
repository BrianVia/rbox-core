import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GitSection } from "../../engine/types.js";
import { withWorkspaceSyncMutex, type WorkspaceSyncMutex } from "../sync-mutex.js";
import {
  readRepublishStore,
  recordRepublishRequest,
  republishPlanInput,
  republishRequestsPath,
  republishSatisfiedBy,
  RepublishStoreChangedError,
  settleRepublishRequests,
  REPUBLISH_REQUESTS_MAX,
} from "./republish-requests.js";

const STREAM = "stream-a";
const SHA_BASE = "a".repeat(64);
const SHA_NEXT = "b".repeat(64);
const BASE_AT = "2026-07-27T00:00:00.000Z";
const BASE = { bundleSha: SHA_BASE, generatedAt: BASE_AT };
let root = "";

const at = (iso: string): Date => new Date(iso);

function section(over: Partial<GitSection> = {}): GitSection {
  return {
    bundleSha: SHA_NEXT,
    bundleEncSha: "c".repeat(64),
    bundleCipherSize: 10,
    head: "ref: refs/heads/main",
    refs: {},
    refScope: "all",
    generatedAt: "2026-07-28T00:00:10.000Z",
    ...over,
  } as GitSection;
}

const request = { relPath: "repo", requestedAt: "2026-07-28T00:00:00.000Z", baseBundleSha: SHA_BASE, baseGeneratedAt: BASE_AT };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const recordHeld = (
  mutex: WorkspaceSyncMutex,
  relPath: string,
  when: string,
  stream = STREAM,
  afterRead?: () => Promise<void>,
) => recordRepublishRequest(root, stream, relPath, BASE, at(when), mutex, { afterRead });

const settleHeld = (
  mutex: WorkspaceSyncMutex,
  stream: string,
  gitRepos: Record<string, GitSection> | undefined,
  afterRead?: () => Promise<void>,
) => settleRepublishRequests(root, stream, gitRepos, mutex, { afterRead });

const record = (
  relPath: string,
  when: string,
  base = BASE,
  stream = STREAM,
) => withWorkspaceSyncMutex(root, (mutex) =>
  recordRepublishRequest(root, stream, relPath, base, at(when), mutex));

const settle = (
  gitRepos: Record<string, GitSection> | undefined,
  stream = STREAM,
) => withWorkspaceSyncMutex(root, (mutex) =>
  settleRepublishRequests(root, stream, gitRepos, mutex));

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-republish-store-"));
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

test("records a request, is idempotent, and settles once a new chain-free bundle lands", async () => {
  const first = await record("repo", "2026-07-28T00:00:00.000Z");
  expect(first).toEqual({ status: "recorded", requestedAt: "2026-07-28T00:00:00.000Z", pending: 1 });

  const again = await record("repo", "2026-07-28T00:05:00.000Z");
  expect(again.status).toBe("already-pending");
  expect(again.requestedAt).toBe("2026-07-28T00:00:00.000Z");
  expect((await republishPlanInput(root, STREAM)).repos).toEqual(new Set(["repo"]));

  expect(await settle({ repo: section() })).toEqual(["repo"]);
  expect((await republishPlanInput(root, STREAM)).repos.size).toBe(0);
  expect(await readRepublishStore(root, STREAM)).toEqual({ status: "absent" });
});

test("a carried base, a chained section, and an absent section never settle a request", async () => {
  await record("repo", "2026-07-28T00:00:00.000Z");

  // Carried BASE: the exact section the request superseded.
  expect(await settle({
    repo: section({ bundleSha: SHA_BASE, generatedAt: BASE_AT }),
  })).toEqual([]);
  // A fresh capture that still carries a chain has not restarted anything.
  expect(await settle({
    repo: section({ packChain: [{ sha: SHA_BASE, encSha: "d".repeat(64), cipherSize: 1, tips: ["0".repeat(40)] }] }),
  })).toEqual([]);
  // Files-first genesis commits carry no gitRepos at all.
  expect(await settle(undefined)).toEqual([]);
  expect((await republishPlanInput(root, STREAM)).repos).toEqual(new Set(["repo"]));
});

test("settlement is causal, not chronological: only the superseded BASE fails to settle", () => {
  expect(republishSatisfiedBy(section({ bundleSha: SHA_BASE, generatedAt: BASE_AT }), request)).toBe(false);
  // No clock ordering can settle or strand a request: a restart with a stamp
  // from before the request still settles, and a carried BASE with a stamp from
  // after it still does not.
  expect(republishSatisfiedBy(section({ bundleSha: SHA_NEXT, generatedAt: "2020-01-01T00:00:00.000Z" }), request)).toBe(true);
  expect(republishSatisfiedBy(section({ bundleSha: SHA_BASE, generatedAt: "2030-01-01T00:00:00.000Z" }), request)).toBe(true);
});

test("settling one repository leaves a request installed for another repository", async () => {
  await record("repo", "2026-07-28T00:00:00.000Z");
  await record("other", "2026-07-28T00:00:01.000Z");
  expect(await settle({ repo: section() })).toEqual(["repo"]);
  expect((await republishPlanInput(root, STREAM)).repos).toEqual(new Set(["other"]));
});

test("a store written under another workspace binding never forces or settles here", async () => {
  await record("repo", "2026-07-28T00:00:00.000Z");
  expect(await readRepublishStore(root, "stream-b")).toEqual({ status: "absent" });
  expect((await republishPlanInput(root, "stream-b")).repos.size).toBe(0);
  expect(await settle({ repo: section() }, "stream-b")).toEqual([]);
  expect((await republishPlanInput(root, STREAM)).repos).toEqual(new Set(["repo"]));
});

test("a corrupt store reads as no requests with a warning, and refuses to be overwritten", async () => {
  await fs.mkdir(path.dirname(republishRequestsPath(root)), { recursive: true });
  await fs.writeFile(republishRequestsPath(root), "{ not json");
  expect(await readRepublishStore(root, STREAM)).toEqual({ status: "corrupt" });

  const planned = await republishPlanInput(root, STREAM);
  expect(planned.repos.size).toBe(0);
  expect(planned.warning).toContain("git-republish.json");

  await expect(record("repo", "2026-07-28T00:00:00.000Z"))
    .rejects.toThrow(/unreadable/);
  expect(await fs.readFile(republishRequestsPath(root), "utf8")).toBe("{ not json");
});

test("a new request at capacity is refused rather than evicting a live one", async () => {
  // Fill under one held mutex: 256 separate acquisitions blow the per-test
  // budget on a loaded CI shard without changing what the test proves.
  await withWorkspaceSyncMutex(root, async (mutex) => {
    for (let i = 0; i < REPUBLISH_REQUESTS_MAX; i++) {
      await recordHeld(mutex, `repo-${i}`, "2026-07-28T00:00:00.000Z");
    }
  });
  await expect(record("one-too-many", "2026-07-28T00:00:00.000Z"))
    .rejects.toThrow(/already pending/);
  expect((await republishPlanInput(root, STREAM)).repos.size).toBe(REPUBLISH_REQUESTS_MAX);
});

test("a repository with no published bundle cannot be requested", async () => {
  await expect(record("repo", "2026-07-28T00:00:00.000Z", { bundleSha: "", generatedAt: BASE_AT }))
    .rejects.toThrow(/no published Git bundle/);
});

test("the workspace mutex serializes two record mutations without losing either request", async () => {
  const firstEntered = deferred();
  const releaseFirst = deferred();
  let secondEntered = false;
  const first = withWorkspaceSyncMutex(root, async (mutex) => {
    firstEntered.resolve();
    await releaseFirst.promise;
    return recordHeld(mutex, "repo", "2026-07-28T00:00:01.000Z");
  });
  await firstEntered.promise;
  const second = withWorkspaceSyncMutex(root, async (mutex) => {
    secondEntered = true;
    return recordHeld(mutex, "other", "2026-07-28T00:00:02.000Z");
  });
  await Promise.resolve();
  expect(secondEntered).toBe(false);
  releaseFirst.resolve();
  await Promise.all([first, second]);

  expect((await republishPlanInput(root, STREAM)).repos).toEqual(new Set(["other", "repo"]));
  await withWorkspaceSyncMutex(root, async (mutex) => {
    await expect(recordHeld(mutex, "stale", "2026-07-28T00:00:03.000Z", STREAM, () =>
      recordHeld(mutex, "winner", "2026-07-28T00:00:04.000Z")))
      .rejects.toBeInstanceOf(RepublishStoreChangedError);
  });
  expect((await republishPlanInput(root, STREAM)).repos).toEqual(new Set(["other", "repo", "winner"]));
  await expect(recordRepublishRequest(root, STREAM, "unlocked", BASE, at("2026-07-28T00:00:00.000Z"), undefined as unknown as WorkspaceSyncMutex))
    .rejects.toMatchObject({ name: "RepublishMutexOwnershipError" });
});

test("the workspace mutex orders record before settle and preserves the unrelated request", async () => {
  await withWorkspaceSyncMutex(root, (mutex) => recordHeld(mutex, "repo", "2026-07-28T00:00:00.000Z"));

  const recordEntered = deferred();
  const releaseRecord = deferred();
  let settleEntered = false;
  const recording = withWorkspaceSyncMutex(root, async (mutex) => {
    recordEntered.resolve();
    await releaseRecord.promise;
    return recordHeld(mutex, "other", "2026-07-28T00:00:01.000Z");
  });
  await recordEntered.promise;
  const settling = withWorkspaceSyncMutex(root, async (mutex) => {
    settleEntered = true;
    return settleHeld(mutex, STREAM, { repo: section() });
  });
  await Promise.resolve();
  expect(settleEntered).toBe(false);
  releaseRecord.resolve();
  const [, settled] = await Promise.all([recording, settling]);

  expect(settled).toEqual(["repo"]);
  expect((await republishPlanInput(root, STREAM)).repos).toEqual(new Set(["other"]));
  await withWorkspaceSyncMutex(root, async (mutex) => {
    await expect(recordHeld(mutex, "stale", "2026-07-28T00:00:02.000Z", STREAM, () =>
      settleHeld(mutex, STREAM, { other: section() }).then(() => {})))
      .rejects.toBeInstanceOf(RepublishStoreChangedError);
  });
  expect((await republishPlanInput(root, STREAM)).repos.size).toBe(0);
});

test("an old-stream settle cannot unlink a new-stream record", async () => {
  await withWorkspaceSyncMutex(root, (mutex) => recordHeld(mutex, "repo", "2026-07-28T00:00:00.000Z"));

  const newStreamEntered = deferred();
  const releaseNewStream = deferred();
  let oldSettleEntered = false;
  const recording = withWorkspaceSyncMutex(root, async (mutex) => {
    newStreamEntered.resolve();
    await releaseNewStream.promise;
    return recordHeld(mutex, "new-repo", "2026-07-28T00:00:01.000Z", "stream-b");
  });
  await newStreamEntered.promise;
  const settling = withWorkspaceSyncMutex(root, async (mutex) => {
    oldSettleEntered = true;
    return settleHeld(mutex, STREAM, { repo: section() });
  });
  await Promise.resolve();
  expect(oldSettleEntered).toBe(false);
  releaseNewStream.resolve();
  const [, settled] = await Promise.all([recording, settling]);

  expect(settled).toEqual([]);
  expect((await republishPlanInput(root, "stream-b")).repos).toEqual(new Set(["new-repo"]));

  await withWorkspaceSyncMutex(root, async (mutex) => {
    await recordHeld(mutex, "old-repo", "2026-07-28T00:00:02.000Z", STREAM);
    await expect(settleHeld(mutex, STREAM, { "old-repo": section() }, () =>
      recordHeld(mutex, "newer-repo", "2026-07-28T00:00:03.000Z", "stream-b").then(() => {})))
      .rejects.toBeInstanceOf(RepublishStoreChangedError);
  });
  expect((await republishPlanInput(root, "stream-b")).repos).toEqual(new Set(["newer-repo"]));
});
