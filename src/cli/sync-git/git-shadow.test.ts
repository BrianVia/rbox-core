/** #832 shadow mode.
 *
 * The verdict tests do not assert against a hand-written expectation of what
 * `git merge --ff-only` does — they run the real thing in a throwaway clone of
 * the same fixture and assert the shadow agreed with it. A predicate that only
 * matches my belief about git is worth nothing here; the whole point of the
 * lane is that the boring plane's answer is git's answer.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { repoCtx } from "./git-state.js";
import { ownershipProofContext } from "./reachability.js";
import { readLive } from "./follow-live.js";
import { redactGitLogLines } from "../doctor-git-redaction.js";
import {
  gitShadowCounterPath,
  gitShadowEnabled,
  planeVerdictClass,
  readShadowCounters,
  recordShadow,
  shadowClass,
  shadowDoctorLine,
  shadowVerdict,
} from "./git-shadow.js";

const exec = promisify(execFile);
const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox test", GIT_AUTHOR_EMAIL: "rbox-test@local",
  GIT_COMMITTER_NAME: "rbox test", GIT_COMMITTER_EMAIL: "rbox-test@local",
};
const git = (dir: string, ...args: string[]) =>
  exec("git", ["-C", dir, ...args], { env: TEST_GIT_ENV }).then(({ stdout }) => stdout.toString().trim());

let tmp: string;
let repo: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-git-shadow-"));
  repo = path.join(tmp, "repo");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-qb", "main");
  await fs.writeFile(path.join(repo, "a.txt"), "a\n");
  await fs.writeFile(path.join(repo, "b.txt"), "b\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "one");
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Advance main by one commit that edits a.txt and adds c.txt, then rewind the
 * working repo to the earlier tip. Returns [localTip, incomingTip]. */
async function localAndIncoming(): Promise<[string, string]> {
  const local = await git(repo, "rev-parse", "HEAD");
  await fs.writeFile(path.join(repo, "a.txt"), "a2\n");
  await fs.writeFile(path.join(repo, "c.txt"), "c\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "two");
  const incoming = await git(repo, "rev-parse", "HEAD");
  await git(repo, "reset", "-q", "--hard", local);
  return [local, incoming];
}

async function verdictFor(incomingRefs: Record<string, string>): Promise<string> {
  const ctx = await repoCtx(repo);
  const live = await readLive(ctx);
  if (!live) throw new Error("live metadata unreadable");
  const snapshot = await shadowVerdict({
    ctx,
    live,
    incomingRefs,
    ownershipContext: await ownershipProofContext(ctx),
  });
  return shadowClass(snapshot.verdict);
}

/** What real `git merge --ff-only <incoming>` does to a COPY of the fixture —
 * the oracle the shadow's dirty-overlap predicate has to match. */
async function realFfOnly(incoming: string): Promise<"ok" | "refused"> {
  const clone = path.join(tmp, `ff-${Math.random().toString(16).slice(2)}`);
  await fs.cp(repo, clone, { recursive: true });
  try {
    await git(clone, "merge", "--ff-only", incoming);
    return "ok";
  } catch {
    return "refused";
  }
}

test("equal: an incoming branch already at the local tip is a noop", async () => {
  const tip = await git(repo, "rev-parse", "HEAD");
  expect(await verdictFor({ "refs/heads/main": tip })).toBe("noop");
});

test("ff-adoptable: a clean fast-forward adopts, and real ff-only agrees", async () => {
  const [, incoming] = await localAndIncoming();
  expect(await verdictFor({ "refs/heads/main": incoming })).toBe("adopt");
  expect(await realFfOnly(incoming)).toBe("ok");
});

test("ff-adoptable: a branch the receiver does not have at all is a plain create", async () => {
  const tip = await git(repo, "rev-parse", "HEAD");
  expect(await verdictFor({ "refs/heads/main": tip, "refs/heads/brand-new": tip })).toBe("adopt");
});

test("diverged: a receiver-only commit defers, and real ff-only agrees", async () => {
  const [, incoming] = await localAndIncoming();
  await fs.writeFile(path.join(repo, "b.txt"), "mine\n");
  await git(repo, "add", "b.txt");
  await git(repo, "commit", "-qm", "receiver-only");
  expect(await verdictFor({ "refs/heads/main": incoming })).toBe("defer:diverged");
  expect(await realFfOnly(incoming)).toBe("refused");
});

test("dirty-overlap: a locally modified file the fast-forward would write defers", async () => {
  const [, incoming] = await localAndIncoming();
  await fs.writeFile(path.join(repo, "a.txt"), "dirty\n");
  expect(await verdictFor({ "refs/heads/main": incoming })).toBe("defer:dirty-overlap");
  expect(await realFfOnly(incoming)).toBe("refused");
});

test("dirty-overlap: a STAGED change to a written file defers", async () => {
  const [, incoming] = await localAndIncoming();
  await fs.writeFile(path.join(repo, "a.txt"), "staged\n");
  await git(repo, "add", "a.txt");
  expect(await verdictFor({ "refs/heads/main": incoming })).toBe("defer:dirty-overlap");
  expect(await realFfOnly(incoming)).toBe("refused");
});

test("dirty-overlap: an UNTRACKED file the fast-forward would add defers", async () => {
  // diff-index cannot see this one; it is why the added-path arm exists.
  const [, incoming] = await localAndIncoming();
  await fs.writeFile(path.join(repo, "c.txt"), "untracked\n");
  expect(await verdictFor({ "refs/heads/main": incoming })).toBe("defer:dirty-overlap");
  expect(await realFfOnly(incoming)).toBe("refused");
});

/** THE CORRECTION, pinned. rbox's file plane writes tracked files before the
 * git plane runs, so at the shadow's observation point the working tree
 * routinely already holds the incoming content. Literal `merge --ff-only`
 * refuses there (it compares index entries, not content) — and if the shadow
 * copied that, the week's table would measure rbox's own file plane rather than
 * the candidate, which in §10's world would have owned the checkout itself.
 * These two tests are the whole judgement, stated once, in both directions. */
test("content the FILE plane already wrote is not receiver work — it adopts", async () => {
  const [, incoming] = await localAndIncoming();
  // Exactly what the file plane leaves behind: the incoming content, in place,
  // with the index and HEAD still at the old tip.
  await fs.writeFile(path.join(repo, "a.txt"), "a2\n");
  await fs.writeFile(path.join(repo, "c.txt"), "c\n");
  expect(await verdictFor({ "refs/heads/main": incoming })).toBe("adopt");
  // Literal ff-only disagrees, and that disagreement is the deliberate one.
  expect(await realFfOnly(incoming)).toBe("refused");
});

test("content the RECEIVER wrote at the same paths still defers", async () => {
  const [, incoming] = await localAndIncoming();
  await fs.writeFile(path.join(repo, "a.txt"), "mine, not the peer's\n");
  expect(await verdictFor({ "refs/heads/main": incoming })).toBe("defer:dirty-overlap");
  expect(await realFfOnly(incoming)).toBe("refused");
});

test("an incoming DELETE blocked by a locally modified file defers", async () => {
  const local = await git(repo, "rev-parse", "HEAD");
  await git(repo, "rm", "-q", "b.txt");
  await git(repo, "commit", "-qm", "drop b");
  const incoming = await git(repo, "rev-parse", "HEAD");
  await git(repo, "reset", "-q", "--hard", local);
  await fs.writeFile(path.join(repo, "b.txt"), "mine\n");
  expect(await verdictFor({ "refs/heads/main": incoming })).toBe("defer:dirty-overlap");
  expect(await realFfOnly(incoming)).toBe("refused");
});

test("dirty tree that does NOT collide still adopts — the rig's W3, not W4", async () => {
  const [, incoming] = await localAndIncoming();
  await fs.writeFile(path.join(repo, "b.txt"), "dirty elsewhere\n");
  expect(await verdictFor({ "refs/heads/main": incoming })).toBe("adopt");
  expect(await realFfOnly(incoming)).toBe("ok");
});

test("a non-checked-out branch never consults the working tree", async () => {
  const [local, incoming] = await localAndIncoming();
  await git(repo, "branch", "side", local);
  // main stays put; only `side` moves, and it is not HEAD, so a dirty a.txt is
  // irrelevant — `update-ref` writes no files.
  await fs.writeFile(path.join(repo, "a.txt"), "dirty\n");
  expect(await verdictFor({ "refs/heads/main": local, "refs/heads/side": incoming })).toBe("adopt");
});

/** §7.2(4): the rig scored 9-of-11 partly because it never tested a linked
 * worktree — its `update-ref` arm would have silently moved a branch a sibling
 * had checked out. The shadow must not inherit that flattery. */
test("a branch a SIBLING worktree has checked out defers, not adopts", async () => {
  const [local, incoming] = await localAndIncoming();
  await git(repo, "branch", "side", local);
  const sibling = path.join(tmp, "sibling");
  await git(repo, "worktree", "add", "-q", sibling, "side");
  expect(await verdictFor({ "refs/heads/main": local, "refs/heads/side": incoming }))
    .toBe("defer:sibling-worktree");
});

test("a branch no sibling holds still adopts — the check does not blanket-defer", async () => {
  const [local, incoming] = await localAndIncoming();
  await git(repo, "branch", "side", local);
  await git(repo, "branch", "other", local);
  const sibling = path.join(tmp, "sibling");
  await git(repo, "worktree", "add", "-q", sibling, "other");
  expect(await verdictFor({ "refs/heads/main": local, "refs/heads/side": incoming })).toBe("adopt");
});

test("indeterminate: a shallow store HOLDS — it is never flattened to defer", async () => {
  const [, incoming] = await localAndIncoming();
  await fs.writeFile(path.join(repo, ".git", "shallow"), "");
  expect(await verdictFor({ "refs/heads/main": incoming })).toBe("hold:shallow-store");
});

test("indeterminate: a missing object HOLDS, never diverged", async () => {
  const ctx = await repoCtx(repo);
  const live = await readLive(ctx);
  if (!live) throw new Error("live metadata unreadable");
  const snapshot = await shadowVerdict({
    ctx,
    live,
    incomingRefs: { "refs/heads/main": "0".repeat(40) },
    ownershipContext: await ownershipProofContext(ctx),
  });
  expect(shadowClass(snapshot.verdict)).toBe("hold:missing-object");
});

test("an operation in progress defers everything (rig W7)", async () => {
  const [, incoming] = await localAndIncoming();
  await fs.writeFile(path.join(repo, ".git", "MERGE_HEAD"), `${incoming}\n`);
  expect(await verdictFor({ "refs/heads/main": incoming })).toBe("defer:operation-in-progress");
});

test("only refs/heads/* are counted — tags and stash are not branches", async () => {
  const tip = await git(repo, "rev-parse", "HEAD");
  const ctx = await repoCtx(repo);
  const live = await readLive(ctx);
  if (!live) throw new Error("live metadata unreadable");
  const snapshot = await shadowVerdict({
    ctx,
    live,
    incomingRefs: { "refs/heads/main": tip, "refs/tags/v1": tip, "refs/stash": tip },
    ownershipContext: await ownershipProofContext(ctx),
  });
  expect(snapshot.refs).toBe(1);
});

test("the plane's verdict class covers applied, held and deferred", () => {
  const base = { appliedRefs: {}, heldRefs: {}, blockers: [], configApplied: true };
  expect(planeVerdictClass({ status: "followed", ...base })).toBe("applied");
  expect(planeVerdictClass({
    status: "followed", ...base, heldRefs: { "refs/heads/x": "local-commits" },
  })).toBe("held:local-commits");
  expect(planeVerdictClass({
    status: "defer", reason: "local-index", detail: "index differs", ...base,
  })).toBe("deferred:local-index");
  // A legacy result is a deferral by another name: the checkout did not land.
  expect(planeVerdictClass({
    status: "legacy", reason: "conflict", detail: "disabled", ...base,
  })).toBe("deferred:conflict");
});

test("disagreement logs one line per repo; agreement logs nothing", async () => {
  const lines: string[] = [];
  const snapshot = { verdict: { kind: "adopt" } as const, refs: 3 };
  await recordShadow({ workspaceRoot: tmp, relPath: "Personal/rbox-core", planeClass: "applied", snapshot, log: (l) => lines.push(l) });
  expect(lines).toEqual([]);

  await recordShadow({ workspaceRoot: tmp, relPath: "Personal/rbox-core", planeClass: "deferred:local-index", snapshot, log: (l) => lines.push(l) });
  expect(lines).toEqual(["git-shadow disagree Personal/rbox-core: plane=deferred:local-index shadow=adopt refs=3"]);
});

test("a shadow noop never disagrees — it had nothing to move", async () => {
  const lines: string[] = [];
  const snapshot = { verdict: { kind: "noop" } as const, refs: 1 };
  for (const planeClass of ["applied", "deferred:local-index", "held:local-commits"]) {
    await recordShadow({ workspaceRoot: tmp, relPath: "r", planeClass, snapshot, log: (l) => lines.push(l) });
  }
  expect(lines).toEqual([]);
  expect((await readShadowCounters(tmp))?.agree).toBe(3);
});

test("the counter file accumulates across pulls and survives a restart", async () => {
  const adopt = { verdict: { kind: "adopt" } as const, refs: 1 };
  const hold = { verdict: { kind: "hold", why: "shallow-store" } as const, refs: 1 };
  await recordShadow({ workspaceRoot: tmp, relPath: "one", planeClass: "applied", snapshot: adopt, now: "2026-09-02T00:00:00.000Z" });
  await recordShadow({ workspaceRoot: tmp, relPath: "two", planeClass: "deferred:local-index", snapshot: adopt, now: "2026-09-02T01:00:00.000Z" });
  await recordShadow({ workspaceRoot: tmp, relPath: "three", planeClass: "applied", snapshot: hold, now: "2026-09-02T02:00:00.000Z" });

  // "Survives a restart" is exactly this: nothing in-process carries the
  // counts — a fresh read off disk is the only source.
  const counters = await readShadowCounters(tmp);
  expect(counters).toEqual({
    version: 1,
    firstSeen: "2026-09-02T00:00:00.000Z",
    lastSeen: "2026-09-02T02:00:00.000Z",
    agree: 1,
    disagree: 2,
    pairs: {
      "applied|adopt": 1,
      "deferred:local-index|adopt": 1,
      "applied|hold:shallow-store": 1,
    },
  });
  // Small, JSON, and meant to be read by a human at week's end.
  const raw = await fs.readFile(gitShadowCounterPath(tmp), "utf8");
  expect(raw).toContain("\n  \"agree\": 1,");
  expect(JSON.parse(raw)).toEqual(counters!);
});

test("a corrupt or foreign-version counter file never throws and never poisons", async () => {
  await fs.mkdir(path.join(tmp, ".rbox", "state"), { recursive: true });
  await fs.writeFile(gitShadowCounterPath(tmp), "{ not json");
  expect(await readShadowCounters(tmp)).toBeUndefined();
  await recordShadow({ workspaceRoot: tmp, relPath: "r", planeClass: "applied", snapshot: { verdict: { kind: "adopt" }, refs: 1 } });
  expect((await readShadowCounters(tmp))?.agree).toBe(1);
});

test("the doctor line reads the cross-tab in both directions", async () => {
  const counters = {
    version: 1 as const,
    firstSeen: "2026-08-26T00:00:00.000Z",
    lastSeen: "2026-09-02T00:00:00.000Z",
    agree: 1203,
    disagree: 14,
    pairs: {
      "applied|adopt": 1203,
      "deferred:local-index|adopt": 12,
      "applied|hold:shallow-store": 2,
    },
  };
  expect(shadowDoctorLine(counters)).toBe(
    "  git shadow: 1,203 agree · 14 disagree (plane deferred, shadow would adopt: 12; shadow would hold, plane applied: 2)",
  );
});

test("a clean week says so without the parenthetical", () => {
  expect(shadowDoctorLine({
    version: 1, firstSeen: "x", lastSeen: "y", agree: 40, disagree: 0, pairs: { "applied|adopt": 40 },
  })).toBe("  git shadow: 40 agree · 0 disagree");
});

test("the disagreement line survives diagnostics redaction with the repo path stripped", () => {
  const line = "git-shadow disagree Personal/rbox-core: plane=deferred:local-index shadow=adopt refs=3";
  const redacted = redactGitLogLines(`2026-09-02T01:00:00.000Z ${line}\n`);
  // Fail-closed: an unrecognized git-family line would vanish entirely, and a
  // line outside the family would be emitted VERBATIM — including the path.
  expect(redacted).toContain("shadow plane=deferred:local-index shadow=adopt");
  expect(redacted).not.toContain("rbox-core");
});

test("doctor renders the summary from a real recorded workspace, and nothing before one", async () => {
  const { renderDoctor } = await import("../doctor-cmd.js");
  const checks = {};
  const counters = await readShadowCounters(tmp);
  // No file yet: the line is absent rather than a zeroed placeholder.
  expect(counters).toBeUndefined();
  expect(renderDoctor(checks, undefined, counters && shadowDoctorLine(counters)))
    .not.toContain("git shadow:");

  await recordShadow({ workspaceRoot: tmp, relPath: "a", planeClass: "applied", snapshot: { verdict: { kind: "adopt" }, refs: 1 } });
  await recordShadow({ workspaceRoot: tmp, relPath: "b", planeClass: "deferred:local-index", snapshot: { verdict: { kind: "adopt" }, refs: 1 } });
  const after = await readShadowCounters(tmp);
  expect(renderDoctor(checks, undefined, after && shadowDoctorLine(after)))
    .toContain("  git shadow: 1 agree · 1 disagree (plane deferred, shadow would adopt: 1; shadow would hold, plane applied: 0)");
});

test("the kill switch is the only thing that turns the lane off", () => {
  expect(gitShadowEnabled({})).toBe(true);
  expect(gitShadowEnabled({ RBOX_GIT_SHADOW: "1" })).toBe(true);
  expect(gitShadowEnabled({ RBOX_GIT_SHADOW: "0" })).toBe(false);
});
