import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git } from "../../engine/git/shared.js";
import { gitPreflight } from "../../engine/index.js";
import type { GitHeldAttempt, TypedBlocker } from "../config.js";
import { GIT_FINGERPRINT_VERSION } from "./fingerprint.js";
import {
  createHeldAttempt,
  gitHeldSkipEnabled,
  heldAttemptFloorElapsed,
  heldAttemptMatches,
  heldBlockersAllowSkip,
  observeHeldInputs,
} from "./held-skip.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

const localCommit: TypedBlocker = { provenance: "checkout", reason: "local-commits" };
const localStash: TypedBlocker = { provenance: "ref-plane", reason: "local-stash", ref: "refs/stash" };

test("held skip is non-vacuous and every blocker must be allowlisted", () => {
  expect(heldBlockersAllowSkip([])).toBe(false);
  expect(heldBlockersAllowSkip([localCommit, localStash])).toBe(true);
  expect(heldBlockersAllowSkip([localCommit, { provenance: "indeterminate", reason: "unreadable", detail: "missing object" }])).toBe(false);
  expect(heldBlockersAllowSkip([localStash, { provenance: "checkout", reason: "worktree-ownership" }])).toBe(false);
  expect(gitHeldSkipEnabled({ RBOX_GIT_HELD_SKIP: "0" })).toBe(false);
});

test("attempt matching binds nonce/version and the one-hour floor", () => {
  const now = Date.parse("2026-07-21T12:00:00.000Z");
  const observation = {
    incomingKey: "incoming", localFingerprint: "fp", fingerprintVersion: GIT_FINGERPRINT_VERSION,
    maxFingerprintTimestampMs: now - 10_000, reflogs: [], repoIdentity: "repo", stateNonce: "nonce",
    baseOriginsHash: "base", partialDisposition: "null",
  };
  const attempt = createHeldAttempt(observation, [localCommit], new Date(now - 1_000).toISOString());
  expect(heldAttemptMatches(attempt, observation, now)).toBe(true);
  expect(heldAttemptMatches({ ...attempt, stateNonce: "other" }, observation, now)).toBe(false);
  expect(heldAttemptMatches({ ...attempt, repoIdentity: "other-repo" }, observation, now)).toBe(false);
  expect(heldAttemptMatches({ ...attempt, fingerprintVersion: "old" }, observation, now)).toBe(false);
  expect(heldAttemptFloorElapsed(attempt, now)).toBe(false);
  expect(heldAttemptFloorElapsed({ ...attempt, at: new Date(now - 3_600_001).toISOString() }, now)).toBe(true);
});

test("exact consulted stash reflog bytes invalidate T→U→T reflog-only mutation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-held-key-"));
  roots.push(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(root, "f"), "a");
  await git(root, ["add", "f"]);
  await git(root, ["commit", "-m", "a"]);
  const tip = await git(root, ["rev-parse", "HEAD"]);
  const logPath = path.join(root, ".git", "logs", "refs", "stash");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, `${tip} ${tip} Test <test@example.com> 1 +0000\tone\n`);
  const incoming = { bundleSha: "1".repeat(64), bundleEncSha: "2".repeat(64), bundleCipherSize: 1, head: "ref: refs/heads/main\n", refs: { "refs/heads/main": tip }, refScope: "all" as const };
  const opts = { root, relPath: ".", incomingKey: "incoming", incoming, stateNonce: "nonce", reflogPaths: ["logs/refs/stash"] };
  const before = await observeHeldInputs(opts);
  expect(before).toBeDefined();
  const attempt: GitHeldAttempt = createHeldAttempt(before!, [localStash], new Date(Date.now() + 3_000).toISOString());
  await fs.appendFile(logPath, `${tip} ${tip} Test <test@example.com> 2 +0000\ttwo\n`);
  await fs.writeFile(logPath, `${tip} ${tip} Test <test@example.com> 3 +0000\tthree\n`);
  const after = await observeHeldInputs(opts);
  expect(after).toBeDefined();
  expect(after!.localFingerprint).toBe(before!.localFingerprint);
  expect(heldAttemptMatches(attempt, after!, Date.now() + 6_000)).toBe(false);
});

test("legacy graft files are structurally unsupported", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-held-graft-"));
  roots.push(root);
  await git(root, ["init", "-b", "main"]);
  await fs.mkdir(path.join(root, ".git", "info"), { recursive: true });
  await fs.writeFile(path.join(root, ".git", "info", "grafts"), "0".repeat(40));
  expect(await gitPreflight(root)).toMatchObject({ ok: false, structural: true });
});
