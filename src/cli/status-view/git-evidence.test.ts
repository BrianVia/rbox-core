import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setGitSpawnObserver } from "../../engine/git-spawn.js";
import { hashBytes } from "../../engine/hash.js";
import type { GitSection } from "../../engine/types.js";
import { writePendingPins } from "../sync-git/pending-pins.js";
import type { RepoRecord } from "../sync-state-model.js";
import { gitDeferralEvidence, MAX_FILES, parseNumstat } from "./git-evidence.js";
import { evidenceRisk } from "./git-evidence-model.js";
import { evidenceRowSuffix, renderGitRepoDetail } from "./git-evidence-render.js";
import { projectGitDeferralRepos } from "./git-projection.js";
import { gitPauseCounts, gitPauseHeadline, renderGitPauseListing, renderGitPauseSummary } from "./git-story-render.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  setGitSpawnObserver(undefined);
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const section = (refs: Record<string, string>, head: string, generatedAt = "2026-08-16T00:00:00.000Z"): GitSection => ({
  bundleSha: "0".repeat(64),
  bundleEncSha: "1".repeat(64),
  bundleCipherSize: 1,
  head,
  refs,
  refScope: "all",
  generatedAt,
});

const record = (parts: Partial<RepoRecord>): RepoRecord => ({ repoGen: 1, sourceSeq: 1, ...parts });

async function commit(root: string, file: string, body: string, message: string): Promise<string> {
  await fs.writeFile(path.join(root, file), body);
  await exec("git", ["-C", root, "add", file]);
  await exec("git", ["-C", root, "commit", "-qm", message]);
  return (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
}

/** A workspace with one repo at ".", a synced BASE, and a paused incoming
 * branch whose commits are imported and pinned — the tier-1 shape. */
async function pausedRepo(): Promise<{ root: string; base: string; theirs: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-evidence-"));
  roots.push(root);
  await exec("git", ["-C", root, "init", "-q", "-b", "main"]);
  await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", root, "config", "user.name", "Test"]);
  await fs.writeFile(path.join(root, "shared.ts"), "base\n");
  await fs.writeFile(path.join(root, "mine.ts"), "base\n");
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "commit", "-qm", "base"]);
  const base = (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  // The other computer's two commits, built on a side branch and then unhooked so
  // only the pin keeps them reachable — exactly the post-`cleanupRefs` shape.
  await exec("git", ["-C", root, "checkout", "-q", "-b", "incoming"]);
  await commit(root, "shared.ts", "theirs\n", "fix stripe webhook retry");
  const theirs = await commit(root, "theirfile.ts", "theirs\n", "add retry backoff");
  await exec("git", ["-C", root, "checkout", "-q", "main"]);
  await exec("git", ["-C", root, "branch", "-qD", "incoming"]);
  return { root, base, theirs };
}

test("tier 1: pinned incoming objects give commits, subjects, files, and the overlap number", async () => {
  const { root, base, theirs } = await pausedRepo();
  const incoming = section({ "refs/heads/main": theirs }, "ref: refs/heads/main");
  await writePendingPins(root, ".", (await import("../sync-git/shared.js")).gitIncomingKey(incoming), incoming);
  // Local work: one file both computers changed, one only this computer did.
  await fs.writeFile(path.join(root, "shared.ts"), "mine\n");
  await fs.writeFile(path.join(root, "mine.ts"), "mine\nmore\n");

  const evidence = (await gitDeferralEvidence({
    root,
    records: new Map([[".", record({ base: section({ "refs/heads/main": base }, "ref: refs/heads/main"), pending: incoming })]]),
  })).get(".")!;

  expect(evidence.tier).toBe("pinned");
  expect(evidence.localBranch).toBe("main");
  expect(evidence.local?.files.map((file) => file.path).sort()).toEqual(["mine.ts", "shared.ts"]);
  expect(evidence.local?.files.every((file) => file.editedAt !== undefined)).toBe(true);
  expect(evidence.incoming?.commitsAhead).toBe(2);
  expect(evidence.incoming?.newest?.subject).toBe("add retry backoff");
  expect(evidence.incoming?.oldest?.subject).toBe("fix stripe webhook retry");
  expect(evidence.incoming?.files?.sort()).toEqual(["shared.ts", "theirfile.ts"]);
  expect(evidence.overlap).toBe(1);
});

test("tier 2: an unpinned pause still reports branch, head oid and capture date", async () => {
  const { root, base, theirs } = await pausedRepo();
  const evidence = (await gitDeferralEvidence({
    root,
    records: new Map([[".", record({
      base: section({ "refs/heads/main": base }, "ref: refs/heads/main"),
      pending: section({ "refs/heads/main": theirs }, "ref: refs/heads/main", "2026-08-15T03:53:43.027Z"),
    })]]),
  })).get(".")!;
  expect(evidence.tier).toBe("record");
  expect(evidence.incoming?.branch).toBe("main");
  expect(evidence.incoming?.headOid).toBe(theirs);
  expect(evidence.incoming?.generatedAt).toBe("2026-08-15T03:53:43.027Z");
  expect(evidence.incoming?.commitsAhead).toBeUndefined();
  expect(evidence.overlap).toBeUndefined();
});

test("`status --git` writes no .git/index — the held-skip fingerprint survives evidence", async () => {
  const { root, base } = await pausedRepo();
  const indexPath = path.join(root, ".git", "index");
  // A dirty repo whose index is ALSO stat-stale: rewriting a tracked file with
  // its own content invalidates the cached stat without changing the tree, which
  // is exactly the state where a plain `git diff` refreshes and rewrites the
  // index. Every repo rbox paused mid-edit is in it.
  await fs.writeFile(path.join(root, "mine.ts"), "mine\n");
  const stale = new Date(Date.now() + 2000);
  await fs.writeFile(path.join(root, "shared.ts"), "base\n");
  await fs.utimes(path.join(root, "shared.ts"), stale, stale);
  const before = await fs.stat(indexPath);
  const beforeBytes = hashBytes(await fs.readFile(indexPath));

  await gitDeferralEvidence({
    root,
    records: new Map([[".", record({ base: section({ "refs/heads/main": base }, "ref: refs/heads/main") })]]),
  });

  const after = await fs.stat(indexPath);
  expect(hashBytes(await fs.readFile(indexPath))).toBe(beforeBytes);
  expect(after.mtimeMs).toBe(before.mtimeMs);
});

test("a per-repo budget of zero degrades to the fields it already had, never to a throw", async () => {
  const { root, base, theirs } = await pausedRepo();
  const evidence = (await gitDeferralEvidence({
    root,
    timeoutMs: 0,
    records: new Map([[".", record({
      base: section({ "refs/heads/main": base }, "ref: refs/heads/main"),
      pending: section({ "refs/heads/main": theirs }, "ref: refs/heads/main"),
    })]]),
  })).get(".")!;
  expect(evidence.timedOut).toBe(true);
  expect(evidence.local?.total).toBe(0);
  expect(evidence.tier).toBe("record");
});

test("an unreadable repository yields an empty reading rather than failing the surface", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-evidence-absent-"));
  roots.push(root);
  const evidence = (await gitDeferralEvidence({ root, records: new Map([["gone", record({})]]) })).get("gone")!;
  expect(evidence.tier).toBe("none");
  expect(evidence.local?.total).toBe(0);
});

test("evidence spawns git; the projection it extends still spawns none", async () => {
  const { root, base } = await pausedRepo();
  const spawns: string[][] = [];
  setGitSpawnObserver((_root, args) => { spawns.push([...args]); });
  await gitDeferralEvidence({
    root,
    records: new Map([[".", record({ base: section({ "refs/heads/main": base }, "ref: refs/heads/main") })]]),
  });
  expect(spawns.length).toBeGreaterThan(0);
  // MANDATORY on every read: see the module header.
  expect(spawns.every((args) => args[0] === "--no-optional-locks")).toBe(true);
});

// ── the two disciplines evidence() must not break ────────────────────────────

/** A real ESC byte, built rather than pasted so the source stays readable. */
const ESC = String.fromCharCode(27);

const projected = (reason: "local-edits" | "conflict") => projectGitDeferralRepos([{
  repo: "acme/checkout",
  deferral: {
    lane: "apply", reason, deferredSince: "2026-08-14T00:00:00.000Z",
    reasonSince: "2026-08-14T00:00:00.000Z", lastSeen: "2026-08-14T00:00:00.000Z",
  },
}], Date.parse("2026-08-17T00:00:00.000Z"));

test("project() and every human surface it feeds spawn ZERO git processes", () => {
  // Design 273 P1: the daemon, the status headline, doctor and the prompt
  // sidecar all run this chain on every cycle. evidence() is the ONLY operation
  // allowed to reach git, and it is reachable from manual commands alone.
  const rows = projected("local-edits");
  const spawns: string[][] = [];
  setGitSpawnObserver((_root, args) => { spawns.push([...args]); });
  const now = Date.parse("2026-08-17T00:00:00.000Z");
  gitPauseHeadline(gitPauseCounts(rows));
  renderGitPauseListing(rows, { now });
  renderGitPauseSummary(rows, now);
  renderGitRepoDetail(rows[0]!, undefined, now);
  expect(spawns).toEqual([]);
});

test("a commit subject carrying terminal escapes renders inert and bounded", () => {
  const rows = projected("conflict");
  const hostile = `${ESC}[31mDANGER${ESC}[0m${"x".repeat(500)}`;
  const lines = renderGitRepoDetail(rows[0]!, {
    repo: "acme/checkout",
    tier: "pinned",
    localBranch: "main",
    local: {
      files: [{ path: `${ESC}[2Jsrc/pay.ts`, added: 1, removed: 0 }],
      total: 1, commits: 1, untracked: 0,
    },
    incoming: {
      branch: `${ESC}[1mmain`,
      commitsAhead: 2,
      newest: { subject: hostile, date: "2026-08-16T00:00:00.000Z" },
      files: ["src/pay.ts"],
    },
    overlap: 1,
  }, Date.parse("2026-08-17T00:00:00.000Z")).join("\n");
  expect(lines).not.toContain(ESC);
  expect(lines).toContain("DANGER");
  // Bounded, not merely stripped: an unbounded peer string is its own defect.
  expect(lines.split("\n").every((line) => line.length < 300)).toBe(true);
  expect(lines).toContain("1 of them is a file you also changed here ⚠");
});

// ── unknown must never render as zero ────────────────────────────────────────

test("unrelated histories yield NO overlap number, not a false zero", async () => {
  const { root, base } = await pausedRepo();
  // A second root commit: `git merge-base HEAD <oid>` exits non-zero, which is
  // the read whose empty fallback used to become an empty FILE LIST — printing
  // "none changed elsewhere" beside "1 commit newer".
  const orphan = (await exec("git", ["-C", root, "commit-tree", "-m", "unrelated",
    (await exec("git", ["-C", root, "write-tree"])).stdout.trim()])).stdout.trim();
  const incoming = section({ "refs/heads/main": orphan }, "ref: refs/heads/main");
  await writePendingPins(root, ".", (await import("../sync-git/shared.js")).gitIncomingKey(incoming), incoming);
  await fs.writeFile(path.join(root, "shared.ts"), "mine\n");

  const evidence = (await gitDeferralEvidence({
    root,
    records: new Map([[".", record({ base: section({ "refs/heads/main": base }, "ref: refs/heads/main"), pending: incoming })]]),
  })).get(".")!;
  expect(evidence.tier).toBe("pinned");
  expect(evidence.incoming?.files).toBeUndefined();
  expect(evidence.overlap).toBeUndefined();
  expect(evidenceRowSuffix(evidence)).toBe("1 file changed here, can't compare with the other computer");
});

test("a timed-out reading never reports an overlap number", async () => {
  const { root, base, theirs } = await pausedRepo();
  const incoming = section({ "refs/heads/main": theirs }, "ref: refs/heads/main");
  await writePendingPins(root, ".", (await import("../sync-git/shared.js")).gitIncomingKey(incoming), incoming);
  await fs.writeFile(path.join(root, "shared.ts"), "mine\n");
  const evidence = (await gitDeferralEvidence({
    root,
    timeoutMs: 0,
    records: new Map([[".", record({ base: section({ "refs/heads/main": base }, "ref: refs/heads/main"), pending: incoming })]]),
  })).get(".")!;
  expect(evidence.timedOut).toBe(true);
  expect(evidence.overlap).toBeUndefined();
});

test("the local count stays EXACT past the name cap — total is not files.length", () => {
  const overflow = MAX_FILES + 17;
  const numstat = Array.from({ length: overflow }, (_, i) => `1\t0\tsrc/file-${i}.ts`).join("\n");
  const parsed = parseNumstat(numstat);
  // The whole point: stopping the parse at the cap silently reported 5,000
  // changed files for a repo that had 5,017.
  expect(parsed.total).toBe(overflow);
  expect(parsed.files).toHaveLength(MAX_FILES);
});

test("the row suffix refuses an overlap clause once the reading is not exact", async () => {
  const { root, base, theirs } = await pausedRepo();
  const incoming = section({ "refs/heads/main": theirs }, "ref: refs/heads/main");
  await writePendingPins(root, ".", (await import("../sync-git/shared.js")).gitIncomingKey(incoming), incoming);
  await fs.writeFile(path.join(root, "shared.ts"), "mine\n");
  const evidence = (await gitDeferralEvidence({
    root,
    records: new Map([[".", record({ base: section({ "refs/heads/main": base }, "ref: refs/heads/main"), pending: incoming })]]),
  })).get(".")!;
  // Control: an untruncated reading DOES report the number.
  expect(evidence.overlap).toBe(1);
  expect(evidenceRowSuffix({ ...evidence, local: { ...evidence.local!, truncated: true }, overlap: undefined }))
    .toBe("1 file changed here, can't compare with the other computer");
});

test("an unknown reading outranks a proven-safe one in the risk order", () => {
  const known = { repo: "a", tier: "pinned", overlap: 0 } as const;
  const unknown = { repo: "b", tier: "pinned" } as const;
  expect(evidenceRisk(unknown)).toBeGreaterThan(evidenceRisk(known));
  expect(evidenceRisk(undefined)).toBeLessThan(evidenceRisk(known));
});
