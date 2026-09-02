import { expect, test } from "bun:test";
import { normalizedAfterAuthoredRefs } from "./resolve-take-theirs.js";
import type { SnapshotIdentity } from "./resolve-evidence.js";

/** Issue #647. The confirmed identity's `reflogs` are built in code-point ref
 *  order (resolution-intent.ts sorts `Object.keys(refs)` with a bare `.sort()`);
 *  the boundary normalization must hand back that SAME order. A repo with
 *  mixed-case branch names (`refs/heads/BrianVia/…` next to
 *  `refs/heads/brext-…`) is where a locale comparator diverges from code-point
 *  order, so it deterministically failed its own confirmation forever. */
const identity = (refs: Array<[string, string]>, reflogs: Array<[string, string[]]>): SnapshotIdentity => ({
  stream: "s", stateNonce: "n", incomingKey: "k", refs, reflogs,
  head: "ref: refs/heads/main\n", index: { kind: "projected", value: "i" }, opState: [], stash: [],
  oracleReceipt: null, config: { ownership: "owned", read: "ok" }, effectiveRefScope: "all",
  capturePolicy: { syncGit: true, respectGitignore: true }, repoKind: "dir", repositoryIdentity: "r",
});

// The order resolutionBindingIdentity emits: code-point, `BrianVia` first.
const MIXED_CASE_REFS: Array<[string, string]> = [
  ["refs/heads/BrianVia/backfill", "aaa1"],
  ["refs/heads/brext-cohort-attribute", "bbb2"],
  ["refs/heads/main", "ccc3"],
];
const MIXED_CASE_LOGS: Array<[string, string[]]> = [
  ["refs/heads/BrianVia/backfill", ["aaa1"]],
  ["refs/heads/brext-cohort-attribute", ["bbb2"]],
  ["refs/heads/main", ["ccc3"]],
];

test("an rbox protocol write that changes no ref leaves the boundary identity confirmable", () => {
  const confirmed = identity(MIXED_CASE_REFS, MIXED_CASE_LOGS);
  // Nothing the human consented to has changed: same refs, same reflog oids,
  // and the checkout authored no ref change yet. Normalization must be the
  // identity function, or the confirmation refuses itself forever (#647).
  const normalized = normalizedAfterAuthoredRefs(identity(MIXED_CASE_REFS, MIXED_CASE_LOGS), confirmed, []);
  expect(JSON.stringify(normalized)).toBe(JSON.stringify(confirmed));
});

test("a real local commit between show and confirm still refuses", () => {
  const confirmed = identity(MIXED_CASE_REFS, MIXED_CASE_LOGS);
  const movedRefs = MIXED_CASE_REFS.map(([ref, oid]) =>
    ref === "refs/heads/main" ? [ref, "ddd4"] : [ref, oid]) as Array<[string, string]>;
  const movedLogs = MIXED_CASE_LOGS.map(([ref, oids]) =>
    ref === "refs/heads/main" ? [ref, ["ccc3", "ddd4"]] : [ref, oids]) as Array<[string, string[]]>;
  const normalized = normalizedAfterAuthoredRefs(identity(movedRefs, movedLogs), confirmed, []);
  expect(JSON.stringify(normalized)).not.toBe(JSON.stringify(confirmed));
});
