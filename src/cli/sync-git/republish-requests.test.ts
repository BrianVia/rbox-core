import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GitSection } from "../../engine/types.js";
import {
  readRepublishStore,
  recordRepublishRequest,
  republishPlanInput,
  republishRequestsPath,
  republishSatisfiedBy,
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

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-republish-store-"));
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

test("records a request, is idempotent, and settles once a new chain-free bundle lands", async () => {
  const first = await recordRepublishRequest(root, STREAM, "repo", BASE, at("2026-07-28T00:00:00.000Z"));
  expect(first).toEqual({ status: "recorded", requestedAt: "2026-07-28T00:00:00.000Z", pending: 1 });

  const again = await recordRepublishRequest(root, STREAM, "repo", BASE, at("2026-07-28T00:05:00.000Z"));
  expect(again.status).toBe("already-pending");
  expect(again.requestedAt).toBe("2026-07-28T00:00:00.000Z");
  expect((await republishPlanInput(root, STREAM)).repos).toEqual(new Set(["repo"]));

  expect(await settleRepublishRequests(root, STREAM, { repo: section() })).toEqual(["repo"]);
  expect((await republishPlanInput(root, STREAM)).repos.size).toBe(0);
  expect(await readRepublishStore(root, STREAM)).toEqual({ status: "absent" });
});

test("a carried base, a chained section, and an absent section never settle a request", async () => {
  await recordRepublishRequest(root, STREAM, "repo", BASE, at("2026-07-28T00:00:00.000Z"));

  // Carried BASE: the exact section the request superseded.
  expect(await settleRepublishRequests(root, STREAM, {
    repo: section({ bundleSha: SHA_BASE, generatedAt: BASE_AT }),
  })).toEqual([]);
  // A fresh capture that still carries a chain has not restarted anything.
  expect(await settleRepublishRequests(root, STREAM, {
    repo: section({ packChain: [{ sha: SHA_BASE, encSha: "d".repeat(64), cipherSize: 1, tips: ["0".repeat(40)] }] }),
  })).toEqual([]);
  // Files-first genesis commits carry no gitRepos at all.
  expect(await settleRepublishRequests(root, STREAM, undefined)).toEqual([]);
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
  await recordRepublishRequest(root, STREAM, "repo", BASE, at("2026-07-28T00:00:00.000Z"));
  await recordRepublishRequest(root, STREAM, "other", BASE, at("2026-07-28T00:00:01.000Z"));
  expect(await settleRepublishRequests(root, STREAM, { repo: section() })).toEqual(["repo"]);
  expect((await republishPlanInput(root, STREAM)).repos).toEqual(new Set(["other"]));
});

test("a store written under another workspace binding never forces or settles here", async () => {
  await recordRepublishRequest(root, STREAM, "repo", BASE, at("2026-07-28T00:00:00.000Z"));
  expect(await readRepublishStore(root, "stream-b")).toEqual({ status: "foreign" });
  expect((await republishPlanInput(root, "stream-b")).repos.size).toBe(0);
  expect(await settleRepublishRequests(root, "stream-b", { repo: section() })).toEqual([]);
  expect((await republishPlanInput(root, STREAM)).repos).toEqual(new Set(["repo"]));
});

test("a corrupt store reads as no requests with a warning, and refuses to be overwritten", async () => {
  await fs.mkdir(path.dirname(republishRequestsPath(root)), { recursive: true });
  await fs.writeFile(republishRequestsPath(root), "{ not json");
  expect(await readRepublishStore(root, STREAM)).toEqual({ status: "corrupt" });

  const planned = await republishPlanInput(root, STREAM);
  expect(planned.repos.size).toBe(0);
  expect(planned.warning).toContain("git-republish.json");

  await expect(recordRepublishRequest(root, STREAM, "repo", BASE, at("2026-07-28T00:00:00.000Z")))
    .rejects.toThrow(/unreadable/);
  expect(await fs.readFile(republishRequestsPath(root), "utf8")).toBe("{ not json");
});

test("a new request at capacity is refused rather than evicting a live one", async () => {
  for (let i = 0; i < REPUBLISH_REQUESTS_MAX; i++) {
    await recordRepublishRequest(root, STREAM, `repo-${i}`, BASE, at("2026-07-28T00:00:00.000Z"));
  }
  await expect(recordRepublishRequest(root, STREAM, "one-too-many", BASE, at("2026-07-28T00:00:00.000Z")))
    .rejects.toThrow(/already pending/);
  expect((await republishPlanInput(root, STREAM)).repos.size).toBe(REPUBLISH_REQUESTS_MAX);
});

test("a repository with no published bundle cannot be requested", async () => {
  await expect(recordRepublishRequest(root, STREAM, "repo", { bundleSha: "", generatedAt: BASE_AT }, at("2026-07-28T00:00:00.000Z")))
    .rejects.toThrow(/no published Git bundle/);
});
