/**
 * Pure, deterministic descriptions for the design-141 Git-shape fixtures.
 *
 * This module deliberately performs no I/O.  The live scenario executes the
 * argv lists through Device.exec; unit tests can inspect (and selectively run)
 * the same descriptions without needing a rig guest.
 */

export type GitShapeCell =
  | "s1-a"
  | "s1-b"
  | "s1-c"
  | "s2-configured"
  | "s2-unconfigured"
  | "s3-unicode"
  | "s3-case"
  | "s4-shallow"
  | "s4-partial-online"
  | "s4-partial-offline"
  | "s5-merge"
  | "s5-rebase"
  | "s5-cherry-pick"
  | "s5-bisect";

export interface FixtureCommand {
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface FixtureTreeEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "git-dir" | "git-pointer";
  /** UTF-8 pathname bytes. Required for normalization-sensitive entries. */
  readonly pathHex?: string;
}

export interface GitFixtureDescription {
  readonly cell: GitShapeCell;
  readonly commands: readonly FixtureCommand[];
  readonly tree: readonly FixtureTreeEntry[];
  readonly fsckRepos: readonly string[];
  readonly needsGitLfs?: boolean;
  readonly refusal?: string;
}

export interface FixturePlanSummary {
  readonly captured?: readonly string[];
  readonly carried?: readonly string[];
  readonly skipped?: ReadonlyArray<{ relPath: string; reason: string }>;
  readonly deferred?: ReadonlyArray<{ relPath: string; reason: string }>;
  readonly removed?: readonly string[];
}

export const FIXTURE_ROOT = "$FIXTURE_ROOT";
export const FIXTURE_AUX = "$FIXTURE_AUX";

export const NFC_FILENAME = "caf\u00e9.txt";
export const NFD_FILENAME = "cafe\u0301.txt";
export const NFC_FILENAME_HEX = "636166c3a92e747874";
export const NFD_FILENAME_HEX = "63616665cc812e747874";

export const LFS_PAYLOAD = "rbox-lfs-payload\u0000\u0001\u0002\n";

/**
 * The refusal text has one shared home. Product-drift unit tests exercise
 * gitPreflight/validateManifest against these values, while the live scenario
 * imports them instead of retyping user-visible strings.
 */
export const GIT_SHAPE_REFUSALS = Object.freeze({
  modules: ".git/modules present — unsupported",
  shallow: "shallow clone — unsupported (git fetch --unshallow to sync history)",
  caseCollision: "case-insensitive duplicate path: s3-case/Readme.md",
});

/** Shared exact public/log surfaces used by more than one cell assertion. */
export const GIT_SHAPE_SURFACES = Object.freeze({
  applied: (rel: string) => `git-sync applied ${rel}`,
  followed: (rel: string) => `git-sync followed ${rel}`,
  unsupportedCapability: (gitVersion: string, rel: string) => `needs Git >= 2.46 transactional symref-update; found ${gitVersion} on checkout unavailable (${rel})`,
  partialOfflinePendingHuman: "↑ git changes to sync (git changes in 1 repo) — background sync stopped; run `rbox start`",
  partialOfflineReason: "worktree-ownership",
  operationDeferredPrefix: (rel: string) => `git-sync deferred ${rel}: working tree differs from applied manifest; index differs from both base and incoming; operation state differs at`,
  operationResolve: "oracle: dirty; index: diverged; operation state: diverged; stash: clean",
  operationHuman: (rel: string, branch?: string) => `git deferred 0m: local edits on ${branch === undefined ? "detached checkout" : `branch ${branch}`} (${rel})`,
  rebasePostAbortEpipe: "git-sync deferred s5-rebase: EPIPE: broken pipe, write",
  noDeferredRepos: "no deferred repos",
});

/** Product op-state universe, imported by the scenario and drift-pinned in tests. */
export const GIT_SHAPE_OP_STATE_ROOTS = Object.freeze([
  "MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD",
  "ORIG_HEAD", "MERGE_MSG", "AUTO_MERGE",
  "rebase-merge", "rebase-apply", "sequencer",
] as const);

/** Scenario-safe mirror of the product forensic formatter, drift-pinned in tests. */
export function formatFixturePlanLine(summary: FixturePlanSummary): string {
  const captured = [...(summary.captured ?? [])];
  const carried = [...(summary.carried ?? [])];
  const skipped = [...(summary.skipped ?? [])];
  const deferred = [...(summary.deferred ?? [])];
  const removed = [...(summary.removed ?? [])];
  const names = (items: readonly string[]) => items.length ? ` (${items.join(", ")})` : "";
  const reasons = (items: ReadonlyArray<{ relPath: string; reason: string }>) => items.length ? ` (${items.map((item) => `${item.relPath}: ${item.reason}`).join("; ")})` : "";
  return `git-sync: captured ${captured.length}${names(captured)} · carried ${carried.length} · skipped ${skipped.length}${reasons(skipped)} · deferred ${deferred.length}${reasons(deferred)} · removed ${removed.length}${names(removed)}`;
}

const identity = [
  "export GIT_AUTHOR_NAME='Rig Tester' GIT_AUTHOR_EMAIL='rig@example.com'",
  "export GIT_COMMITTER_NAME='Rig Tester' GIT_COMMITTER_EMAIL='rig@example.com'",
];

function shell(cell: GitShapeCell, body: readonly string[], tree: readonly FixtureTreeEntry[], fsckRepos: readonly string[], needsGitLfs = false, refusal?: string): GitFixtureDescription {
  return {
    cell,
    commands: [{ argv: ["sh", "-ceu", ["set -e", ...identity, ...body].join("\n")] }],
    tree,
    fsckRepos,
    ...(needsGitLfs ? { needsGitLfs: true } : {}),
    ...(refusal === undefined ? {} : { refusal }),
  };
}

const repoTree = (path: string): readonly FixtureTreeEntry[] => [
  { path, kind: "directory" },
  { path: `${path}/.git`, kind: "git-dir" },
];

export function buildS1InitializedSubmodule(): GitFixtureDescription {
  return shell("s1-a", [
    "rm -rf \"$FIXTURE_AUX/s1-a-origin\"",
    "mkdir -p \"$FIXTURE_AUX/s1-a-origin\" \"$FIXTURE_ROOT/s1-a\"",
    "git -C \"$FIXTURE_AUX/s1-a-origin\" init -q -b main",
    "printf 'module bytes\\n' > \"$FIXTURE_AUX/s1-a-origin/module.txt\"",
    "git -C \"$FIXTURE_AUX/s1-a-origin\" add module.txt",
    "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' git -C \"$FIXTURE_AUX/s1-a-origin\" commit -q -m module",
    "git -C \"$FIXTURE_ROOT/s1-a\" init -q -b main",
    "printf 'parent bytes\\n' > \"$FIXTURE_ROOT/s1-a/parent.txt\"",
    "git -C \"$FIXTURE_ROOT/s1-a\" -c protocol.file.allow=always submodule add -q \"$FIXTURE_AUX/s1-a-origin\" mod",
    "git -C \"$FIXTURE_ROOT/s1-a\" add parent.txt .gitmodules mod",
    "GIT_AUTHOR_DATE='2026-01-02T00:00:00Z' GIT_COMMITTER_DATE='2026-01-02T00:00:00Z' git -C \"$FIXTURE_ROOT/s1-a\" commit -q -m parent",
  ], [
    ...repoTree("s1-a"),
    { path: "s1-a/.git/modules", kind: "directory" },
    { path: "s1-a/mod", kind: "directory" },
    { path: "s1-a/mod/.git", kind: "git-pointer" },
    { path: "s1-a/.gitmodules", kind: "file" },
    { path: "s1-a/parent.txt", kind: "file" },
    { path: "s1-a/mod/module.txt", kind: "file" },
  ], ["s1-a", "s1-a/mod"], false, GIT_SHAPE_REFUSALS.modules);
}

export function buildS1Pointer(): GitFixtureDescription {
  return shell("s1-b", [
    "rm -rf \"$FIXTURE_AUX/s1-b-common\"",
    "mkdir -p \"$FIXTURE_AUX/s1-b-common\"",
    "git -C \"$FIXTURE_AUX/s1-b-common\" init -q -b main",
    "printf 'pointer bytes\\n' > \"$FIXTURE_AUX/s1-b-common/pointer.txt\"",
    "git -C \"$FIXTURE_AUX/s1-b-common\" add pointer.txt",
    "GIT_AUTHOR_DATE='2026-01-03T00:00:00Z' GIT_COMMITTER_DATE='2026-01-03T00:00:00Z' git -C \"$FIXTURE_AUX/s1-b-common\" commit -q -m pointer",
    "git -C \"$FIXTURE_AUX/s1-b-common\" branch hidden-common",
    "git -C \"$FIXTURE_AUX/s1-b-common\" worktree add -q -b synced \"$FIXTURE_ROOT/s1-b\" main",
  ], [
    { path: "s1-b", kind: "directory" },
    { path: "s1-b/.git", kind: "git-pointer" },
    { path: "s1-b/pointer.txt", kind: "file" },
  ], ["s1-b"]);
}

export function buildS1UninitializedGitlink(): GitFixtureDescription {
  return shell("s1-c", [
    "rm -rf \"$FIXTURE_AUX/s1-c-object\"",
    "mkdir -p \"$FIXTURE_AUX/s1-c-object\" \"$FIXTURE_ROOT/s1-c\"",
    "git -C \"$FIXTURE_AUX/s1-c-object\" init -q -b main",
    "printf 'submodule object\\n' > \"$FIXTURE_AUX/s1-c-object/object.txt\"",
    "git -C \"$FIXTURE_AUX/s1-c-object\" add object.txt",
    "GIT_AUTHOR_DATE='2026-01-04T00:00:00Z' GIT_COMMITTER_DATE='2026-01-04T00:00:00Z' git -C \"$FIXTURE_AUX/s1-c-object\" commit -q -m object",
    "oid=$(git -C \"$FIXTURE_AUX/s1-c-object\" rev-parse HEAD)",
    "git -C \"$FIXTURE_ROOT/s1-c\" init -q -b main",
    "printf '[submodule \"mod\"]\\n\\tpath = mod\\n\\turl = ../s1-c-object\\n' > \"$FIXTURE_ROOT/s1-c/.gitmodules\"",
    "printf 'parent normal\\n' > \"$FIXTURE_ROOT/s1-c/normal.txt\"",
    "git -C \"$FIXTURE_ROOT/s1-c\" add .gitmodules normal.txt",
    "git -C \"$FIXTURE_ROOT/s1-c\" update-index --add --cacheinfo 160000,$oid,mod",
    "GIT_AUTHOR_DATE='2026-01-05T00:00:00Z' GIT_COMMITTER_DATE='2026-01-05T00:00:00Z' git -C \"$FIXTURE_ROOT/s1-c\" commit -q -m gitlink",
    "mkdir -p \"$FIXTURE_ROOT/s1-c/mod\"",
  ], [...repoTree("s1-c"), { path: "s1-c/.gitmodules", kind: "file" }, { path: "s1-c/normal.txt", kind: "file" }, { path: "s1-c/mod", kind: "directory" }], ["s1-c"]);
}

function buildLfs(cell: "s2-configured" | "s2-unconfigured"): GitFixtureDescription {
  return shell(cell, [
    `mkdir -p \"$FIXTURE_ROOT/${cell}\"`,
    `git -C \"$FIXTURE_ROOT/${cell}\" init -q -b main`,
    `if git lfs version >/dev/null 2>&1; then git -C \"$FIXTURE_ROOT/${cell}\" lfs install --local; git -C \"$FIXTURE_ROOT/${cell}\" lfs track '*.bin' >/dev/null; else printf '*.bin filter=lfs diff=lfs merge=lfs -text\\n' > \"$FIXTURE_ROOT/${cell}/.gitattributes\"; fi`,
    `printf 'rbox-lfs-payload\\000\\001\\002\\n' > \"$FIXTURE_ROOT/${cell}/asset.bin\"`,
    `oid=$(sha256sum \"$FIXTURE_ROOT/${cell}/asset.bin\" | awk '{print $1}'); size=$(wc -c < \"$FIXTURE_ROOT/${cell}/asset.bin\" | tr -d ' '); printf 'version https://git-lfs.github.com/spec/v1\\noid sha256:%s\\nsize %s\\n' \"$oid\" \"$size\" > \"$FIXTURE_AUX/${cell}-pointer\"`,
    `blob=$(git -C \"$FIXTURE_ROOT/${cell}\" hash-object -w \"$FIXTURE_AUX/${cell}-pointer\"); git -C \"$FIXTURE_ROOT/${cell}\" add .gitattributes; git -C \"$FIXTURE_ROOT/${cell}\" update-index --add --cacheinfo 100644,$blob,asset.bin`,
    `GIT_AUTHOR_DATE='2026-02-01T00:00:00Z' GIT_COMMITTER_DATE='2026-02-01T00:00:00Z' git -C \"$FIXTURE_ROOT/${cell}\" commit -q -m lfs`,
  ], [...repoTree(cell), { path: `${cell}/.gitattributes`, kind: "file" }, { path: `${cell}/asset.bin`, kind: "file" }], [cell]);
}

export const buildS2Configured = (): GitFixtureDescription => buildLfs("s2-configured");
export const buildS2Unconfigured = (): GitFixtureDescription => buildLfs("s2-unconfigured");

export function buildS3Unicode(): GitFixtureDescription {
  return shell("s3-unicode", [
    "mkdir -p \"$FIXTURE_ROOT/s3-unicode\"",
    "git -C \"$FIXTURE_ROOT/s3-unicode\" init -q -b main",
    `printf 'nfc\\n' > \"$FIXTURE_ROOT/s3-unicode/${NFC_FILENAME}\"`,
    `printf 'nfd\\n' > \"$FIXTURE_ROOT/s3-unicode/${NFD_FILENAME}\"`,
    "git -C \"$FIXTURE_ROOT/s3-unicode\" add .",
    "GIT_AUTHOR_DATE='2026-03-01T00:00:00Z' GIT_COMMITTER_DATE='2026-03-01T00:00:00Z' git -C \"$FIXTURE_ROOT/s3-unicode\" commit -q -m unicode",
  ], [...repoTree("s3-unicode"), { path: `s3-unicode/${NFC_FILENAME}`, kind: "file", pathHex: NFC_FILENAME_HEX }, { path: `s3-unicode/${NFD_FILENAME}`, kind: "file", pathHex: NFD_FILENAME_HEX }], ["s3-unicode"]);
}

export function buildS3CaseCollision(): GitFixtureDescription {
  return shell("s3-case", [
    "mkdir -p \"$FIXTURE_ROOT/s3-case\"",
    "git -C \"$FIXTURE_ROOT/s3-case\" init -q -b main",
    "printf 'upper\\n' > \"$FIXTURE_ROOT/s3-case/README.md\"",
    "printf 'mixed\\n' > \"$FIXTURE_ROOT/s3-case/Readme.md\"",
    "git -C \"$FIXTURE_ROOT/s3-case\" add README.md Readme.md",
    "GIT_AUTHOR_DATE='2026-03-02T00:00:00Z' GIT_COMMITTER_DATE='2026-03-02T00:00:00Z' git -C \"$FIXTURE_ROOT/s3-case\" commit -q -m case",
  ], [...repoTree("s3-case"), { path: "s3-case/README.md", kind: "file" }, { path: "s3-case/Readme.md", kind: "file" }], ["s3-case"], false, GIT_SHAPE_REFUSALS.caseCollision);
}

export function buildS4Shallow(): GitFixtureDescription {
  return shell("s4-shallow", [
    "rm -rf \"$FIXTURE_AUX/s4-shallow-origin\"",
    "mkdir -p \"$FIXTURE_AUX/s4-shallow-origin\"",
    "git -C \"$FIXTURE_AUX/s4-shallow-origin\" init -q -b main",
    "printf 'one\\n' > \"$FIXTURE_AUX/s4-shallow-origin/history.txt\"; git -C \"$FIXTURE_AUX/s4-shallow-origin\" add history.txt",
    "GIT_AUTHOR_DATE='2026-04-01T00:00:00Z' GIT_COMMITTER_DATE='2026-04-01T00:00:00Z' git -C \"$FIXTURE_AUX/s4-shallow-origin\" commit -q -m one",
    "printf 'two\\n' >> \"$FIXTURE_AUX/s4-shallow-origin/history.txt\"; git -C \"$FIXTURE_AUX/s4-shallow-origin\" add history.txt",
    "GIT_AUTHOR_DATE='2026-04-02T00:00:00Z' GIT_COMMITTER_DATE='2026-04-02T00:00:00Z' git -C \"$FIXTURE_AUX/s4-shallow-origin\" commit -q -m two",
    "git clone -q --depth 1 \"file://$FIXTURE_AUX/s4-shallow-origin\" \"$FIXTURE_ROOT/s4-shallow\"",
  ], [...repoTree("s4-shallow"), { path: "s4-shallow/.git/shallow", kind: "file" }, { path: "s4-shallow/history.txt", kind: "file" }], ["s4-shallow"], false, GIT_SHAPE_REFUSALS.shallow);
}

function buildPartial(cell: "s4-partial-online" | "s4-partial-offline"): GitFixtureDescription {
  return shell(cell, [
    `rm -rf \"$FIXTURE_AUX/${cell}-origin\"`,
    `mkdir -p \"$FIXTURE_AUX/${cell}-origin\"`,
    `git -C \"$FIXTURE_AUX/${cell}-origin\" init -q -b main`,
    `git -C \"$FIXTURE_AUX/${cell}-origin\" config uploadpack.allowFilter true`,
    `git -C \"$FIXTURE_AUX/${cell}-origin\" config uploadpack.allowAnySHA1InWant true`,
    `printf 'payload-one\\n' > \"$FIXTURE_AUX/${cell}-origin/payload.bin\"; git -C \"$FIXTURE_AUX/${cell}-origin\" add payload.bin`,
    `GIT_AUTHOR_DATE='2026-04-03T00:00:00Z' GIT_COMMITTER_DATE='2026-04-03T00:00:00Z' git -C \"$FIXTURE_AUX/${cell}-origin\" commit -q -m C1`,
    `printf 'payload-two\\n' > \"$FIXTURE_AUX/${cell}-origin/payload.bin\"; git -C \"$FIXTURE_AUX/${cell}-origin\" add payload.bin`,
    `GIT_AUTHOR_DATE='2026-04-04T00:00:00Z' GIT_COMMITTER_DATE='2026-04-04T00:00:00Z' git -C \"$FIXTURE_AUX/${cell}-origin\" commit -q -m C2`,
    `printf 'payload-three\\n' > \"$FIXTURE_AUX/${cell}-origin/payload.bin\"; git -C \"$FIXTURE_AUX/${cell}-origin\" add payload.bin`,
    `GIT_AUTHOR_DATE='2026-04-05T00:00:00Z' GIT_COMMITTER_DATE='2026-04-05T00:00:00Z' git -C \"$FIXTURE_AUX/${cell}-origin\" commit -q -m C3`,
    `git clone -q --filter=blob:none --no-local \"file://$FIXTURE_AUX/${cell}-origin\" \"$FIXTURE_ROOT/${cell}\"`,
  ], [...repoTree(cell), { path: `${cell}/payload.bin`, kind: "file" }], [cell]);
}

export const buildS4PartialOnline = (): GitFixtureDescription => buildPartial("s4-partial-online");
export const buildS4PartialOffline = (): GitFixtureDescription => buildPartial("s4-partial-offline");

function buildOperation(cell: "s5-merge" | "s5-rebase" | "s5-cherry-pick"): GitFixtureDescription {
  return shell(cell, [
    `mkdir -p \"$FIXTURE_ROOT/${cell}\"`,
    `git -C \"$FIXTURE_ROOT/${cell}\" init -q -b main`,
    `printf 'base\\n' > \"$FIXTURE_ROOT/${cell}/conflict.txt\"; git -C \"$FIXTURE_ROOT/${cell}\" add conflict.txt`,
    `GIT_AUTHOR_DATE='2026-05-01T00:00:00Z' GIT_COMMITTER_DATE='2026-05-01T00:00:00Z' git -C \"$FIXTURE_ROOT/${cell}\" commit -q -m base`,
    `git -C \"$FIXTURE_ROOT/${cell}\" switch -q -c operation-side`,
    `printf 'operation-side\\n' > \"$FIXTURE_ROOT/${cell}/conflict.txt\"; git -C \"$FIXTURE_ROOT/${cell}\" add conflict.txt`,
    `GIT_AUTHOR_DATE='2026-05-02T00:00:00Z' GIT_COMMITTER_DATE='2026-05-02T00:00:00Z' git -C \"$FIXTURE_ROOT/${cell}\" commit -q -m operation-side`,
    `git -C \"$FIXTURE_ROOT/${cell}\" switch -q main`,
    `printf 'incoming-side\\n' > \"$FIXTURE_ROOT/${cell}/conflict.txt\"; git -C \"$FIXTURE_ROOT/${cell}\" add conflict.txt`,
    `GIT_AUTHOR_DATE='2026-05-03T00:00:00Z' GIT_COMMITTER_DATE='2026-05-03T00:00:00Z' git -C \"$FIXTURE_ROOT/${cell}\" commit -q -m incoming-side`,
  ], [...repoTree(cell), { path: `${cell}/conflict.txt`, kind: "file" }], [cell]);
}

export const buildS5Merge = (): GitFixtureDescription => buildOperation("s5-merge");
export const buildS5Rebase = (): GitFixtureDescription => buildOperation("s5-rebase");
export const buildS5CherryPick = (): GitFixtureDescription => buildOperation("s5-cherry-pick");

export function buildS5Bisect(): GitFixtureDescription {
  return shell("s5-bisect", [
    "mkdir -p \"$FIXTURE_ROOT/s5-bisect\"",
    "git -C \"$FIXTURE_ROOT/s5-bisect\" init -q -b main",
    "printf 'identical tree\\n' > \"$FIXTURE_ROOT/s5-bisect/stable.txt\"; git -C \"$FIXTURE_ROOT/s5-bisect\" add stable.txt",
    "GIT_AUTHOR_DATE='2026-05-04T00:00:00Z' GIT_COMMITTER_DATE='2026-05-04T00:00:00Z' git -C \"$FIXTURE_ROOT/s5-bisect\" commit -q -m good",
    "for n in 1 2 3 4; do GIT_AUTHOR_DATE=\"2026-05-0$((4+n))T00:00:00Z\" GIT_COMMITTER_DATE=\"2026-05-0$((4+n))T00:00:00Z\" git -C \"$FIXTURE_ROOT/s5-bisect\" commit --allow-empty -q -m \"empty-$n\"; done",
  ], [...repoTree("s5-bisect"), { path: "s5-bisect/stable.txt", kind: "file" }], ["s5-bisect"]);
}

export const GIT_FIXTURE_BUILDERS: Readonly<Record<GitShapeCell, () => GitFixtureDescription>> = {
  "s1-a": buildS1InitializedSubmodule,
  "s1-b": buildS1Pointer,
  "s1-c": buildS1UninitializedGitlink,
  "s2-configured": buildS2Configured,
  "s2-unconfigured": buildS2Unconfigured,
  "s3-unicode": buildS3Unicode,
  "s3-case": buildS3CaseCollision,
  "s4-shallow": buildS4Shallow,
  "s4-partial-online": buildS4PartialOnline,
  "s4-partial-offline": buildS4PartialOffline,
  "s5-merge": buildS5Merge,
  "s5-rebase": buildS5Rebase,
  "s5-cherry-pick": buildS5CherryPick,
  "s5-bisect": buildS5Bisect,
};

/** Stable construction order used by the scenario and the unit contract. */
export const GIT_SHAPE_CELLS = Object.freeze(Object.keys(GIT_FIXTURE_BUILDERS) as GitShapeCell[]);

/** The initialized-submodule fixture deliberately contributes two outcomes. */
export const GIT_SHAPE_OUTCOMES = Object.freeze([
  "s1-a", "s1-a/mod", "s1-b", "s1-c",
  "s2-configured", "s2-unconfigured",
  "s3-unicode", "s3-case",
  "s4-shallow", "s4-partial-online", "s4-partial-offline",
  "s5-merge", "s5-rebase", "s5-cherry-pick", "s5-bisect",
] as const);
