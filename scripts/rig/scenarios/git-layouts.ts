/** Design 141: end-to-end burn-in for the fifteen normative Git-shape outcomes. */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { GUEST } from "../lib/config.js";
import type { Device } from "../lib/device.js";
import {
  GIT_FIXTURE_BUILDERS,
  GIT_LAYOUT_OUTCOMES,
  GIT_LAYOUT_OP_STATE_ROOTS,
  GIT_LAYOUT_REFUSALS,
  GIT_LAYOUT_SURFACES,
  LFS_PAYLOAD,
  NFC_FILENAME_HEX,
  NFD_FILENAME_HEX,
  formatFixturePlanLine,
  type GitFixtureDescription,
  type GitLayoutCell,
} from "../lib/git-fixtures.js";
import { createRecorder, errMsg, type Recorder } from "./harness.js";
import { CONCURRENCY, provisionPair, teardownAccount } from "./preamble.js";
import type { RigCtx, Scenario, ScenarioReport } from "./types.js";
import { finalizeReport } from "./types.js";
import type { SyncState } from "../../../src/cli/sync-state-model.js";
import type { GitDeferralLaneJson } from "../../../src/cli/sync-git/git-deferral-json.js";

const UPLOAD = { RBOX_UPLOAD_CONCURRENCY: CONCURRENCY };
const DOWNLOAD = { RBOX_DOWNLOAD_CONCURRENCY: CONCURRENCY };
const EXPECTED_GIT_VERSION = "git version 2.54.0";

interface RepoRecordView {
  sourceSeq?: number;
  base?: unknown;
  advertised?: unknown;
  branchBaseOrigins?: Record<string, { kind?: string }>;
  pending?: unknown;
  partial?: {
    checkoutPending?: boolean;
    heldRefs?: Record<string, string>;
    configApplied?: boolean;
    appliedRefs?: Record<string, { kind?: string; proof?: string; beforeOid?: string | null; afterOid?: string | null }>;
  };
  resolutionKey?: string;
  repoAbsent?: true;
  deferrals?: Record<string, {
    lane?: string;
    reason?: string;
    deferredSince?: string;
    reasonSince?: string;
    lastSeen?: string;
    bytesChanged?: boolean;
    checkout?: { kind?: string; label?: string };
  }>;
}

interface SyncStateView {
  lastSyncedSequence?: number;
  repoRecords?: Record<string, RepoRecordView>;
  gitPendingRemote?: SyncState["gitPendingRemote"];
  gitNeedsResolution?: SyncState["gitNeedsResolution"];
}

interface DeferredRepoStatus {
  repo: string;
  oldestDeferredSince: string;
  displayReason: string;
  ageSeconds: number | null;
  bytesChanged: boolean;
  checkout?: { kind: "branch"; label?: string } | { kind: "detached" };
}

interface StatusView {
  health?: string | { state?: string; halted?: boolean };
  halted?: boolean;
  recovering?: boolean;
  git?: {
    deferrals?: GitDeferralLaneJson[];
    deferredRepos?: DeferredRepoStatus[];
  };
}

export interface HealthProbeEvidence {
  side: "A" | "B";
  unhealthy: boolean;
  reasons: string[];
  status: string;
  activity?: string;
  haltSideFile?: string;
}

export interface GitLayoutFinding {
  slug: string;
  cell: string;
  summary: string;
  evidence: readonly string[];
}

/** Pure forward-compatible classifier for current and design-138 health shapes. */
export function classifyHealthProbe(side: "A" | "B", status: string, activity?: string, haltSideFile?: string, statusExitCode = 0): HealthProbeEvidence {
  const reasons: string[] = [];
  const parse = (raw: string | undefined): unknown => {
    if (!raw) return undefined;
    try { return JSON.parse(raw); } catch { return undefined; }
  };
  const s = parse(status) as StatusView | undefined;
  const a = parse(activity) as { halt?: unknown; health?: string; recovering?: boolean } | undefined;
  if (statusExitCode !== 0 || s === undefined) reasons.push("status probe failed");
  const health = typeof s?.health === "string" ? s.health : s?.health?.state;
  if (health === "halt" || health === "halted" || s?.halted === true || s?.health && typeof s.health === "object" && s.health.halted === true) reasons.push("status halted");
  if (health === "recovering" || s?.recovering === true) reasons.push("status recovering");
  if (a?.halt !== undefined) reasons.push("activity halt");
  if (a?.health === "recovering" || a?.recovering === true) reasons.push("activity recovering");
  if (haltSideFile !== undefined && haltSideFile.trim() !== "") reasons.push("health-halt side-file present");
  return { side, unhealthy: reasons.length > 0, reasons, status, ...(activity === undefined ? {} : { activity }), ...(haltSideFile === undefined ? {} : { haltSideFile }) };
}

/** Normalize guest-emitted `od`/`xxd` output; decoded path text is never a byte pin. */
export function normalizeGuestHex(output: string): string {
  const normalized = output.replace(/\s+/g, "").toLowerCase();
  if (!/^(?:[0-9a-f]{2})*$/.test(normalized)) throw new Error(`invalid guest hex: ${JSON.stringify(output)}`);
  return normalized;
}

/** Pure findings renderer; the host-side write remains in the scenario. */
export function renderGitLayoutFindings(findings: readonly GitLayoutFinding[]): string {
  const lines = ["# Git-layouts findings", "", "Design 141 burn-in sidecar. These entries pin current behavior; they do not suppress assertions.", ""];
  for (const finding of findings) {
    lines.push(`## ${finding.slug}`, "", `- cell: \`${finding.cell}\``, `- summary: ${finding.summary}`);
    for (const evidence of finding.evidence) lines.push(`- evidence: ${evidence}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function executeFixture(device: Device, description: GitFixtureDescription): Promise<void> {
  const aux = `/tmp/rbox-git-layouts-${description.cell}`;
  await device.exec(["rm", "-rf", aux], { allowFail: true });
  await device.exec(["mkdir", "-p", GUEST.workDir, aux]);
  for (const command of description.commands) {
    await device.exec([...command.argv], {
      env: { FIXTURE_ROOT: GUEST.workDir, FIXTURE_AUX: aux, ...(command.env ?? {}) },
    });
  }
}

async function git(device: Device, rel: string, args: string[], allowFail = false) {
  return device.exec(["git", "-C", `${GUEST.workDir}/${rel}`, ...args], { allowFail });
}

async function fileHex(device: Device, filename: string): Promise<string> {
  const result = await device.exec(["sh", "-ceu", "test -f \"$1\"; od -An -tx1 -v -- \"$1\" | tr -d ' \\n'", "hex-file", filename]);
  return normalizeGuestHex(result.stdout);
}

async function basenameHexSet(device: Device, directory: string): Promise<string[]> {
  const result = await device.exec(["sh", "-ceu", "find \"$1\" -mindepth 1 -maxdepth 1 -type f -printf '%f\\0' | sort -z | od -An -tx1 -v | tr -d ' \\n'", "hex-names", directory]);
  return normalizeGuestHex(result.stdout).split("00").filter(Boolean).sort();
}

/** Execute the product preflight in the guest; expected text remains shared. */
async function productPreflightReason(device: Device, rel: string): Promise<string> {
  const script = `import { gitPreflight } from '/app/src/cli/sync-git/preflight.ts'; const r = await gitPreflight(${JSON.stringify(`${GUEST.workDir}/`)} + process.argv[1]); console.log(r.reason ?? '');`;
  return (await device.exec(["bun", "-e", script, rel])).stdout.trim();
}

async function readState(device: Device): Promise<SyncStateView> {
  return JSON.parse(await device.readFile(`${GUEST.workDir}/.rbox/state.json`)) as SyncStateView;
}

async function readStatus(device: Device): Promise<{ raw: string; parsed?: StatusView }> {
  const result = await device.rbox(["status", "--json"], { cwd: GUEST.workDir, allowFail: true });
  try { return { raw: result.stdout, parsed: JSON.parse(result.stdout) as StatusView }; }
  catch { return { raw: result.stdout + result.stderr }; }
}

function planLine(input: { captured?: string[]; deferred?: Array<{ relPath: string; reason: string }>; removed?: string[] }): string {
  return formatFixturePlanLine(input);
}

/** Record a fixture precondition and abort the cell immediately on failure. */
function requireAssertion(rec: Recorder, name: string, ok: boolean, detail: string): void {
  rec.assert(name, ok, detail);
  if (!ok) throw new Error(`${name}: ${detail}`);
}

async function probeHealth(ctx: RigCtx, rec: Recorder, findings: GitLayoutFinding[], cell: string, boundary: string): Promise<void> {
  for (const [side, device] of [["A", ctx.a], ["B", ctx.b]] as const) {
    const status = await device.rbox(["status", "--json"], { cwd: GUEST.workDir, allowFail: true });
    const activity = await device.readFileIfExists(`${GUEST.workDir}/.rbox/state/activity.json`);
    const haltSide = await device.readFileIfExists(`${GUEST.workDir}/.rbox/state/health-halt.json`);
    const evidence = classifyHealthProbe(side, status.stdout || status.stderr, activity, haltSide, status.exitCode);
    rec.assert(`[${cell}] ${boundary} health ${side}`, !evidence.unhealthy, evidence.reasons.join(", ") || "healthy");
    if (evidence.unhealthy) {
      findings.push({
        slug: "finding: unexpected-health-state",
        cell,
        summary: `${side} was halted/recovering at ${boundary}`,
        evidence: [`reasons=${evidence.reasons.join(",")}`, `status=${JSON.stringify(evidence.status)}`, `activity=${JSON.stringify(evidence.activity)}`, `health-side-file=${JSON.stringify(evidence.haltSideFile)}`, "full command evidence is in run.log"],
      });
    }
  }
}

async function resetBetweenCells(ctx: RigCtx, cell: string): Promise<void> {
  await Promise.all([ctx.a.daemonStop(GUEST.workDir), ctx.b.daemonStop(GUEST.workDir)]);
  const clean = async (device: Device) => {
    await device.exec(["rm", "-rf", GUEST.workDir, GUEST.rboxHome, `/tmp/rbox-git-layouts-${cell}`], { allowFail: true });
  };
  await Promise.all([clean(ctx.a), clean(ctx.b)]);
}

interface ProvisionCellOptions {
  /** Preserve fixture PRE state by enrolling both devices before construction. */
  readonly afterPair?: boolean;
}

async function provisionCell(ctx: RigCtx, rec: Recorder, cell: GitLayoutCell, opts: ProvisionCellOptions = {}) {
  const description = GIT_FIXTURE_BUILDERS[cell]();
  const provisioned = await provisionPair(ctx, rec, {
    push: false,
    pull: false,
    ...(opts.afterPair ? {} : { afterSeedA: (a: Device) => executeFixture(a, description) }),
  });
  if (opts.afterPair) await executeFixture(ctx.a, description);
  return { description, ...provisioned };
}

async function pullB(ctx: RigCtx, env: Record<string, string> = DOWNLOAD) {
  return ctx.b.rbox(["pull", "--verbose"], { cwd: GUEST.workDir, env, allowFail: true });
}

async function pushA(ctx: RigCtx, env: Record<string, string> = UPLOAD) {
  return ctx.a.rbox(["push"], { cwd: GUEST.workDir, env, allowFail: true });
}

async function assertStatusAndFsck(rec: Recorder, device: Device, rel: string, expected: string, label: string): Promise<void> {
  const [status, fsck] = await Promise.all([git(device, rel, ["status", "--porcelain=v1"], true), git(device, rel, ["fsck", "--no-dangling"], true)]);
  rec.assert(`[${label}] porcelain exact`, status.exitCode === 0 && status.stdout === expected, JSON.stringify(status.stdout));
  rec.assert(`[${label}] fsck --no-dangling`, fsck.exitCode === 0, `exit ${fsck.exitCode}: ${fsck.stderr.trim()}`);
}

async function assertEmptyDeferrals(rec: Recorder, device: Device, rel: string, label: string, nativeRepo = true): Promise<void> {
  const status = await readStatus(device);
  rec.assert(`[${label}] JSON deferrals empty`, status.parsed?.git?.deferrals?.length === 0 && status.parsed.git.deferredRepos?.length === 0, status.raw.trim().slice(0, 400));
  const state = await readState(device);
  const record = state.repoRecords?.[rel];
  const settled = record?.pending === undefined && record?.partial === undefined && record?.resolutionKey === undefined && state.gitPendingRemote?.[rel] === undefined && state.gitNeedsResolution?.[rel] === undefined;
  rec.assert(`[${label}] pending/partial/resolution absent`, settled, JSON.stringify(record));
  await assertNoRecoveryArtifacts(rec, device, rel, label, nativeRepo);
}

async function assertNoRecoveryArtifacts(rec: Recorder, device: Device, rel: string, label: string, nativeRepo = true): Promise<void> {
  if (nativeRepo) {
    const refs = await git(device, rel, ["for-each-ref", "--format=%(refname)", "refs/rbox-incoming", "refs/rbox-local/base-present/v2", "refs/rbox-local/base-present-keep/v2"], true);
    rec.assert(`[${label}] incoming and P/K recovery refs absent`, refs.exitCode === 0 && refs.stdout.trim() === "", refs.stdout.trim() || "none");
  }
  const journal = await device.exec(["sh", "-ceu", `test ! -d '${GUEST.workDir}/.rbox/state/git-journal' || test -z \"$(find '${GUEST.workDir}/.rbox/state/git-journal' -mindepth 1 -print -quit)\"`], { allowFail: true });
  rec.assert(`[${label}] checkout journal absent`, journal.exitCode === 0, `exit ${journal.exitCode}`);
}

async function assertAck(rec: Recorder, device: Device, rel: string, label: string): Promise<void> {
  const record = (await readState(device)).repoRecords?.[rel];
  const origins = Object.values(record?.branchBaseOrigins ?? {});
  rec.assert(`[${label}] advertised checkpoint present`, record?.advertised !== undefined, record?.advertised ? "present" : "missing");
  rec.assert(`[${label}] publisher-ack provenance present`, origins.some((origin) => origin.kind === "publisher-ack"), JSON.stringify(origins));
}

export interface SettlementRound {
  readonly exitA: number;
  readonly exitB: number;
  readonly sequenceA: number | undefined;
  readonly sequenceB: number | undefined;
}

export interface SettlementResult {
  readonly rounds: readonly SettlementRound[];
  readonly accepted?: number;
  readonly exitsZero: boolean;
  readonly converged: boolean;
  readonly stable: boolean;
}

/** Complete ordered A→B rounds, then one extra round proving the fixed point. */
export async function settleSequenceFixedPoint(runRound: () => Promise<SettlementRound>, maxSettlementRounds = 4): Promise<SettlementResult> {
  const rounds: SettlementRound[] = [];
  for (let attempt = 0; attempt < maxSettlementRounds; attempt++) {
    const round = await runRound();
    rounds.push(round);
    if (round.exitA !== 0 || round.exitB !== 0) return { rounds, exitsZero: false, converged: false, stable: false };
    if (round.sequenceA === round.sequenceB && round.sequenceA !== undefined && round.sequenceA >= 0) {
      const accepted = round.sequenceA;
      const verification = await runRound();
      rounds.push(verification);
      const verificationZero = verification.exitA === 0 && verification.exitB === 0;
      const stable = verificationZero && verification.sequenceA === accepted && verification.sequenceB === accepted;
      return { rounds, accepted, exitsZero: verificationZero, converged: true, stable };
    }
  }
  return { rounds, exitsZero: true, converged: false, stable: false };
}

async function assertNoopCycle(ctx: RigCtx, rec: Recorder, label: string): Promise<void> {
  let retried = 0;
  // A live-API round trip can drop a single request. One retry per sync
  // attempt, only on the exact CLI timeout surface, recorded in the trace; any
  // other nonzero exit — or a timed-out retry — still fails the settlement
  // assertion.
  const settleSync = async (device: Device) => {
    const first = await device.rbox(["sync"], { cwd: GUEST.workDir, allowFail: true });
    if (first.exitCode === 0 || !/rbox: The operation timed out\./.test(`${first.stdout}${first.stderr}`)) return first;
    retried += 1;
    return await device.rbox(["sync"], { cwd: GUEST.workDir, allowFail: true });
  };
  const result = await settleSequenceFixedPoint(async () => {
    const settleA = await settleSync(ctx.a);
    const settleB = await settleSync(ctx.b);
    const [stateA, stateB] = await Promise.all([readState(ctx.a), readState(ctx.b)]);
    return { exitA: settleA.exitCode, exitB: settleB.exitCode, sequenceA: stateA.lastSyncedSequence, sequenceB: stateB.lastSyncedSequence };
  });
  const trace = `${result.rounds.map((round) => `${round.sequenceA ?? "?"}/${round.sequenceB ?? "?"}[${round.exitA}/${round.exitB}]`).join(" → ")}${retried > 0 ? ` (timeout-retries=${retried})` : ""}`;
  rec.assert(`[${label}] settlement cycles exit zero`, result.exitsZero, trace);
  rec.assert(`[${label}] A/B consumed accepted sequence`, result.converged, trace);
  // A later B publisher can legitimately win an ordered round (the live bisect
  // trace was 5/6 then 6/6). Only the next complete stable round is the no-op pin.
  rec.assert(`[${label}] next full cycle publishes nothing`, result.stable, `accepted=${result.accepted ?? "?"} ${trace}`);
}

async function commitRoundTrip(ctx: RigCtx, rec: Recorder, rel: string, filename = "receiver.txt"): Promise<void> {
  const { branch, got, oid, pushExit, pullExit } = await attemptCommitRoundTrip(ctx, rel, filename);
  rec.assert(`[${rel}] B commit reaches A`, pushExit === 0 && pullExit === 0 && branch !== "" && got === oid, `push=${pushExit} pull=${pullExit} branch=${branch || "(detached)"} A=${got.slice(0, 12)} B=${oid.slice(0, 12)}`);
}

interface CommitRoundTripEvidence {
  branch: string;
  got: string;
  oid: string;
  plainAtA: string | undefined;
  pushExit: number;
  pullExit: number;
  pushOutput: string;
}

async function attemptCommitRoundTrip(ctx: RigCtx, rel: string, filename = "receiver.txt"): Promise<CommitRoundTripEvidence> {
  const plain = `from B ${rel}\n`;
  await ctx.b.writeFile(`${GUEST.workDir}/${rel}/${filename}`, plain);
  await git(ctx.b, rel, ["add", filename]);
  await git(ctx.b, rel, ["-c", "user.name=Rig Tester", "-c", "user.email=rig@example.com", "commit", "-q", "-m", "receiver roundtrip"]);
  const oid = (await git(ctx.b, rel, ["rev-parse", "HEAD"])).stdout.trim();
  const branch = (await git(ctx.b, rel, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
  const pushed = await ctx.b.rbox(["push"], { cwd: GUEST.workDir, env: UPLOAD, allowFail: true });
  const pulled = await ctx.a.rbox(["pull"], { cwd: GUEST.workDir, env: DOWNLOAD, allowFail: true });
  const got = (await git(ctx.a, rel, ["rev-parse", `refs/heads/${branch}`])).stdout.trim();
  const plainAtA = await ctx.a.readFileIfExists(`${GUEST.workDir}/${rel}/${filename}`);
  return { branch, got, oid, plainAtA, pushExit: pushed.exitCode, pullExit: pulled.exitCode, pushOutput: `${pushed.stdout}\n${pushed.stderr}` };
}

async function runS1A(ctx: RigCtx, rec: Recorder): Promise<void> {
  const { description: d, initA, initB } = await provisionCell(ctx, rec, "s1-a");
  rec.assert("[s1-a] product preflight refusal exact", await productPreflightReason(ctx.a, "s1-a") === d.refusal, d.refusal);
  const expected = planLine({ captured: ["s1-a/mod"], deferred: [{ relPath: "s1-a", reason: `${d.refusal} — section not captured` }] });
  rec.assert("[s1-a] exact parent refusal/child capture plan", `${initA.stdout}\n${initA.stderr}`.includes(expected), expected);
  rec.assert("[s1-a/mod] exact apply log", `${initB.stdout}\n${initB.stderr}`.includes(GIT_LAYOUT_SURFACES.applied("s1-a/mod")), GIT_LAYOUT_SURFACES.applied("s1-a/mod"));
  const [parentGit, childGit, parentFile] = await Promise.all([
    ctx.b.exec(["test", "-e", `${GUEST.workDir}/s1-a/.git`], { allowFail: true }),
    ctx.b.exec(["test", "-d", `${GUEST.workDir}/s1-a/mod/.git`], { allowFail: true }),
    ctx.b.readFileIfExists(`${GUEST.workDir}/s1-a/parent.txt`),
  ]);
  rec.assert("[s1-a] B parent native section absent/plain present", parentGit.exitCode !== 0 && parentFile === "parent bytes\n", `git=${parentGit.exitCode} plain=${JSON.stringify(parentFile)}`);
  const parentStatus = await git(ctx.b, "s1-a", ["status", "--porcelain=v1"], true);
  rec.assert("[s1-a] B parent exact not-repository surface", parentStatus.exitCode === 128 && /fatal: not a git repository/.test(parentStatus.stderr), `exit=${parentStatus.exitCode} ${parentStatus.stderr.trim()}`);
  rec.assert("[s1-a/mod] pointer materialized standalone", childGit.exitCode === 0, `exit ${childGit.exitCode}`);
  await assertStatusAndFsck(rec, ctx.b, "s1-a/mod", "", "s1-a/mod");
  await assertAck(rec, ctx.a, "s1-a/mod", "s1-a/mod/A");
  const status = await readStatus(ctx.a);
  const rows = status.parsed?.git?.deferrals ?? [];
  const projected = status.parsed?.git?.deferredRepos ?? [];
  const row = rows[0];
  rec.assert("[s1-a] capture/unsupported durable JSON", rows.length === 1 && row?.repo === "s1-a" && row?.lane === "capture" && row?.reason === "unsupported" && row?.bytesChanged === false && row?.checkout === undefined && typeof row?.deferredSince === "string" && !Number.isNaN(Date.parse(row.deferredSince as string)) && projected.length === 1 && projected[0]?.displayReason === "unsupported", `${JSON.stringify(rows)} ${JSON.stringify(projected)}`);
  const human = await ctx.a.rbox(["status"], { cwd: GUEST.workDir, env: { NO_COLOR: "1" }, allowFail: true });
  const version = (await ctx.a.exec(["git", "--version"])).stdout.trim();
  rec.assert("[s1-a] misleading capability display pinned", human.stdout.includes(GIT_LAYOUT_SURFACES.unsupportedCapability(version, "s1-a")), human.stdout.trim().slice(-500));
  await assertEmptyDeferrals(rec, ctx.b, "s1-a/mod", "s1-a/mod/settled");
  await assertNoopCycle(ctx, rec, "s1-a");
}

async function runS1B(ctx: RigCtx, rec: Recorder): Promise<void> {
  const { initA, initB } = await provisionCell(ctx, rec, "s1-b");
  rec.assert("[s1-b] exact capture plan", `${initA.stdout}\n${initA.stderr}`.includes(planLine({ captured: ["s1-b"] })), planLine({ captured: ["s1-b"] }));
  rec.assert("[s1-b] exact apply log", `${initB.stdout}\n${initB.stderr}`.includes(GIT_LAYOUT_SURFACES.applied("s1-b")), GIT_LAYOUT_SURFACES.applied("s1-b"));
  const dotgit = await ctx.b.exec(["test", "-d", `${GUEST.workDir}/s1-b/.git`], { allowFail: true });
  rec.assert("[s1-b] B has standalone .git directory", dotgit.exitCode === 0, `exit ${dotgit.exitCode}`);
  const [aHead, bHead, refs, stash] = await Promise.all([git(ctx.a, "s1-b", ["rev-parse", "HEAD"]), git(ctx.b, "s1-b", ["rev-parse", "HEAD"]), git(ctx.b, "s1-b", ["for-each-ref", "--format=%(refname)", "refs/heads"]), git(ctx.b, "s1-b", ["rev-parse", "--verify", "refs/stash"], true)]);
  rec.assert("[s1-b] scoped HEAD/current branch only", aHead.stdout === bHead.stdout && refs.stdout.trim() === "refs/heads/synced" && stash.exitCode !== 0, refs.stdout.trim());
  await assertStatusAndFsck(rec, ctx.b, "s1-b", "", "s1-b");
  await assertEmptyDeferrals(rec, ctx.b, "s1-b", "s1-b");
  await assertEmptyDeferrals(rec, ctx.a, "s1-b", "s1-b/A");
  await assertAck(rec, ctx.a, "s1-b", "s1-b/A");
  await commitRoundTrip(ctx, rec, "s1-b");
  await assertNoopCycle(ctx, rec, "s1-b");
}

async function runS1C(ctx: RigCtx, rec: Recorder): Promise<void> {
  const { initA, initB } = await provisionCell(ctx, rec, "s1-c");
  rec.assert("[s1-c] exact capture/apply lines", `${initA.stdout}\n${initA.stderr}`.includes(planLine({ captured: ["s1-c"] })) && `${initB.stdout}\n${initB.stderr}`.includes(GIT_LAYOUT_SURFACES.applied("s1-c")), `${initA.stdout}${initA.stderr}\n${initB.stdout}${initB.stderr}`.trim().slice(-800));
  const [aEntry, bEntry, mod] = await Promise.all([git(ctx.a, "s1-c", ["ls-files", "--stage", "mod"]), git(ctx.b, "s1-c", ["ls-files", "--stage", "mod"]), ctx.b.exec(["test", "-e", `${GUEST.workDir}/s1-c/mod`], { allowFail: true })]);
  rec.assert("[s1-c] mode-160000/OID index entry exact", aEntry.stdout === bEntry.stdout && /^160000 [0-9a-f]{40} 0\tmod\n$/.test(bEntry.stdout), JSON.stringify(bEntry.stdout));
  rec.assert("[s1-c] empty mod path not materialized", mod.exitCode !== 0, `exit ${mod.exitCode}`);
  const [modulesA, modulesB, submoduleStatus] = await Promise.all([ctx.a.readFile(`${GUEST.workDir}/s1-c/.gitmodules`), ctx.b.readFile(`${GUEST.workDir}/s1-c/.gitmodules`), git(ctx.b, "s1-c", ["submodule", "status"])]);
  const submoduleOid = bEntry.stdout.split(/\s+/)[1];
  rec.assert("[s1-c] .gitmodules and submodule status exact", modulesA === modulesB && submoduleStatus.stdout === `-${submoduleOid} mod\n`, `${JSON.stringify(modulesB)} ${JSON.stringify(submoduleStatus.stdout)}`);
  await assertStatusAndFsck(rec, ctx.b, "s1-c", " D mod\n", "s1-c/B");
  await assertStatusAndFsck(rec, ctx.a, "s1-c", "", "s1-c/A");
  await assertEmptyDeferrals(rec, ctx.b, "s1-c", "s1-c");
  await assertEmptyDeferrals(rec, ctx.a, "s1-c", "s1-c/A");
  await assertAck(rec, ctx.a, "s1-c", "s1-c/A");
  await commitRoundTrip(ctx, rec, "s1-c", "unrelated.txt");
  const [afterA, afterB] = await Promise.all([git(ctx.a, "s1-c", ["status", "--porcelain=v1"]), git(ctx.b, "s1-c", ["status", "--porcelain=v1"])]);
  rec.assert("[s1-c] roundtrip retains asymmetric porcelain", afterA.stdout === "" && afterB.stdout === " D mod\n", `A=${JSON.stringify(afterA.stdout)} B=${JSON.stringify(afterB.stdout)}`);
  await assertNoopCycle(ctx, rec, "s1-c");
}

function lfsCachePath(rel: string, pointer: string): string {
  const oid = pointer.split("\n").find((line) => line.startsWith("oid sha256:"))?.slice("oid sha256:".length);
  if (!oid) throw new Error(`${rel}: malformed LFS pointer`);
  return `${GUEST.workDir}/${rel}/.git/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`;
}

async function runLfs(ctx: RigCtx, rec: Recorder, configured: boolean): Promise<void> {
  const rel = configured ? "s2-configured" : "s2-unconfigured";
  await provisionCell(ctx, rec, rel, { afterPair: true });
  const sourceFilterBefore = await git(ctx.a, rel, ["config", "--local", "--get-regexp", "^filter\\.lfs\."], true);
  const pointerRef = "refs/heads/main:asset.bin";
  const sourcePointer = (await git(ctx.a, rel, ["cat-file", "-p", pointerRef])).stdout;
  const lfsVersion = await ctx.b.exec(["/usr/bin/git-lfs", "version"], { allowFail: true });
  rec.assert(`[${rel}] git-lfs binary available`, lfsVersion.exitCode === 0 && /git-lfs\/\d/.test(lfsVersion.stdout), lfsVersion.stdout.trim() || lfsVersion.stderr.trim());
  if (configured) {
    await ctx.b.exec(["/usr/bin/git-lfs", "install", "--skip-repo"]);
    const filters = await ctx.b.exec(["git", "config", "--global", "--get-regexp", "^filter\\.lfs\."], { allowFail: true });
    rec.assert(`[${rel}] effective global filters configured`, filters.exitCode === 0 && /filter\.lfs\.(?:process|clean)/.test(filters.stdout), filters.stdout.trim());
  } else {
    await ctx.b.exec(["sh", "-ceu", "git config --global --remove-section filter.lfs 2>/dev/null || :; git config --system --remove-section filter.lfs 2>/dev/null || :"]);
    const [globalFilters, systemFilters] = await Promise.all([
      ctx.b.exec(["git", "config", "--global", "--get-regexp", "^filter\\.lfs\."], { allowFail: true }),
      ctx.b.exec(["git", "config", "--system", "--get-regexp", "^filter\\.lfs\."], { allowFail: true }),
    ]);
    rec.assert(`[${rel}] effective global/system filters absent`, globalFilters.exitCode === 1 && globalFilters.stdout === "" && systemFilters.exitCode === 1 && systemFilters.stdout === "", `global=${globalFilters.exitCode} system=${systemFilters.exitCode}`);
  }
  const firstPush = await pushA(ctx);
  const firstPull = await pullB(ctx);
  const firstRepo = await ctx.b.exec(["test", "-e", `${GUEST.workDir}/${rel}/.git`], { allowFail: true });
  rec.assert(`[${rel}] first transfer is exact files-only boundary`, firstPush.exitCode === 0 && firstPull.exitCode === 0 && /\bgit-plan \S+ hit0m0u0 pps0 sp0 prc0\b/.test(firstPush.stdout) && /\bgit-apply \S+ mode=fresh repos=0\b/.test(firstPull.stdout) && firstRepo.exitCode !== 0, `push=${firstPush.exitCode} pull=${firstPull.exitCode} git=${firstRepo.exitCode}\n${firstPush.stdout}${firstPush.stderr}\n${firstPull.stdout}${firstPull.stderr}`.trim().slice(-800));
  const attachPush = await pushA(ctx);
  const attachPull = await pullB(ctx);
  const attachedRepo = await ctx.b.exec(["test", "-d", `${GUEST.workDir}/${rel}/.git`], { allowFail: true });
  rec.assert(`[${rel}] follow-up capture/apply materializes native repo`, attachPush.exitCode === 0 && attachPull.exitCode === 0 && `${attachPush.stdout}\n${attachPush.stderr}`.includes(planLine({ captured: [rel] })) && `${attachPull.stdout}\n${attachPull.stderr}`.includes(GIT_LAYOUT_SURFACES.applied(rel)) && attachedRepo.exitCode === 0, `push=${attachPush.exitCode} pull=${attachPull.exitCode} git=${attachedRepo.exitCode}\n${attachPush.stdout}${attachPush.stderr}\n${attachPull.stdout}${attachPull.stderr}`.trim().slice(-800));
  const pointer = (await git(ctx.b, rel, ["cat-file", "-p", pointerRef])).stdout;
  const cache = lfsCachePath(rel, pointer);
  const expectedOid = (await ctx.b.exec(["sha256sum", `${GUEST.workDir}/${rel}/asset.bin`])).stdout.split(/\s+/)[0];
  const expectedPointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${expectedOid}\nsize ${Buffer.byteLength(LFS_PAYLOAD)}\n`;
  const initialPayloadHex = Buffer.from(LFS_PAYLOAD).toString("hex");
  rec.assert(`[${rel}] committed pointer exact`, sourcePointer === expectedPointer && pointer === sourcePointer, pointer);
  rec.assert(`[${rel}] worktree payload byte exact`, await fileHex(ctx.b, `${GUEST.workDir}/${rel}/asset.bin`) === initialPayloadHex, "guest hex");
  const config = await git(ctx.b, rel, ["config", "--local", "--get-regexp", "^filter\\.lfs\."], true);
  const preCache = await ctx.b.exec(["test", "-e", cache], { allowFail: true });
  rec.assert(`[${rel}] local filter config not synced`, config.exitCode === 1 && config.stdout === "", `exit=${config.exitCode} ${config.stdout}`);
  rec.assert(`[${rel}] LFS cache absent before status`, preCache.exitCode !== 0, cache);
  const status = await git(ctx.b, rel, ["status", "--porcelain=v1"], true);
  rec.assert(`[${rel}] exact porcelain`, status.stdout === (configured ? "" : " M asset.bin\n"), JSON.stringify(status.stdout));
  const postCache = await ctx.b.exec(["test", "-e", cache], { allowFail: true });
  rec.assert(`[${rel}] cache outcome is local-filter behavior`, configured ? postCache.exitCode === 0 && await fileHex(ctx.b, cache) === initialPayloadHex : postCache.exitCode !== 0, `exit=${postCache.exitCode}`);
  await assertStatusAndFsck(rec, ctx.b, rel, configured ? "" : " M asset.bin\n", rel);
  await assertEmptyDeferrals(rec, ctx.b, rel, rel);
  await assertEmptyDeferrals(rec, ctx.a, rel, `${rel}/A`);
  await assertAck(rec, ctx.a, rel, `${rel}/A`);
  if (configured) {
    const changedPayload = "changed-lfs-payload\n";
    const changedHex = Buffer.from(changedPayload).toString("hex");
    await ctx.b.writeFile(`${GUEST.workDir}/${rel}/asset.bin`, changedPayload);
    await git(ctx.b, rel, ["add", "asset.bin"]);
    await git(ctx.b, rel, ["-c", "user.name=Rig Tester", "-c", "user.email=rig@example.com", "commit", "-q", "-m", "changed lfs"]);
    const oid = (await git(ctx.b, rel, ["rev-parse", "HEAD"])).stdout.trim();
    const changedPointer = (await git(ctx.b, rel, ["cat-file", "-p", pointerRef])).stdout;
    const bChangedCache = lfsCachePath(rel, changedPointer);
    rec.assert(`[${rel}] B changed pointer/payload/cache exact`, changedPointer !== pointer && await fileHex(ctx.b, `${GUEST.workDir}/${rel}/asset.bin`) === changedHex && await fileHex(ctx.b, bChangedCache) === changedHex, changedPointer);
    await ctx.b.rbox(["push"], { cwd: GUEST.workDir }); await ctx.a.rbox(["pull"], { cwd: GUEST.workDir });
    const aCache = lfsCachePath(rel, changedPointer);
    const aCacheBeforeStatus = await ctx.a.exec(["test", "-e", aCache], { allowFail: true });
    const aPointer = (await git(ctx.a, rel, ["cat-file", "-p", pointerRef])).stdout;
    rec.assert(`[${rel}] changed pointer/plain payload reach A`, (await git(ctx.a, rel, ["rev-parse", "HEAD"])).stdout.trim() === oid && aPointer === changedPointer && await fileHex(ctx.a, `${GUEST.workDir}/${rel}/asset.bin`) === changedHex, oid.slice(0, 12));
    rec.assert(`[${rel}] A cache absent immediately after pull`, aCacheBeforeStatus.exitCode !== 0, aCache);
    await git(ctx.a, rel, ["status", "--porcelain=v1"]);
    const sourceFilterAfter = await git(ctx.a, rel, ["config", "--local", "--get-regexp", "^filter\\.lfs\."], true);
    rec.assert(`[${rel}] A cache recreates only on configured read`, await fileHex(ctx.a, aCache) === changedHex, aCache);
    rec.assert(`[${rel}] source-local filter config unchanged`, sourceFilterAfter.stdout === sourceFilterBefore.stdout && sourceFilterAfter.exitCode === sourceFilterBefore.exitCode, sourceFilterAfter.stdout.trim());
  } else {
    await commitRoundTrip(ctx, rec, rel, "unrelated.txt");
    const afterPointer = (await git(ctx.b, rel, ["cat-file", "-p", pointerRef])).stdout;
    const afterConfig = await git(ctx.b, rel, ["config", "--local", "--get-regexp", "^filter\\.lfs\."], true);
    const afterCache = await ctx.b.exec(["test", "-e", cache], { allowFail: true });
    const afterStatus = await git(ctx.b, rel, ["status", "--porcelain=v1"]);
    rec.assert(`[${rel}] unrelated roundtrip preserves pointer/payload`, afterPointer === pointer && await fileHex(ctx.b, `${GUEST.workDir}/${rel}/asset.bin`) === initialPayloadHex, afterPointer);
    rec.assert(`[${rel}] unrelated roundtrip preserves mismatch/config/cache`, afterStatus.stdout === " M asset.bin\n" && afterConfig.exitCode === 1 && afterConfig.stdout === "" && afterCache.exitCode !== 0, `status=${JSON.stringify(afterStatus.stdout)} config=${afterConfig.exitCode} cache=${afterCache.exitCode}`);
  }
  await assertNoopCycle(ctx, rec, rel);
}

async function runUnicode(ctx: RigCtx, rec: Recorder): Promise<void> {
  await provisionCell(ctx, rec, "s3-unicode"); await pushA(ctx); await pullB(ctx);
  const [aNames, bNames] = await Promise.all([basenameHexSet(ctx.a, `${GUEST.workDir}/s3-unicode`), basenameHexSet(ctx.b, `${GUEST.workDir}/s3-unicode`)]);
  const expected = [NFC_FILENAME_HEX, NFD_FILENAME_HEX].sort();
  rec.assert("[s3-unicode] pathname bytes exact A/B", JSON.stringify(aNames) === JSON.stringify(expected) && JSON.stringify(bNames) === JSON.stringify(expected), `A=${aNames} B=${bNames}`);
  for (const nameHex of expected) {
    const name = nameHex === NFC_FILENAME_HEX ? "caf\u00e9.txt" : "cafe\u0301.txt";
    rec.assert(`[s3-unicode] ${nameHex} file bytes exact`, await fileHex(ctx.a, `${GUEST.workDir}/s3-unicode/${name}`) === await fileHex(ctx.b, `${GUEST.workDir}/s3-unicode/${name}`), nameHex);
  }
  await assertStatusAndFsck(rec, ctx.b, "s3-unicode", "", "s3-unicode");
  await assertEmptyDeferrals(rec, ctx.b, "s3-unicode", "s3-unicode");
  await assertEmptyDeferrals(rec, ctx.a, "s3-unicode", "s3-unicode/A");
  await assertAck(rec, ctx.a, "s3-unicode", "s3-unicode/A");
  await commitRoundTrip(ctx, rec, "s3-unicode");
  await assertNoopCycle(ctx, rec, "s3-unicode");
}

async function runCase(ctx: RigCtx, rec: Recorder): Promise<void> {
  await provisionCell(ctx, rec, "s3-case", { afterPair: true });
  const [beforeA, beforeB] = await Promise.all([readState(ctx.a), readState(ctx.b)]);
  const published = await pushA(ctx);
  const accepted = (await readState(ctx.a)).lastSyncedSequence ?? -1;
  const first = await pullB(ctx); const second = await pullB(ctx);
  const afterB = (await readState(ctx.b)).lastSyncedSequence ?? -1;
  const body1 = first.stdout + first.stderr; const body2 = second.stdout + second.stderr;
  rec.assert("[s3-case] source publish accepted", published.exitCode === 0 && accepted > (beforeA.lastSyncedSequence ?? -1), `exit=${published.exitCode} before=${beforeA.lastSyncedSequence} accepted=${accepted}`);
  rec.assert("[s3-case] exact receiver manifest rejection", first.exitCode !== 0 && body1.includes(GIT_LAYOUT_REFUSALS.caseCollision), body1.trim().slice(-500));
  rec.assert("[s3-case] identical receiver rejection on retry", second.exitCode !== 0 && body2.includes(GIT_LAYOUT_REFUSALS.caseCollision), body2.trim().slice(-500));
  rec.assert("[s3-case] accepted sequence remains unconsumed on B", afterB === (beforeB.lastSyncedSequence ?? -1) && afterB < accepted, `before=${beforeB.lastSyncedSequence} accepted=${accepted} B=${afterB}`);
  const bEntries = await ctx.b.exec(["sh", "-ceu", `find '${GUEST.workDir}' -mindepth 1 -maxdepth 1 ! -name .rbox -print`]);
  rec.assert("[s3-case] B unchanged", bEntries.stdout.trim() === "", bEntries.stdout.trim() || "empty");
}

async function runShallow(ctx: RigCtx, rec: Recorder): Promise<void> {
  const { description: d, initA } = await provisionCell(ctx, rec, "s4-shallow");
  const pre = await ctx.a.exec(["git", "-C", `${GUEST.workDir}/s4-shallow`, "rev-parse", "--is-shallow-repository"]);
  rec.assert("[s4-shallow] source is shallow", pre.stdout.trim() === "true", pre.stdout.trim());
  const productReason = await productPreflightReason(ctx.a, "s4-shallow");
  rec.assert("[s4-shallow] exact product refusal/hint", productReason === d.refusal, productReason);
  await pushA(ctx); await pullB(ctx);
  const bGit = await ctx.b.exec(["test", "-e", `${GUEST.workDir}/s4-shallow/.git`], { allowFail: true });
  rec.assert("[s4-shallow] plain bytes/no native repo", bGit.exitCode !== 0 && await ctx.b.readFileIfExists(`${GUEST.workDir}/s4-shallow/history.txt`) !== undefined, `git=${bGit.exitCode}`);
  const status = await readStatus(ctx.a); const rows = status.parsed?.git?.deferrals ?? [];
  rec.assert("[s4-shallow] durable capture/unsupported", rows.length === 1 && rows[0]?.repo === "s4-shallow" && rows[0]?.reason === "unsupported", JSON.stringify(rows));
  const beforeRetry = (await readState(ctx.a)).lastSyncedSequence;
  await pushA(ctx);
  const state = await readState(ctx.a);
  rec.assert("[s4-shallow] refusal becomes repoAbsent locally", state.repoRecords?.["s4-shallow"]?.repoAbsent === true, JSON.stringify(state.repoRecords?.["s4-shallow"]));
  rec.assert("[s4-shallow] retry does not advance remote sequence", state.lastSyncedSequence === beforeRetry, `${beforeRetry}/${state.lastSyncedSequence}`);
  const expectedReason = `${d.refusal} — section not captured`;
  const emittedPlan = `${initA.stdout}\n${initA.stderr}`.split("\n").find((line) => line.startsWith("git-sync: captured"));
  rec.assert("[s4-shallow] exact refusal/suffix when emission gate is reached", emittedPlan === undefined || emittedPlan === planLine({ deferred: [{ relPath: "s4-shallow", reason: expectedReason }] }), emittedPlan ?? "no forensic plan line (allowed no-op gate)");
  const human = await ctx.a.rbox(["status"], { cwd: GUEST.workDir, env: { NO_COLOR: "1" }, allowFail: true });
  const version = (await ctx.a.exec(["git", "--version"])).stdout.trim();
  rec.assert("[s4-shallow] misleading capability display pinned", human.stdout.includes(GIT_LAYOUT_SURFACES.unsupportedCapability(version, "s4-shallow")), human.stdout.trim().slice(-500));
  await assertNoopCycle(ctx, rec, "s4-shallow");
}

async function missingObjects(device: Device, rel: string): Promise<string[]> {
  const result = await device.exec(["sh", "-ceu", `GIT_NO_LAZY_FETCH=1 git -C '${GUEST.workDir}/${rel}' rev-list --objects --all --missing=print | sed -n 's/^?//p' | sort`]);
  return result.stdout.trim().split("\n").filter(Boolean);
}

async function expectedPartialMissing(device: Device, cell: "s4-partial-online" | "s4-partial-offline"): Promise<string[]> {
  const origin = `/tmp/rbox-git-layouts-${cell}/${cell}-origin`;
  const [o1, o2] = await Promise.all([
    device.exec(["git", "-C", origin, "rev-parse", "HEAD~2:payload.bin"]),
    device.exec(["git", "-C", origin, "rev-parse", "HEAD~1:payload.bin"]),
  ]);
  return [o1.stdout.trim(), o2.stdout.trim()].sort();
}

const PARTIAL_ONLINE_CONFIG = [
  ["remote.origin.promisor", "true"],
  ["remote.origin.partialclonefilter", "blob:none"],
  ["remote.origin.url", "file:///tmp/rbox-git-layouts-s4-partial-online/s4-partial-online-origin"],
] as const;

async function runPartialOnline(ctx: RigCtx, rec: Recorder): Promise<void> {
  await provisionCell(ctx, rec, "s4-partial-online", { afterPair: true });
  const expectedMissing = await expectedPartialMissing(ctx.a, "s4-partial-online");
  const pre = await missingObjects(ctx.a, "s4-partial-online");
  rec.assert("[s4-partial-online] PRE missing exactly O1/O2", JSON.stringify(pre) === JSON.stringify(expectedMissing), `expected=${expectedMissing} actual=${pre}`);
  const push = await pushA(ctx);
  const post = await missingObjects(ctx.a, "s4-partial-online");
  rec.assert("[s4-partial-online] PRE=POST missing exactly O1/O2", JSON.stringify(post) === JSON.stringify(expectedMissing) && JSON.stringify(pre) === JSON.stringify(post), `EXPECTED=${expectedMissing} PRE=${pre} POST=${post}`);
  const pushOutput = `${push.stdout}\n${push.stderr}`;
  const unexpectedPlanSurfaces = ["git-sync:", "capturing git state", "attaching git history"].filter((surface) => pushOutput.includes(surface));
  const emptyPlanMetrics = /\bgit-plan \S+ hit0m0u0 pps0 sp0 prc0\b/.test(push.stdout);
  rec.assert("[s4-partial-online] exact empty capture plan", push.exitCode === 0 && unexpectedPlanSurfaces.length === 0 && emptyPlanMetrics, `exit=${push.exitCode} unexpected=${unexpectedPlanSurfaces.join(",") || "none"} ${pushOutput.trim().slice(-800)}`);

  const assertSourcePromisorConfig = async (boundary: "post-push" | "post-settlement") => {
    for (const [key, expectedValue] of PARTIAL_ONLINE_CONFIG) {
      const value = await git(ctx.a, "s4-partial-online", ["config", "--local", "--get", key], true);
      rec.assert(`[s4-partial-online] ${boundary} source ${key} exact`, value.exitCode === 0 && value.stdout.trim() === expectedValue, `exit=${value.exitCode} value=${JSON.stringify(value.stdout.trim())}`);
    }
    const extension = await git(ctx.a, "s4-partial-online", ["config", "--local", "--get", "extensions.partialClone"], true);
    rec.assert(`[s4-partial-online] ${boundary} source extensions.partialClone absent`, extension.exitCode === 1 && extension.stdout === "", `exit=${extension.exitCode} value=${JSON.stringify(extension.stdout.trim())}`);
  };
  const assertRepoRecordsAbsent = async () => {
    for (const [side, device] of [["A", ctx.a], ["B", ctx.b]] as const) {
      const record = (await readState(device)).repoRecords?.["s4-partial-online"];
      rec.assert(`[s4-partial-online] post-pull ${side} repo record absent`, record === undefined, JSON.stringify(record));
    }
  };
  await assertSourcePromisorConfig("post-push");
  await pullB(ctx);
  const assertReceiverPlainOnly = async () => {
    const [payload, gitDirAbsent, repo] = await Promise.all([
      ctx.b.readFileIfExists(`${GUEST.workDir}/s4-partial-online/payload.bin`),
      ctx.b.exec(["sh", "-ceu", `test ! -e '${GUEST.workDir}/s4-partial-online/.git'`], { allowFail: true }),
      git(ctx.b, "s4-partial-online", ["rev-parse", "--git-dir"], true),
    ]);
    rec.assert(`[s4-partial-online] post-pull B plain bytes/no native repo`, payload === "payload-three\n" && gitDirAbsent.exitCode === 0 && repo.exitCode === 128 && repo.stderr.includes("not a git repository"), `payload=${JSON.stringify(payload)} git=${gitDirAbsent.exitCode} rev-parse=${repo.exitCode} ${repo.stderr.trim()}`);
  };
  await assertReceiverPlainOnly();
  await assertEmptyDeferrals(rec, ctx.b, "s4-partial-online", "s4-partial-online", false);
  await assertEmptyDeferrals(rec, ctx.a, "s4-partial-online", "s4-partial-online/A");
  await assertRepoRecordsAbsent();
  await assertNoopCycle(ctx, rec, "s4-partial-online");
  const settledMissing = await missingObjects(ctx.a, "s4-partial-online");
  rec.assert("[s4-partial-online] post-settlement missing set empty", settledMissing.length === 0, `actual=${settledMissing}`);
  await assertSourcePromisorConfig("post-settlement");
  const [settledPayload, settledGitDir, settledRepo, settledA, settledB] = await Promise.all([
    ctx.b.readFileIfExists(`${GUEST.workDir}/s4-partial-online/payload.bin`),
    ctx.b.exec(["test", "-d", `${GUEST.workDir}/s4-partial-online/.git`], { allowFail: true }),
    git(ctx.b, "s4-partial-online", ["rev-parse", "--git-dir"], true),
    readState(ctx.a),
    readState(ctx.b),
  ]);
  rec.assert("[s4-partial-online] post-settlement B exact bytes/native repo", settledPayload === "payload-three\n" && settledGitDir.exitCode === 0 && settledRepo.exitCode === 0 && settledRepo.stdout === ".git\n", `payload=${JSON.stringify(settledPayload)} git=${settledGitDir.exitCode} rev-parse=${settledRepo.exitCode} ${JSON.stringify(settledRepo.stdout)}`);
  const aRecord = settledA.repoRecords?.["s4-partial-online"];
  const bRecord = settledB.repoRecords?.["s4-partial-online"];
  const recordSettled = (record: RepoRecordView | undefined) => record?.sourceSeq === 2 && record.base !== undefined && record.pending === undefined && record.partial === undefined && record.resolutionKey === undefined && record.deferrals === undefined;
  rec.assert("[s4-partial-online] post-settlement A repo record exact shape", recordSettled(aRecord) && aRecord?.advertised !== undefined && Object.values(aRecord.branchBaseOrigins ?? {}).some((origin) => origin.kind === "publisher-ack"), JSON.stringify(aRecord));
  rec.assert("[s4-partial-online] post-settlement B repo record exact shape", recordSettled(bRecord) && bRecord?.advertised === undefined && Object.values(bRecord?.branchBaseOrigins ?? {}).some((origin) => origin.kind === "pull-p"), JSON.stringify(bRecord));
}

async function runPartialOffline(ctx: RigCtx, rec: Recorder): Promise<void> {
  await provisionCell(ctx, rec, "s4-partial-offline", { afterPair: true });
  const version = (await ctx.a.exec(["git", "--version"])).stdout.trim();
  rec.assert("[s4-partial-offline] guest Git version ratified", version === EXPECTED_GIT_VERSION, version);
  const expectedMissing = await expectedPartialMissing(ctx.a, "s4-partial-offline");
  const pre = await missingObjects(ctx.a, "s4-partial-offline");
  await ctx.a.exec(["mv", "/tmp/rbox-git-layouts-s4-partial-offline/s4-partial-offline-origin", "/tmp/rbox-git-layouts-s4-partial-offline/origin-offline"]);
  const push = await pushA(ctx, { ...UPLOAD, GIT_NO_LAZY_FETCH: "1" });
  await pullB(ctx);
  const post = await missingObjects(ctx.a, "s4-partial-offline");
  rec.assert("[s4-partial-offline] PRE=POST missing O1/O2", JSON.stringify(pre) === JSON.stringify(expectedMissing) && JSON.stringify(pre) === JSON.stringify(post), `EXPECTED=${expectedMissing} PRE=${pre} POST=${post}`);
  const output = `${push.stdout}\n${push.stderr}`;
  const status = await readStatus(ctx.a); const rows = status.parsed?.git?.deferrals ?? [];
  const projected = status.parsed?.git?.deferredRepos ?? [];
  const unexpectedCaptureSurfaces = ["git-sync:", "capturing git state", "attaching git history"].filter((surface) => output.includes(surface));
  rec.assert("[s4-partial-offline] first push exact empty Git capture boundary", push.exitCode === 0 && /\bgit-plan \S+ hit0m0u0 pps0 sp0 prc0\b/.test(push.stdout) && unexpectedCaptureSurfaces.length === 0, `exit=${push.exitCode} unexpected=${unexpectedCaptureSurfaces.join(",") || "none"} ${output.trim().slice(-800)}`);
  rec.assert("[s4-partial-offline] first push deferral rows empty", rows.length === 0, JSON.stringify(rows));
  rec.assert("[s4-partial-offline] first push deferredRepos empty", projected.length === 0, JSON.stringify(projected));
  const human = await ctx.a.rbox(["status"], { cwd: GUEST.workDir, env: { NO_COLOR: "1" }, allowFail: true });
  rec.assert("[s4-partial-offline] exact pending-Git human surface", human.stdout.includes(GIT_LAYOUT_SURFACES.partialOfflinePendingHuman) && human.stdout.includes("git-sync: 0 repos synced") && !human.stdout.includes("git deferral:") && !/git deferred \S+:/.test(human.stdout), human.stdout.trim().slice(-800));
  const bGit = await ctx.b.exec(["test", "-e", `${GUEST.workDir}/s4-partial-offline/.git`], { allowFail: true });
  const bPayload = await ctx.b.readFileIfExists(`${GUEST.workDir}/s4-partial-offline/payload.bin`);
  rec.assert("[s4-partial-offline] B exact plain bytes/no repo", bGit.exitCode !== 0 && bPayload === "payload-three\n", `git=${bGit.exitCode} payload=${JSON.stringify(bPayload)}`);
  const stateBeforeCapture = await readState(ctx.a); const beforeCapture = stateBeforeCapture.lastSyncedSequence;
  const durableBeforeCapture = stateBeforeCapture.repoRecords?.["s4-partial-offline"]?.deferrals?.capture;
  const captureAttempt = await pushA(ctx, { ...UPLOAD, GIT_NO_LAZY_FETCH: "1" });
  const afterCaptureStatus = await readStatus(ctx.a); const captureRows = afterCaptureStatus.parsed?.git?.deferrals ?? []; const captureRow = captureRows[0]; const captureProjected = afterCaptureStatus.parsed?.git?.deferredRepos ?? []; const stateAfterCapture = await readState(ctx.a); const afterCapture = stateAfterCapture.lastSyncedSequence;
  const durableAfterCapture = stateAfterCapture.repoRecords?.["s4-partial-offline"]?.deferrals?.capture;
  const episode = captureRow?.deferredSince;
  const episodeDatesValid = typeof episode === "string" && !Number.isNaN(Date.parse(episode)) && captureRow?.reasonSince === episode && typeof captureRow?.ageSeconds === "number";
  const publicRowExact = captureRows.length === 1 && captureRow?.repo === "s4-partial-offline" && captureRow.lane === "capture" && captureRow.reason === GIT_LAYOUT_SURFACES.partialOfflineReason && captureRow.bytesChanged === false && captureRow.checkout === undefined && episodeDatesValid;
  const projectedRow = captureProjected[0];
  const projectionExact = captureProjected.length === 1 && projectedRow?.repo === "s4-partial-offline" && projectedRow.oldestDeferredSince === episode && projectedRow.displayReason === GIT_LAYOUT_SURFACES.partialOfflineReason && typeof projectedRow.ageSeconds === "number" && projectedRow.bytesChanged === false && projectedRow.checkout === undefined;
  const durableExact = durableAfterCapture?.lane === "capture" && durableAfterCapture.reason === GIT_LAYOUT_SURFACES.partialOfflineReason && durableAfterCapture.deferredSince === episode && durableAfterCapture.reasonSince === episode && durableAfterCapture.lastSeen === episode && durableAfterCapture.bytesChanged !== true;
  rec.assert("[s4-partial-offline] first Git capture attempt holds exact sequence with no prior episode", captureAttempt.exitCode === 0 && /\bgit-plan \S+ hit0m0u0 pps0 sp1 prc0\b/.test(captureAttempt.stdout) && beforeCapture === 1 && afterCapture === 1 && durableBeforeCapture === undefined, `exit=${captureAttempt.exitCode} ${beforeCapture}/${afterCapture} before=${JSON.stringify(durableBeforeCapture)} ${captureAttempt.stdout.trim().slice(-300)}`);
  rec.assert("[s4-partial-offline] first Git capture public worktree-ownership projection exact", publicRowExact && projectionExact, `${JSON.stringify(captureRows)} ${JSON.stringify(captureProjected)}`);
  rec.assert("[s4-partial-offline] first Git capture durable worktree-ownership episode exact", durableExact, JSON.stringify(durableAfterCapture));
}

async function opSnapshot(device: Device, rel: string): Promise<string> {
  const roots = GIT_LAYOUT_OP_STATE_ROOTS.join(" ");
  const script = `set -e; cd '${GUEST.workDir}/${rel}'; gd=$(git rev-parse --git-dir); printf 'HEAD '; od -An -tx1 -v "$gd/HEAD"; printf 'INDEX '; od -An -tx1 -v "$gd/index"; for n in ${roots}; do p=$(git rev-parse --git-path "$n"); test ! -e "$p" || { printf '%s ' "$n"; if test -d "$p"; then find "$p" -type f -print0 | sort -z | xargs -0 -r sha256sum; else sha256sum "$p"; fi; }; done; printf 'WORK '; sha256sum conflict.txt`;
  return (await device.exec(["sh", "-ceu", script])).stdout;
}

const OP_IDENT = ["-c", "user.name=Rig Tester", "-c", "user.email=rig@example.com"] as const;

async function runOperation(ctx: RigCtx, rec: Recorder, findings: GitLayoutFinding[], kind: "merge" | "rebase" | "cherry-pick"): Promise<void> {
  const rel = `s5-${kind}` as const;
  await provisionCell(ctx, rec, rel); await pushA(ctx); await pullB(ctx);
  const [baseA, baseB, cleanA, cleanB] = await Promise.all([
    git(ctx.a, rel, ["rev-parse", "refs/heads/main"]),
    git(ctx.b, rel, ["rev-parse", "refs/heads/main"]),
    git(ctx.a, rel, ["status", "--porcelain=v1"]),
    git(ctx.b, rel, ["status", "--porcelain=v1"]),
  ]);
  const baseOid = baseA.stdout.trim();
  const baseDetail = `A=${baseA.stdout.trim()} B=${baseB.stdout.trim()} statusA=${JSON.stringify(cleanA.stdout)} statusB=${JSON.stringify(cleanB.stdout)}`;
  requireAssertion(rec, `[${rel}] clean shared BASE before receiver operation`, baseOid !== "" && baseA.stdout === baseB.stdout && cleanA.stdout === "" && cleanB.stdout === "", baseDetail);
  if (kind === "merge") {
    // Incoming-BASE control: an operation authored by A is allowed to arrive on
    // B, and its later deletion is allowed because B's bytes still equal BASE.
    const sourceMarkerAbsent = await ctx.a.exec(["test", "!", "-e", `${GUEST.workDir}/${rel}/.git/MERGE_HEAD`], { allowFail: true });
    const sourceMerge = await git(ctx.a, rel, [...OP_IDENT, "merge", "operation-side"], true);
    const sourceMergeHead = await ctx.a.exec(["test", "-e", `${GUEST.workDir}/${rel}/.git/MERGE_HEAD`], { allowFail: true });
    const sourceStatus = await git(ctx.a, rel, ["status", "--porcelain=v1"]);
    const sourceStartDetail = `absent=${sourceMarkerAbsent.exitCode} merge=${sourceMerge.exitCode} MERGE_HEAD=${sourceMergeHead.exitCode} status=${JSON.stringify(sourceStatus.stdout)} stderr=${JSON.stringify(sourceMerge.stderr.trim())}`;
    requireAssertion(rec, `[${rel}] source merge entered genuine conflict`, sourceMarkerAbsent.exitCode === 0 && sourceMerge.exitCode === 1 && sourceMergeHead.exitCode === 0 && sourceStatus.stdout === "UU conflict.txt\n", sourceStartDetail);
    await pushA(ctx); await pullB(ctx);
    const [mergeA, mergeB] = await Promise.all([
      fileHex(ctx.a, `${GUEST.workDir}/${rel}/.git/MERGE_HEAD`),
      fileHex(ctx.b, `${GUEST.workDir}/${rel}/.git/MERGE_HEAD`),
    ]);
    requireAssertion(rec, `[${rel}] incoming-BASE MERGE_HEAD applied`, mergeA === mergeB && mergeA !== "", mergeA || "missing");
    const reset = await git(ctx.a, rel, ["reset", "--hard", "HEAD"], true);
    const sourceMergeCleared = await ctx.a.exec(["test", "-e", `${GUEST.workDir}/${rel}/.git/MERGE_HEAD`], { allowFail: true });
    const cleanupDetail = `reset=${reset.exitCode} MERGE_HEAD=${sourceMergeCleared.exitCode}`;
    requireAssertion(rec, `[${rel}] source merge cleanup ready for deletion publish`, reset.exitCode === 0 && sourceMergeCleared.exitCode !== 0, cleanupDetail);
    await pushA(ctx); await pullB(ctx);
    const staleMerge = await ctx.b.exec(["test", "-e", `${GUEST.workDir}/${rel}/.git/MERGE_HEAD`], { allowFail: true });
    const bAfterDeletion = await git(ctx.b, rel, ["status", "--porcelain=v1"]);
    requireAssertion(rec, `[${rel}] incoming-BASE MERGE_HEAD deletion applied`, staleMerge.exitCode !== 0 && bAfterDeletion.stdout === "", `MERGE_HEAD=${staleMerge.exitCode} status=${JSON.stringify(bAfterDeletion.stdout)}`);
  }
  const marker = kind === "merge" ? "MERGE_HEAD" : kind === "rebase" ? "rebase-merge" : "CHERRY_PICK_HEAD";
  const markerPath = `${GUEST.workDir}/${rel}/.git/${marker}`;
  const receiverMarkerAbsent = await ctx.b.exec(["test", "!", "-e", markerPath], { allowFail: true });
  const receiverOp = kind === "merge"
    ? await git(ctx.b, rel, [...OP_IDENT, "merge", "operation-side"], true)
    : kind === "rebase"
      ? await git(ctx.b, rel, ["rebase", "operation-side"], true)
      : await git(ctx.b, rel, ["cherry-pick", "operation-side"], true);
  const receiverMarkerPresent = await ctx.b.exec(["test", "-e", markerPath], { allowFail: true });
  const receiverStatus = await git(ctx.b, rel, ["status", "--porcelain=v1"]);
  const receiverHead = await git(ctx.b, rel, ["symbolic-ref", "--short", "HEAD"], true);
  const receiverStartDetail = `absent=${receiverMarkerAbsent.exitCode} op=${receiverOp.exitCode} marker=${receiverMarkerPresent.exitCode} status=${JSON.stringify(receiverStatus.stdout)} head=${JSON.stringify(receiverHead.stdout.trim())} stderr=${JSON.stringify(receiverOp.stderr.trim())}`;
  requireAssertion(rec, `[${rel}] receiver ${kind} entered genuine conflict`, receiverMarkerAbsent.exitCode === 0 && receiverOp.exitCode === 1 && receiverMarkerPresent.exitCode === 0 && receiverStatus.stdout === "UU conflict.txt\n" && (kind !== "rebase" || receiverHead.exitCode !== 0), receiverStartDetail);
  await assertStatusAndFsck(rec, ctx.b, rel, "UU conflict.txt\n", `${rel}/deferred`);
  const before = await opSnapshot(ctx.b, rel);
  if (kind !== "rebase") await git(ctx.a, rel, [...OP_IDENT, "commit", "--allow-empty", "-q", "-m", "incoming empty"]);
  const tagOid = (await git(ctx.a, rel, ["rev-parse", "HEAD"])).stdout.trim();
  const deltaDetail = `BASE=${baseOid.slice(0, 12)} incoming=${tagOid.slice(0, 12)}`;
  requireAssertion(rec, `[${rel}] source incoming delta matches operation contract`, kind === "rebase" ? tagOid === baseOid : tagOid !== baseOid, deltaDetail);
  await git(ctx.a, rel, ["tag", `incoming-${kind}`]);
  await pushA(ctx);
  await assertAck(rec, ctx.a, rel, `${rel}/A-incoming`);
  let pullOutput = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const pull = await pullB(ctx); pullOutput += pull.stdout + pull.stderr;
    const after = await opSnapshot(ctx.b, rel);
    rec.assert(`[${rel}] receiver-only pull ${attempt} preserves HEAD/index/op/worktree`, after === before, after === before ? "byte-identical" : "snapshot changed");
    await assertStatusAndFsck(rec, ctx.b, rel, "UU conflict.txt\n", `${rel}/pull-${attempt}`);
  }
  const state = await readState(ctx.b); const record = state.repoRecords?.[rel]; const def = record?.deferrals?.apply;
  const tagWitness = Object.values(record?.partial?.appliedRefs ?? {}).some((w) => w.kind === "safe-ref" && w.proof === "expected-old-transaction" && w.beforeOid === null && w.afterOid === tagOid);
  rec.assert(`[${rel}] public reason is apply/local-edits`, def?.reason === "local-edits" && def.bytesChanged !== true, JSON.stringify(def));
  rec.assert(`[${rel}] exact pending/partial/tag witness`, record?.pending !== undefined && record.partial?.checkoutPending === true && Object.keys(record.partial.heldRefs ?? {}).length === 0 && record.partial.configApplied === true && tagWitness, JSON.stringify(record?.partial));
  const checkout = kind === "rebase" ? def?.checkout?.kind === "detached" : def?.checkout?.kind === "branch";
  rec.assert(`[${rel}] checkout shape exact`, checkout, JSON.stringify(def?.checkout));
  const statusJson = await readStatus(ctx.b); const statusRows = statusJson.parsed?.git?.deferrals ?? []; const statusRepos = statusJson.parsed?.git?.deferredRepos ?? [];
  rec.assert(`[${rel}] exact status JSON projection`, statusRows.length === 1 && statusRows[0]?.repo === rel && statusRows[0]?.lane === "apply" && statusRows[0]?.reason === "local-edits" && statusRows[0]?.bytesChanged === false && statusRepos.length === 1 && statusRepos[0]?.displayReason === "local-edits", `${JSON.stringify(statusRows)} ${JSON.stringify(statusRepos)}`);
  const human = await ctx.b.rbox(["status"], { cwd: GUEST.workDir, env: { NO_COLOR: "1" }, allowFail: true });
  const branch = kind === "rebase" ? undefined : "main";
  rec.assert(`[${rel}] exact 0m human deferral row`, human.stdout.includes(GIT_LAYOUT_SURFACES.operationHuman(rel, branch)), human.stdout.trim().slice(-500));
  rec.assert(`[${rel}] exact deferred log reasons`, pullOutput.includes(GIT_LAYOUT_SURFACES.operationDeferredPrefix(rel)), pullOutput.trim().slice(-800));
  const resolve = await ctx.b.rbox(["git", "resolve", rel], { cwd: GUEST.workDir, allowFail: true });
  rec.assert(`[${rel}] resolve proves hidden operation veto`, resolve.stdout.includes(GIT_LAYOUT_SURFACES.operationResolve), resolve.stdout.trim());
  await git(ctx.b, rel, kind === "merge" ? ["merge", "--abort"] : kind === "rebase" ? ["rebase", "--abort"] : ["cherry-pick", "--abort"]);
  const [markerCleared, cleanAfterAbort, branchAfterAbort, bytesAfterAbort] = await Promise.all([
    ctx.b.exec(["test", "!", "-e", markerPath], { allowFail: true }),
    git(ctx.b, rel, ["status", "--porcelain=v1"]),
    git(ctx.b, rel, ["symbolic-ref", "--short", "HEAD"], true),
    ctx.b.readFile(`${GUEST.workDir}/${rel}/conflict.txt`),
  ]);
  const abortDetail = `marker=${markerCleared.exitCode} status=${JSON.stringify(cleanAfterAbort.stdout)} branch=${JSON.stringify(branchAfterAbort.stdout)} bytes=${JSON.stringify(bytesAfterAbort)}`;
  requireAssertion(rec, `[${rel}] abort restores exact clean main BASE`, markerCleared.exitCode === 0 && cleanAfterAbort.stdout === "" && branchAfterAbort.exitCode === 0 && branchAfterAbort.stdout === "main\n" && bytesAfterAbort === "incoming-side\n", abortDetail);
  const settledPull = await pullB(ctx);
  const settledOutput = `${settledPull.stdout}\n${settledPull.stderr}`;
  if (kind === "rebase") {
    rec.assert(`[${rel}] post-abort follow exposes exact EPIPE engine gap`, settledPull.exitCode === 0 && /\bresults=deferred=1\b/.test(settledOutput) && settledOutput.includes(GIT_LAYOUT_SURFACES.rebasePostAbortEpipe) && !settledOutput.includes(GIT_LAYOUT_SURFACES.followed(rel)), settledOutput.trim().slice(-500));
    await assertStatusAndFsck(rec, ctx.b, rel, "", `${rel}/post-abort-gap`);
    const [status, state] = await Promise.all([readStatus(ctx.b), readState(ctx.b)]);
    const statusRows = status.parsed?.git?.deferrals ?? [];
    const statusRepos = status.parsed?.git?.deferredRepos ?? [];
    const gapStatus = statusRows[0] as { repo?: unknown; lane?: unknown; reason?: unknown; bytesChanged?: unknown; checkout?: { kind?: unknown; label?: unknown } } | undefined;
    const gapRepo = statusRepos[0] as { repo?: unknown; displayReason?: unknown; bytesChanged?: unknown; checkout?: { kind?: unknown; label?: unknown } } | undefined;
    const gapRecord = state.repoRecords?.[rel];
    const gapDeferral = gapRecord?.deferrals?.apply;
    rec.assert(`[${rel}] post-abort gap persists apply/other on clean main`, statusRows.length === 1 && gapStatus?.repo === rel && gapStatus.lane === "apply" && gapStatus.reason === "other" && gapStatus.bytesChanged === false && gapStatus.checkout?.kind === "branch" && gapStatus.checkout.label === "main" && statusRepos.length === 1 && gapRepo?.repo === rel && gapRepo.displayReason === "other" && gapRepo.bytesChanged === false && gapRepo.checkout?.kind === "branch" && gapRepo.checkout.label === "main" && Object.keys(gapRecord?.deferrals ?? {}).join(",") === "apply" && gapDeferral?.lane === "apply" && gapDeferral.reason === "other" && gapDeferral.checkout?.kind === "branch" && gapDeferral.checkout.label === "main", `${JSON.stringify(statusRows)} ${JSON.stringify(statusRepos)} ${JSON.stringify(gapDeferral)}`);
    const retainedTagWitness = Object.values(gapRecord?.partial?.appliedRefs ?? {}).some((w) => w.kind === "safe-ref" && w.proof === "expected-old-transaction" && w.beforeOid === null && w.afterOid === tagOid);
    rec.assert(`[${rel}] post-abort gap retains pending/partial/tag witness`, gapRecord?.pending !== undefined && gapRecord.partial?.checkoutPending === true && Object.keys(gapRecord.partial.heldRefs ?? {}).length === 0 && gapRecord.partial.configApplied === true && retainedTagWitness && gapRecord.resolutionKey === undefined && state.gitPendingRemote?.[rel] !== undefined && state.gitNeedsResolution?.[rel] === undefined, `${JSON.stringify(gapRecord)} pendingRemote=${JSON.stringify(state.gitPendingRemote?.[rel])} needsResolution=${JSON.stringify(state.gitNeedsResolution?.[rel])}`);
    await assertNoRecoveryArtifacts(rec, ctx.b, rel, `${rel}/post-abort-gap`);
    await assertEmptyDeferrals(rec, ctx.a, rel, `${rel}/A-post-abort`);
    const roundTrip = await attemptCommitRoundTrip(ctx, rel);
    rec.assert(`[${rel}] post-abort gap blocks B commit while plain file reaches A`, roundTrip.pushExit === 0 && roundTrip.pullExit === 0 && /\bgit-plan \S+ hit0m0u0 pps0 sp0 prc0\b/.test(roundTrip.pushOutput) && !roundTrip.pushOutput.includes(planLine({ captured: [rel] })) && roundTrip.branch === "main" && roundTrip.got !== roundTrip.oid && roundTrip.plainAtA === `from B ${rel}\n`, `push=${roundTrip.pushExit} pull=${roundTrip.pullExit} branch=${roundTrip.branch || "(detached)"} A=${roundTrip.got.slice(0, 12)} B=${roundTrip.oid.slice(0, 12)} plain=${JSON.stringify(roundTrip.plainAtA)}`);
    findings.push({
      slug: "engine-gap: rebase-post-abort-epipe",
      cell: rel,
      summary: "a completed clean rebase abort is followed by an EPIPE deferral that retains pending/partial state and blocks native B-to-A propagation",
      evidence: [abortDetail, "results=deferred=1", GIT_LAYOUT_SURFACES.rebasePostAbortEpipe, "apply reason=other on branch main", "pending and partial.checkoutPending remain", `B commit=${roundTrip.oid}`, `A main=${roundTrip.got}`],
    });
    return;
  }
  rec.assert(`[${rel}] clean follow log`, settledOutput.includes(GIT_LAYOUT_SURFACES.followed(rel)), `${settledPull.stdout}${settledPull.stderr}`.trim().slice(-500));
  await assertStatusAndFsck(rec, ctx.b, rel, "", `${rel}/settled`);
  await assertEmptyDeferrals(rec, ctx.b, rel, `${rel}/settled`);
  await assertEmptyDeferrals(rec, ctx.a, rel, `${rel}/A-settled`);
  await commitRoundTrip(ctx, rec, rel);
  await assertNoopCycle(ctx, rec, rel);
}

async function bisectMetadata(device: Device, rel: string): Promise<string> {
  const script = `set -e; cd '${GUEST.workDir}/${rel}'; gd=$(git rev-parse --git-dir); for p in "$gd"/BISECT_*; do test ! -e "$p" || sha256sum "$p"; done; git for-each-ref --format='%(refname) %(objectname)' refs/bisect`;
  return (await device.exec(["sh", "-ceu", script])).stdout;
}

async function runBisect(ctx: RigCtx, rec: Recorder, findings: GitLayoutFinding[]): Promise<void> {
  const rel = "s5-bisect";
  await provisionCell(ctx, rec, rel); await pushA(ctx); await pullB(ctx);
  await git(ctx.b, rel, ["bisect", "start", "HEAD", "HEAD~4"]);
  const [candidate, metadata, worktreeBefore] = await Promise.all([git(ctx.b, rel, ["rev-parse", "HEAD"]), bisectMetadata(ctx.b, rel), fileHex(ctx.b, `${GUEST.workDir}/${rel}/stable.txt`)]);
  await git(ctx.a, rel, ["-c", "user.name=Rig Tester", "-c", "user.email=rig@example.com", "commit", "--allow-empty", "-q", "-m", "incoming after bisect"]);
  const incoming = (await git(ctx.a, rel, ["rev-parse", "HEAD"])).stdout.trim();
  await pushA(ctx); await assertAck(rec, ctx.a, rel, `${rel}/A-incoming`); const pull = await pullB(ctx);
  const [headFile, head, afterMetadata, indexA, indexB] = await Promise.all([
    ctx.b.readFile(`${GUEST.workDir}/${rel}/.git/HEAD`), git(ctx.b, rel, ["rev-parse", "HEAD"]), bisectMetadata(ctx.b, rel), git(ctx.a, rel, ["write-tree"]), git(ctx.b, rel, ["write-tree"]),
  ]);
  rec.assert("[s5-bisect] HEAD reattaches and moves", candidate.stdout.trim() !== incoming && headFile === "ref: refs/heads/main\n" && head.stdout.trim() === incoming, `candidate=${candidate.stdout.trim().slice(0, 12)} incoming=${incoming.slice(0, 12)} head=${head.stdout.trim().slice(0, 12)}`);
  rec.assert("[s5-bisect] semantic index equals incoming", indexA.stdout === indexB.stdout, `A=${indexA.stdout.trim()} B=${indexB.stdout.trim()}`);
  rec.assert("[s5-bisect] unmanaged BISECT metadata unchanged", afterMetadata === metadata, afterMetadata.trim());
  const longStatus = await git(ctx.b, rel, ["status"]);
  rec.assert("[s5-bisect] worktree bytes stable and long status remains bisect-active", await fileHex(ctx.b, `${GUEST.workDir}/${rel}/stable.txt`) === worktreeBefore && /bisect/i.test(longStatus.stdout), longStatus.stdout.trim().slice(0, 500));
  await assertStatusAndFsck(rec, ctx.b, rel, "", rel);
  await assertEmptyDeferrals(rec, ctx.b, rel, rel);
  await assertEmptyDeferrals(rec, ctx.a, rel, `${rel}/A`);
  const deferrals = await ctx.b.rbox(["git", "deferrals"], { cwd: GUEST.workDir, allowFail: true });
  rec.assert("[s5-bisect] no deferred surface and positive follow log", deferrals.stdout.includes(GIT_LAYOUT_SURFACES.noDeferredRepos) && !(pull.stdout + pull.stderr).includes("git-sync deferred") && (pull.stdout + pull.stderr).includes(GIT_LAYOUT_SURFACES.followed("s5-bisect")), `${deferrals.stdout}\n${pull.stdout}${pull.stderr}`.trim().slice(-800));
  await commitRoundTrip(ctx, rec, rel);
  await assertNoopCycle(ctx, rec, rel);
  findings.push({ slug: "engine-gap: bisect-invisible", cell: rel, summary: "sync reattached HEAD and replaced the semantic index while unmanaged bisect metadata persisted", evidence: [`candidate=${candidate.stdout.trim()}`, `incoming=${incoming}`, "HEAD=ref: refs/heads/main", "semantic index=incoming", "BISECT_* and refs/bisect unchanged", "no deferral fired"] });
}

type CellRunner = (ctx: RigCtx, rec: Recorder, findings: GitLayoutFinding[]) => Promise<void>;
const CELL_RUNNERS: readonly [GitLayoutCell, CellRunner][] = [
  ["s1-a", (ctx, rec) => runS1A(ctx, rec)],
  ["s1-b", (ctx, rec) => runS1B(ctx, rec)],
  ["s1-c", (ctx, rec) => runS1C(ctx, rec)],
  ["s2-configured", (ctx, rec) => runLfs(ctx, rec, true)],
  ["s2-unconfigured", (ctx, rec) => runLfs(ctx, rec, false)],
  ["s3-unicode", (ctx, rec) => runUnicode(ctx, rec)],
  ["s3-case", (ctx, rec) => runCase(ctx, rec)],
  ["s4-shallow", (ctx, rec) => runShallow(ctx, rec)],
  ["s4-partial-online", runPartialOnline],
  ["s4-partial-offline", (ctx, rec) => runPartialOffline(ctx, rec)],
  ["s5-merge", (ctx, rec, findings) => runOperation(ctx, rec, findings, "merge")],
  ["s5-rebase", (ctx, rec, findings) => runOperation(ctx, rec, findings, "rebase")],
  ["s5-cherry-pick", (ctx, rec, findings) => runOperation(ctx, rec, findings, "cherry-pick")],
  ["s5-bisect", runBisect],
];

export const gitLayouts: Scenario = {
  name: "git-layouts",
  async run(ctx: RigCtx): Promise<ScenarioReport> {
    const startedAt = new Date().toISOString();
    const rec = createRecorder(ctx);
    const findings: GitLayoutFinding[] = [];
    rec.assert("fifteen normative outcomes registered", GIT_LAYOUT_OUTCOMES.length === 15, GIT_LAYOUT_OUTCOMES.join(", "));
    for (const [cell, runner] of CELL_RUNNERS) {
      ctx.log(`\n── git-layouts cell ${cell} ──`);
      try {
        await rec.step(`[${cell}] full normative lifecycle`, () => runner(ctx, rec, findings));
        await probeHealth(ctx, rec, findings, cell, "cell-boundary");
      } catch (error) {
        ctx.log(`✗ ${cell} aborted: ${errMsg(error)}`);
        await probeHealth(ctx, rec, findings, cell, "operation-timeout-or-abort").catch((probeError) => ctx.log(`health probe failed: ${errMsg(probeError)}`));
      }
      await writeFile(path.join(ctx.runDir, "git-layouts-findings.md"), renderGitLayoutFindings(findings), "utf8");
      try { await teardownAccount(ctx, rec); } catch (error) { ctx.log(`cell teardown failed: ${errMsg(error)}`); }
      await resetBetweenCells(ctx, cell);
    }
    rec.assert("bisect engine gap recorded", findings.some((f) => f.slug === "engine-gap: bisect-invisible"), findings.map((f) => f.slug).join(", "));
    rec.assert("rebase post-abort engine gap recorded", findings.some((f) => f.slug === "engine-gap: rebase-post-abort-epipe"), findings.map((f) => f.slug).join(", "));
    await writeFile(path.join(ctx.runDir, "git-layouts-findings.md"), renderGitLayoutFindings(findings), "utf8");
    return finalizeReport({ scenario: gitLayouts.name, startedAt, finishedAt: new Date().toISOString(), steps: rec.steps, assertions: rec.assertions });
  },
};
