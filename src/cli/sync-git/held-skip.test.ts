import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git } from "../../engine/git/shared.js";
import { gitPreflight } from "../../engine/index.js";
import type { GitHeldAttempt, TypedBlocker } from "../config.js";
import { GIT_FINGERPRINT_VERSION } from "./fingerprint.js";
import { gitIncomingKey } from "./shared.js";
import {
  blockersAfterComposer,
  createHeldAttempt,
  gitHeldSkipEnabled,
  gitOwnershipHeldSkipEnabled,
  gitOwnershipNoEscalateEnabled,
  heldAttemptFloorElapsed,
  heldAttemptMatches,
  heldAttemptMismatchField,
  heldClassifierInputKey,
  heldBlockersAllowSkip,
  observeHeldInputs,
  readWorktreeRegistryDigest,
} from "./held-skip.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

const localCommit: TypedBlocker = { provenance: "checkout", reason: "local-commits" };
const localEdits: TypedBlocker = { provenance: "checkout", reason: "local-edits" };
const localStash: TypedBlocker = { provenance: "ref-plane", reason: "local-stash", ref: "refs/stash" };
const deletionPending: TypedBlocker = { provenance: "ref-plane", reason: "deletion-pending", ref: "refs/heads/deleted" };
const localIndex: TypedBlocker = { provenance: "checkout", reason: "local-index" };
const localOperation: TypedBlocker = { provenance: "checkout", reason: "local-operation" };
const ownership: TypedBlocker = {
  provenance: "ref-plane", reason: "worktree-ownership", ref: "refs/heads/topic",
};

test("held skip is non-vacuous and every blocker must be allowlisted", () => {
  expect(heldBlockersAllowSkip([])).toBe(false);
  expect(heldBlockersAllowSkip([localEdits, localCommit, localStash])).toBe(true);
  expect(heldBlockersAllowSkip([deletionPending])).toBe(true);
  expect(heldBlockersAllowSkip([localCommit, localStash, localIndex, localOperation])).toBe(true);
  expect(heldBlockersAllowSkip([localCommit, { provenance: "indeterminate", reason: "unreadable", detail: "missing object" }])).toBe(false);
  expect(heldBlockersAllowSkip([ownership])).toBe(true);
  expect(heldBlockersAllowSkip([ownership], { RBOX_GIT_OWNERSHIP_HELD_SKIP: "0" })).toBe(false);
  expect(heldBlockersAllowSkip([{ provenance: "checkout", reason: "worktree-ownership" }])).toBe(true);
  expect(gitHeldSkipEnabled({ RBOX_GIT_HELD_SKIP: "0" })).toBe(false);
  expect(gitOwnershipHeldSkipEnabled({})).toBe(true);
  expect(gitOwnershipHeldSkipEnabled({ RBOX_GIT_OWNERSHIP_HELD_SKIP: "0" })).toBe(false);
  expect(gitOwnershipHeldSkipEnabled({ RBOX_GIT_OWNERSHIP_HELD_SKIP: "false" })).toBe(true);
  expect(gitOwnershipNoEscalateEnabled({})).toBe(true);
  expect(gitOwnershipNoEscalateEnabled({ RBOX_GIT_OWNERSHIP_NO_ESCALATE: "0" })).toBe(false);
  expect(gitOwnershipNoEscalateEnabled({ RBOX_GIT_OWNERSHIP_NO_ESCALATE: "false" })).toBe(true);
});

test("worktree ownership neutralizes only its causal missing branch proof", () => {
  const mapped = blockersAfterComposer({
    classification: [ownership],
    disposition: "pending",
    holds: [{ ref: "refs/heads/topic", code: "missing-branch-proof" }],
    checkoutComplete: true,
  });
  expect(mapped).toEqual([ownership]);
  expect(heldBlockersAllowSkip(mapped)).toBe(true);

  const mismatched = blockersAfterComposer({
    classification: [ownership],
    disposition: "pending",
    holds: [{ ref: "refs/heads/topic", code: "mismatched-branch-proof" }],
    checkoutComplete: true,
  });
  expect(mismatched).toContainEqual(expect.objectContaining({
    provenance: "composer", code: "mismatched-branch-proof",
  }));
  expect(heldBlockersAllowSkip(mismatched)).toBe(false);
});

test("deletion-pending maps only to the matching missing branch proof", () => {
  const matching = blockersAfterComposer({
    classification: [deletionPending],
    disposition: "pending",
    holds: [{ ref: "refs/heads/deleted", code: "missing-branch-proof" }],
    checkoutComplete: true,
  });
  expect(matching).toEqual([deletionPending]);
  const wrongProof = blockersAfterComposer({
    classification: [deletionPending],
    disposition: "pending",
    holds: [{ ref: "refs/heads/deleted", code: "mismatched-branch-proof" }],
    checkoutComplete: true,
  });
  expect(wrongProof).toContainEqual(expect.objectContaining({
    provenance: "composer", ref: "refs/heads/deleted", code: "mismatched-branch-proof",
  }));
});

test("exact mixed classifier triple grants no extra composer authority", () => {
  const triple: TypedBlocker[] = [
    { provenance: "ref-plane", reason: "local-commits", ref: "refs/heads/topic" },
    localStash,
    localIndex,
  ];
  const matching = blockersAfterComposer({
    classification: triple,
    disposition: "pending",
    holds: [
      { ref: "refs/heads/topic", code: "missing-branch-proof" },
      { ref: "refs/stash", code: "missing-safe-ref-proof" },
    ],
    checkoutComplete: true,
  });
  expect(matching.some((blocker) => blocker.provenance === "composer")).toBe(false);
  expect(heldBlockersAllowSkip(matching)).toBe(true);

  const unmatchedSameRef = blockersAfterComposer({
    classification: triple,
    disposition: "pending",
    holds: [{ ref: "refs/heads/topic", code: "mismatched-branch-proof" }],
    checkoutComplete: true,
  });
  expect(unmatchedSameRef).toContainEqual(expect.objectContaining({
    provenance: "composer", ref: "refs/heads/topic", code: "mismatched-branch-proof",
  }));
  expect(heldBlockersAllowSkip(unmatchedSameRef)).toBe(false);

  const incomplete = blockersAfterComposer({
    classification: triple,
    disposition: "pending",
    holds: [
      { ref: "refs/heads/topic", code: "missing-branch-proof" },
      { ref: "refs/stash", code: "missing-safe-ref-proof" },
    ],
    checkoutComplete: false,
  });
  expect(incomplete).toContainEqual(expect.objectContaining({
    provenance: "composer", code: "checkout-incomplete",
  }));
  expect(heldBlockersAllowSkip(incomplete)).toBe(false);
});

test("composer-pending neutralizes only ref-mapped allowlisted causal holds", () => {
  const classified: TypedBlocker[] = [
    { provenance: "ref-plane", reason: "local-commits", ref: "refs/heads/topic" },
    localStash,
  ];
  const blockers = blockersAfterComposer({
    classification: classified,
    disposition: "pending",
    holds: [
      { ref: "refs/heads/topic", code: "missing-branch-proof" },
      { ref: "refs/stash", code: "missing-safe-ref-proof" },
    ],
    checkoutComplete: true,
  });
  expect(blockers).toEqual(expect.arrayContaining(classified));
  expect(blockers.some((blocker) => blocker.provenance === "composer")).toBe(false);
  expect(heldBlockersAllowSkip(blockers)).toBe(true);
});

test("composer-pending retains unmatched, vacuous, and checkout-incomplete blockers as typed evidence", () => {
  const classified: TypedBlocker[] = [
    { provenance: "ref-plane", reason: "local-commits", ref: "refs/heads/topic" },
  ];
  const unmatched = blockersAfterComposer({
    classification: classified,
    disposition: "pending",
    holds: [
      { ref: "refs/heads/topic", code: "missing-branch-proof" },
      { ref: "refs/heads/foreign", code: "mismatched-branch-proof" },
    ],
    checkoutComplete: true,
  });
  expect(unmatched).toContainEqual({
    provenance: "composer",
    reason: "artifact",
    ref: "refs/heads/foreign",
    code: "mismatched-branch-proof",
    detail: "BASE composer hold mismatched-branch-proof at refs/heads/foreign",
  });
  expect(unmatched).not.toContainEqual(expect.objectContaining({
    provenance: "composer", ref: "refs/heads/topic",
  }));
  expect(heldBlockersAllowSkip(unmatched)).toBe(false);

  const sameRefIndependentVeto = blockersAfterComposer({
    classification: classified,
    disposition: "pending",
    holds: [{ ref: "refs/heads/topic", code: "mismatched-branch-proof" }],
    checkoutComplete: true,
  });
  expect(sameRefIndependentVeto).toContainEqual(expect.objectContaining({
    provenance: "composer", ref: "refs/heads/topic", code: "mismatched-branch-proof",
  }));
  expect(heldBlockersAllowSkip(sameRefIndependentVeto)).toBe(false);

  const reasonStringIsNotAuthority = blockersAfterComposer({
    classification: [localCommit],
    disposition: "pending",
    holds: [{ ref: "refs/heads/topic", code: "missing-branch-proof" }],
    checkoutComplete: true,
  });
  expect(reasonStringIsNotAuthority).toContainEqual(expect.objectContaining({
    provenance: "composer", ref: "refs/heads/topic",
  }));

  const vacuous = blockersAfterComposer({
    classification: [],
    disposition: "pending",
    holds: [{ ref: "refs/heads/foreign", code: "scope-refused" }],
    checkoutComplete: true,
  });
  expect(vacuous).toContainEqual(expect.objectContaining({
    provenance: "composer", ref: "refs/heads/foreign", code: "scope-refused",
  }));
  expect(heldBlockersAllowSkip(vacuous)).toBe(false);

  const incomplete = blockersAfterComposer({
    classification: classified,
    disposition: "pending",
    holds: [{ ref: "refs/heads/topic", code: "missing-branch-proof" }],
    checkoutComplete: false,
  });
  expect(incomplete).toContainEqual(expect.objectContaining({
    provenance: "composer", code: "checkout-incomplete",
  }));
  expect(heldBlockersAllowSkip(incomplete)).toBe(false);
});

test("independent non-allowlisted classifier prevents composer neutralization", () => {
  const blockers = blockersAfterComposer({
    classification: [
      { provenance: "ref-plane", reason: "local-commits", ref: "refs/heads/topic" },
      { provenance: "protocol", reason: "artifact", detail: "foreign artifact veto" },
    ],
    disposition: "pending",
    holds: [{ ref: "refs/heads/topic", code: "missing-branch-proof" }],
    checkoutComplete: true,
  });
  expect(blockers).toContainEqual(expect.objectContaining({
    provenance: "composer", ref: "refs/heads/topic",
  }));
  expect(heldBlockersAllowSkip(blockers)).toBe(false);
});

test("attempt matching binds nonce/version and the one-hour floor", () => {
  const now = Date.parse("2026-07-21T12:00:00.000Z");
  const observation = {
    incomingKey: "incoming", localFingerprint: "fp", fingerprintVersion: GIT_FINGERPRINT_VERSION,
    effectiveBaseIndexProjection: null, effectiveIncomingIndexProjection: null,
    incomingIndexArtifactDescriptor: "null",
    worktreeRegistryDigest: "worktrees",
    maxFingerprintTimestampMs: now - 10_000, reflogs: [], repoIdentity: "repo", stateNonce: "nonce",
    baseOriginsHash: "base", partialDisposition: "null",
  };
  const attempt = createHeldAttempt(observation, [localCommit], new Date(now - 1_000).toISOString());
  expect(heldAttemptMatches(attempt, observation, now)).toBe(true);
  expect(heldAttemptMatches({ ...attempt, stateNonce: "other" }, observation, now)).toBe(false);
  expect(heldAttemptMatches({ ...attempt, repoIdentity: "other-repo" }, observation, now)).toBe(false);
  const { worktreeRegistryDigest: _digest, ...legacyAttempt } = attempt;
  expect(heldAttemptMatches(legacyAttempt, observation, now)).toBe(false);
  expect(heldAttemptMatches(attempt, { ...observation, worktreeRegistryDigest: "changed" }, now)).toBe(false);
  expect(heldAttemptMatches({ ...attempt, fingerprintVersion: "old" }, observation, now)).toBe(false);
  expect(heldAttemptMismatchField({ ...attempt, fingerprintVersion: "old", stateNonce: "other" }, observation, now))
    .toBe("fingerprintVersion");
  expect(heldAttemptMismatchField({ ...attempt, stateNonce: "other" }, observation, now)).toBe("stateNonce");
  expect(heldAttemptMismatchField(legacyAttempt, observation, now)).toBe("worktreeRegistryDigest");
  expect(heldAttemptMismatchField(attempt, observation, now)).toBeUndefined();
  expect(heldAttemptFloorElapsed(attempt, now)).toBe(false);
  expect(heldAttemptFloorElapsed({ ...attempt, at: new Date(now - 3_600_001).toISOString() }, now)).toBe(true);
});

test("idxProj-only effective BASE repair invalidates an attempt", () => {
  const now = Date.parse("2026-07-21T12:00:00.000Z");
  const observation = {
    incomingKey: "incoming", localFingerprint: "fp", fingerprintVersion: GIT_FINGERPRINT_VERSION,
    effectiveBaseIndexProjection: "v2:stale", effectiveIncomingIndexProjection: "v2:incoming",
    incomingIndexArtifactDescriptor: "null", maxFingerprintTimestampMs: now - 10_000,
    worktreeRegistryDigest: "worktrees",
    reflogs: [], repoIdentity: "repo", stateNonce: "nonce", baseOriginsHash: "base", partialDisposition: "null",
  };
  const attempt = createHeldAttempt(observation, [localIndex], new Date(now - 1_000).toISOString());
  expect(heldAttemptMatches(attempt, { ...observation, effectiveBaseIndexProjection: "v2:repaired" }, now)).toBe(false);
});

test("same indexSha with a changed incoming locator invalidates an attempt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-held-locator-"));
  roots.push(root);
  await git(root, ["init", "-b", "main"]);
  const baseSection = {
    bundleSha: "1".repeat(64), bundleEncSha: "2".repeat(64), bundleCipherSize: 1,
    head: "ref: refs/heads/main\n", refs: {}, refScope: "all" as const,
    indexSha: "3".repeat(64), indexEncSha: "4".repeat(64), indexCipherSize: 10,
  };
  const changedLocator = { ...baseSection, indexEncSha: "5".repeat(64), indexCipherSize: 11 };
  expect(gitIncomingKey(changedLocator)).toBe(gitIncomingKey(baseSection));
  const common = {
    root, relPath: ".", stateNonce: "nonce",
    effectiveBaseIndexProjection: null, effectiveIncomingIndexProjection: "v2:incoming", reflogPaths: [],
  };
  const before = await observeHeldInputs({ ...common, incoming: baseSection });
  expect(before).toBeDefined();
  const attempt = createHeldAttempt(before!, [localIndex], new Date(Date.now() + 3_000).toISOString());
  const after = await observeHeldInputs({ ...common, incoming: changedLocator });
  expect(after).toBeDefined();
  expect(heldAttemptMatches(attempt, after!, Date.now() + 6_000)).toBe(false);
});

test("held classifier identity ignores bundle recapture but not semantic inputs", () => {
  const baseSection = {
    bundleSha: "1".repeat(64), bundleEncSha: "2".repeat(64), bundleCipherSize: 1,
    head: "ref: refs/heads/main\n", refs: { "refs/heads/main": "3".repeat(40) }, refScope: "all" as const,
  };
  const recaptured = {
    ...baseSection,
    bundleSha: "4".repeat(64), bundleEncSha: "5".repeat(64), bundleCipherSize: 2,
    packChain: [{
      sha: "6".repeat(64), encSha: "7".repeat(64), cipherSize: 3,
      tips: ["3".repeat(40)],
    }],
  };
  expect(heldClassifierInputKey(recaptured)).toBe(heldClassifierInputKey(baseSection));
  expect(heldClassifierInputKey({ ...recaptured, head: "3".repeat(40) })).not.toBe(heldClassifierInputKey(baseSection));
});

test("worktree removal changes the registry digest without changing refs, HEAD, or index", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-held-worktree-"));
  const sibling = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-held-worktree-sibling-parent-"));
  roots.push(root, sibling);
  const linked = path.join(sibling, "linked");
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(root, "f"), "a");
  await git(root, ["add", "f"]);
  await git(root, ["commit", "-m", "a"]);
  await git(root, ["branch", "side"]);
  await git(root, ["worktree", "add", "-q", linked, "side"]);

  const stableBefore = {
    refs: await git(root, ["show-ref"]),
    head: await git(root, ["symbolic-ref", "HEAD"]),
    index: await git(root, ["ls-files", "-s"]),
  };
  const digestBefore = await readWorktreeRegistryDigest(root);
  await git(root, ["worktree", "remove", "--force", linked]);
  const digestAfter = await readWorktreeRegistryDigest(root);
  expect(digestAfter).not.toBe(digestBefore);
  expect({
    refs: await git(root, ["show-ref"]),
    head: await git(root, ["symbolic-ref", "HEAD"]),
    index: await git(root, ["ls-files", "-s"]),
  }).toEqual(stableBefore);
});

test("a linked-worktree branch switch inside the observation bracket refuses the attempt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-held-worktree-race-"));
  const siblingParent = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-held-worktree-race-parent-"));
  roots.push(root, siblingParent);
  const linked = path.join(siblingParent, "linked");
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(root, "f"), "a");
  await git(root, ["add", "f"]);
  await git(root, ["commit", "-m", "a"]);
  const tip = (await git(root, ["rev-parse", "HEAD"])).trim();
  await git(root, ["branch", "side"]);
  await git(root, ["branch", "other"]);
  await git(root, ["worktree", "add", "-q", linked, "side"]);
  const incoming = {
    bundleSha: "1".repeat(64),
    bundleEncSha: "2".repeat(64),
    bundleCipherSize: 1,
    head: "ref: refs/heads/main\n",
    refs: {
      "refs/heads/main": tip,
      "refs/heads/side": tip,
      "refs/heads/other": tip,
    },
    refScope: "all" as const,
  };
  const opts = {
    root,
    relPath: ".",
    incomingKey: "incoming",
    incoming,
    stateNonce: "nonce",
    effectiveBaseIndexProjection: null,
    effectiveIncomingIndexProjection: null,
    reflogPaths: [],
  };
  const before = await observeHeldInputs(opts);
  expect(before).toBeDefined();
  await git(linked, ["switch", "-q", "other"]);
  const after = await observeHeldInputs(opts);
  expect(after).toBeDefined();
  expect(after!.localFingerprint).toBe(before!.localFingerprint);
  expect(after!.worktreeRegistryDigest).not.toBe(before!.worktreeRegistryDigest);

  await git(linked, ["switch", "-q", "side"]);
  const raced = await observeHeldInputs({
    ...opts,
    afterWorktreeRegistryRead: async () => {
      await git(linked, ["switch", "-q", "other"]);
    },
  });
  expect(raced).toBeUndefined();
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
  const opts = {
    root, relPath: ".", incomingKey: "incoming", incoming, stateNonce: "nonce",
    effectiveBaseIndexProjection: null, effectiveIncomingIndexProjection: null,
    reflogPaths: ["logs/refs/stash"],
  };
  const before = await observeHeldInputs(opts);
  expect(before).toBeDefined();
  const attempt: GitHeldAttempt = createHeldAttempt(before!, [localStash], new Date(Date.now() + 3_000).toISOString());
  await fs.appendFile(logPath, `${tip} ${tip} Test <test@example.com> 2 +0000\ttwo\n`);
  await fs.writeFile(logPath, `${tip} ${tip} Test <test@example.com> 3 +0000\tthree\n`);
  const after = await observeHeldInputs(opts);
  expect(after).toBeDefined();
  // Generic divergence fingerprints intentionally exclude reflog side effects;
  // held-skip still invalidates through the exact consulted reflog digest above.
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
