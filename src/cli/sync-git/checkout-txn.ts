import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { hashBytes } from "../../engine/hash.js";
import { fsyncDirectory } from "../../engine/fsutil.js";
import { addTimedMs, type GitChainTimings } from "./chain-timings.js";
import { clearIndexResolveUndo, moveFileAtomic, readRegularFileNoFollow, walkFiles, ZERO_OID, type RepoCtx } from "./git-state.js";
import { cleanGitEnv, git } from "../../engine/git-spawn.js";
import { readOpState, pruneEmptyOpStateDirs } from "./refs.js";
import { updateCheckoutJournal, type CheckoutJournal } from "./journal.js";
import { MutationGateClosedError, type MutationBoundary, type MutationLease } from "../../engine/mutation-gate.js";
import {
  formatLockMarker,
  observeLockMarker,
  publishLockMarker,
  releaseObservedLock,
  safeBoundLockParent,
  sameMarkerObservation,
  serializeMarkerObservation,
  systemLockIdentity,
  type LockIdentitySource,
  type MarkerObservation,
} from "../../engine/lockfile.js";

const exec = promisify(execFile);

export type CheckoutRefUpdate =
  | { kind: "create"; ref: string; newOid: string }
  | { kind: "update"; ref: string; newOid: string; oldOid: string }
  | { kind: "delete"; ref: string; oldOid: string };

export type CheckoutHeadUpdate =
  | { kind: "symbolic"; newTarget: string; oldTarget?: string; oldOid?: string }
  | { kind: "detached"; newOid: string; oldOid: string };

export interface CheckoutPlan {
  /** Incoming index bytes. Undefined with removeIndex publishes index absence. */
  candidateIndexPath?: string;
  removeIndex?: boolean;
  refUpdates: CheckoutRefUpdate[];
  /** Updates to HEAD's former referent during a branch switch/detach. Git
   * rejects these in the same update-ref transaction as the HEAD change, so
   * checkout-txn prepares both transactions before the boundary proof and
   * commits them as one journal-arbitrated checkout publication. */
  postHeadRefUpdates?: CheckoutRefUpdate[];
  postHeadExtraTransactionLines?: string[];
  /** Exact P episode for a checked-out branch transition committed after HEAD. */
  postHeadReflogMessage?: string;
  head: CheckoutHeadUpdate;
  /** create-only recovery-pin lines already provenance-persisted by keep-pins. */
  extraTransactionLines?: string[];
  /** Exact P episode for a checked-out branch transition in the primary txn. */
  reflogMessage?: string;
  plannedGraphRoots: string[];
  opState: Array<{ rel: string; tmp: string }>;
  /** Automatic ORIG_HEAD breadcrumb adoption only. The journal sidecar already
   * owns this id; exact old bytes (including absence) are rechecked under Git's
   * pseudo-ref lock before the boundary proof. */
  origHeadLock?: { journalId: string; expectedOldBytes: Uint8Array | null };
  /** Narrow raw-forensics arm: refs/* still validates via show-ref, while fsck
   * skips pseudo-ref parsing so malformed preserved ORIG_HEAD alone can heal. */
  malformedOrigHeadPreserved?: true;
  /** Refs used as durability witnesses or read by HEAD but not mutated in
   * this transaction. Their ordinary ref lock is held across the boundary
   * proof and commit. */
  refReservations?: Array<{ ref: string; expectedOid: string | null }>;
}

export interface OwnedGitLock {
  path: string;
  dev: number;
  ino: number;
}

export interface SecondProofContext {
  ownedLocks: readonly OwnedGitLock[];
  busy: () => Promise<boolean>;
}

export interface CommitCheckoutOptions<TIntended = unknown> {
  chainTimings?: GitChainTimings;
  connectivityProof?: (repoDir: string, roots: readonly string[]) => Promise<boolean>;
  secondProof: (context: SecondProofContext) => Promise<boolean>;
  /** Branch-switch compatibility phase: proof run after the post-HEAD ref
   * transaction has prepared its locks and before it commits. */
  postHeadSecondProof?: () => Promise<boolean>;
  journal?: { workspaceRoot: string; relPath: string; value: CheckoutJournal<TIntended> };
  crashAt?: (point: "after-connectivity-proof" | "after-prepare" | "after-index-lock" | "after-head-commit" | "after-ref-commit" | "before-index-publish" | "after-index-publish" | "mid-op-state") => void;
  /** Test seam for the real failure mode where Git dies after prepare: ok. */
  afterPrepareChild?: (pid: number, transaction: "primary" | "post-head") => void | Promise<void>;
  /** Test seam for platforms whose process probe answers dead or unknown. */
  identity?: LockIdentitySource;
  capabilityProbe?: CheckoutCapabilityProbe;
  /** Caller already ran the exact capability probe for this transaction. */
  capabilitySupported?: boolean;
  mutationBoundary?: MutationBoundary;
}

export type CommitCheckoutResult =
  | { status: "committed" }
  | { status: "defer"; reason: string; journalIntact?: true }
  | { status: "unsupported"; reason: string };

export const ORIG_HEAD_CHANGED_AT_CHECKOUT_BOUNDARY = "ORIG_HEAD changed at checkout boundary";

export type CheckoutCapabilityProbe = (gitVersion: string) => Promise<boolean>;
export type CheckoutTransactionCapabilityStatus = "supported" | "git-missing" | "version-unavailable" | "probe-failed" | "unsupported";
export interface CheckoutTransactionCapability {
  status: CheckoutTransactionCapabilityStatus;
  version?: string;
}
const capabilityCache = new Map<string, CheckoutTransactionCapability>();
let injectedCapabilityProbe: CheckoutCapabilityProbe | undefined;

export function setCheckoutCapabilityProbeForTests(probe: CheckoutCapabilityProbe | undefined): void {
  injectedCapabilityProbe = probe;
}

export function resetCheckoutCapabilityProbeCacheForTests(): void {
  capabilityCache.clear();
  injectedCapabilityProbe = undefined;
}

class RefTransaction {
  private readonly ready: Promise<void>;
  private child?: ChildProcess;
  private input?: fs.FileHandle;
  private controlDir?: string;
  private stdoutPath?: string;
  private stderrPath?: string;
  private responseOffset = 0;
  private closed = false;
  private childDone = false;
  private childExit?: Promise<number | null>;

  constructor(repoDir: string, reflogMessage?: string) {
    this.ready = this.initialize(repoDir, reflogMessage);
  }

  private async initialize(repoDir: string, reflogMessage?: string): Promise<void> {
    // Bun 1.3's node:child_process buffers a pipe-backed stdin until end(),
    // which cannot drive start/prepare/commit interactively. A private FIFO is
    // still an ordinary kernel pipe to Git, but fs.write reaches it immediately.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-update-ref-"));
    const fifo = path.join(dir, "stdin");
    this.controlDir = dir;
    this.stdoutPath = path.join(dir, "stdout");
    this.stderrPath = path.join(dir, "stderr");
    await exec("mkfifo", [fifo]);
    this.child = spawn("sh", ["-c", 'if [ -n "$5" ]; then exec git -C "$1" update-ref -m "$5" --stdin <"$2" >"$3" 2>"$4"; else exec git -C "$1" update-ref --stdin <"$2" >"$3" 2>"$4"; fi', "rbox-update-ref", repoDir, fifo, this.stdoutPath, this.stderrPath, reflogMessage ?? ""], {
      env: cleanGitEnv(),
      stdio: "ignore",
    });
    // Register lifecycle listeners immediately. A SIGKILL can otherwise land
    // between response failure and finish(), and Bun does not reliably retain
    // a late-observable exitCode for that already-delivered close event.
    this.childExit = new Promise<number | null>((resolve) => {
      this.child!.once("exit", () => { this.childDone = true; });
      this.child!.once("close", (code) => { this.childDone = true; resolve(code); });
      this.child!.once("error", () => { this.childDone = true; resolve(1); });
    });
    await new Promise<void>((resolve, reject) => {
      this.child!.once("spawn", resolve);
      this.child!.once("error", reject);
    });
    this.input = await fs.open(fifo, "w");
  }

  async write(line: string): Promise<void> {
    await this.ready;
    await this.input!.write(`${line}\n`);
  }

  private async response(command: string): Promise<void> {
    await this.write(command);
    for (let tries = 0; tries < 1_000; tries++) {
      const raw = await fs.readFile(this.stdoutPath!, "utf8").catch(() => "");
      const nl = raw.indexOf("\n", this.responseOffset);
      if (nl >= 0) {
        const line = raw.slice(this.responseOffset, nl).replace(/\r$/, "");
        this.responseOffset = nl + 1;
        if (line !== `${command}: ok`) throw new Error(`update-ref ${command} failed: ${line}`);
        return;
      }
      if (this.childDone || this.child!.exitCode !== null || this.child!.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const stderr = await fs.readFile(this.stderrPath!, "utf8").catch(() => "");
    throw new Error(`update-ref ${command} failed: ${stderr.trim() || "no response"}`);
  }

  async start(): Promise<void> { await this.response("start"); }
  async prepare(): Promise<void> { await this.response("prepare"); }
  async processId(): Promise<number> {
    await this.ready;
    if (!this.child?.pid) throw new Error("update-ref child has no process id");
    return this.child.pid;
  }
  async commit(): Promise<void> { await this.response("commit"); await this.finish(); }
  async abort(): Promise<void> {
    if (this.closed) return;
    try { await this.response("abort"); } finally { await this.finish(); }
  }

  private async finish(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.ready.catch(() => {});
    await this.input?.close().catch(() => {});
    const code = this.child ? await this.childExit : 1;
    const stderr = this.stderrPath ? await fs.readFile(this.stderrPath, "utf8").catch(() => "") : "";
    if (this.controlDir) await fs.rm(this.controlDir, { recursive: true, force: true }).catch(() => {});
    if (code !== 0) throw new Error(`git update-ref exited ${code}: ${stderr.trim()}`);
  }
}

async function defaultCapabilityProbe(): Promise<boolean> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-checkout-capability-"));
  try {
    await exec("git", ["-C", root, "init", "-qb", "main"], { env: cleanGitEnv() });
    await exec("git", ["-C", root, "config", "user.email", "rbox@example.invalid"], { env: cleanGitEnv() });
    await exec("git", ["-C", root, "config", "user.name", "rbox"], { env: cleanGitEnv() });
    await exec("git", ["-C", root, "commit", "--allow-empty", "-qm", "probe"], { env: cleanGitEnv() });
    await exec("git", ["-C", root, "branch", "probe"], { env: cleanGitEnv() });
    const tx = new RefTransaction(root);
    try {
      await tx.start();
      await tx.write("option no-deref");
      await tx.write("symref-update HEAD refs/heads/probe ref refs/heads/main");
      await tx.prepare();
      await tx.commit();
      return true;
    } catch (error) {
      await tx.abort().catch(() => {});
      // Older Git rejects the command itself. Other failures mean the
      // functional probe could not complete and must not be mislabeled as an
      // unsupported capability.
      const detail = error instanceof Error ? error.message : "";
      if (/unknown command|invalid command|symref-update/i.test(detail)) return false;
      throw error;
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function cleanGitVersion(value: string): string | undefined {
  const clean = value.replace(/[\r\n\p{Cc}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  return /^git version \S+(?: .*)?$/.test(clean) ? clean : undefined;
}

export async function checkoutTransactionCapability(
  repoDir: string,
  probe?: CheckoutCapabilityProbe,
  versionCommand: () => Promise<{ stdout: Buffer | string }> = () => exec("git", ["--version"], { env: cleanGitEnv() }),
): Promise<CheckoutTransactionCapability> {
  let version: string | undefined;
  try {
    const result = await versionCommand();
    version = cleanGitVersion(result.stdout.toString());
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "git-missing" : "version-unavailable" };
  }
  if (!version) return { status: "version-unavailable" };
  const cached = capabilityCache.get(version);
  if (cached !== undefined) return cached;
  let result: CheckoutTransactionCapability;
  try {
    const supported = await (probe ?? injectedCapabilityProbe ?? (async () => defaultCapabilityProbe()))(version);
    result = { status: supported ? "supported" : "unsupported", version };
  } catch {
    result = { status: "probe-failed", version };
  }
  capabilityCache.set(version, result);
  return result;
}

export async function checkoutTransactionSupported(repoDir: string, probe?: CheckoutCapabilityProbe): Promise<boolean> {
  return (await checkoutTransactionCapability(repoDir, probe)).status === "supported";
}

async function defaultConnectivityProof(repoDir: string, roots: readonly string[], malformedOrigHeadPreserved: boolean): Promise<boolean> {
  if (roots.length === 0) return true;
  try {
    await exec("git", ["-C", repoDir, "rev-list", "--quiet", ...roots, "--"], { env: cleanGitEnv({ GIT_NO_LAZY_FETCH: "1" }), maxBuffer: 16 * 1024 * 1024 });
    // fsck is deliberately pre-commit (r2 F4); there is no post-commit broad
    // rollback that could clobber a human commit.
    if (malformedOrigHeadPreserved) {
      // Keep ordinary refs/* validation exact. Only pseudo-ref parsing is
      // bypassed, and only after malformed ORIG_HEAD bytes were quarantined.
      try {
        await exec("git", ["-C", repoDir, "show-ref"], { env: cleanGitEnv({ GIT_NO_LAZY_FETCH: "1" }), maxBuffer: 16 * 1024 * 1024 });
      } catch (error) {
        // show-ref uses 1 for a valid empty ref database; malformed refs are 128.
        if ((error as { code?: unknown }).code !== 1) throw error;
      }
      await exec("git", ["-C", repoDir, "fsck", "--connectivity-only", "--no-dangling", "--no-references", ...roots], { env: cleanGitEnv({ GIT_NO_LAZY_FETCH: "1" }), maxBuffer: 16 * 1024 * 1024 });
    } else {
      await exec("git", ["-C", repoDir, "fsck", "--connectivity-only", "--no-dangling", ...roots], { env: cleanGitEnv({ GIT_NO_LAZY_FETCH: "1" }), maxBuffer: 16 * 1024 * 1024 });
    }
    return true;
  } catch {
    return false;
  }
}

/** A lock path is only ever proven absent, proven present with its exact
 * ownership token, or unknown. Collapsing the third state into "absent" fails
 * open: an EACCES/EIO/ELOOP `index.lock` would read as "no lock" and let the
 * caller discard the journal that is the lock's only attribution authority. */
type LockProbe = { kind: "absent" } | { kind: "present"; token: OwnedGitLock } | { kind: "indeterminate" };

/** Deliberately NOT `fsutil.isAbsent`, which folds ENOTDIR into ENOENT. On a
 * lock path an ENOTDIR means a component the journal recorded as a directory is
 * now a file — the repository layout moved under us, which is evidence of
 * concurrent mutation, not evidence that the lock is gone. Only ENOENT (final
 * component missing, every parent still a directory) proves absence. */
async function probeLock(abs: string): Promise<LockProbe> {
  try {
    const st = await fs.lstat(abs);
    return { kind: "present", token: { path: path.resolve(abs), dev: st.dev, ino: st.ino } };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "indeterminate" };
  }
}

async function allGitLocks(ctx: RepoCtx): Promise<string[]> {
  const out = new Set<string>();
  for (const root of new Set([ctx.gitDir, ctx.commonDir])) {
    let rels: string[];
    try { rels = await walkFiles(root); } catch { return ["<unreadable>"]; }
    for (const rel of rels) if (rel.endsWith(".lock") || rel === "gc.pid") out.add(path.resolve(root, rel));
  }
  return [...out];
}

/** Design 116 boundary probe: ignore only matching device/inode tokens created
 * by this sequence; a replaced file at the same path remains busy. */
export async function ownershipAwareGitBusy(ctx: RepoCtx, owned: readonly OwnedGitLock[]): Promise<boolean> {
  const allow = new Map(owned.map((token) => [token.path, `${token.dev}:${token.ino}`]));
  for (const abs of await allGitLocks(ctx)) {
    if (abs === "<unreadable>") return true;
    // Busy unless the lock is provably ours: an indeterminate probe cannot
    // produce the token this allow-list matches on, so it stays busy.
    const probe = await probeLock(abs);
    if (probe.kind !== "present" || allow.get(probe.token.path) !== `${probe.token.dev}:${probe.token.ino}`) return true;
  }
  return false;
}

function transactionLines(plan: CheckoutPlan): string[] {
  const lines = [...(plan.extraTransactionLines ?? [])];
  for (const update of plan.refUpdates) {
    if (update.kind === "create") lines.push(`create ${update.ref} ${update.newOid}`);
    else if (update.kind === "update") lines.push(`update ${update.ref} ${update.newOid} ${update.oldOid}`);
    else lines.push(`delete ${update.ref} ${update.oldOid}`);
  }
  if (plan.head.kind === "detached") lines.push(`update HEAD ${plan.head.newOid} ${plan.head.oldOid}`);
  // Git 2.51 rejects a symref verification/update of HEAD in the same prepared
  // transaction that updates HEAD's unchanged referent. In that one shape the
  // expected-old branch update plus the caller's locked second proof verifies
  // the stable symbolic target; branch switches still use symref-update below.
  else if (plan.head.newTarget === plan.head.oldTarget) {
    const oldTarget = plan.head.oldTarget;
    const referentUpdated = plan.refUpdates.some((update) => update.ref === oldTarget)
      || (plan.extraTransactionLines ?? []).some((line) => /^(?:create|update|delete) (refs\/\S+)/.exec(line)?.[1] === oldTarget);
    // Git rejects HEAD verification beside an update of its current referent,
    // because that referent update already reserves HEAD.lock. An index/op-state
    // only checkout has no such update, so verify the symref explicitly.
    if (!referentUpdated) lines.push(`symref-verify HEAD ${oldTarget}`);
  }
  else if (plan.head.oldTarget) lines.push(`symref-update HEAD ${plan.head.newTarget} ref ${plan.head.oldTarget}`);
  else if (plan.head.oldOid) lines.push(`symref-update HEAD ${plan.head.newTarget} oid ${plan.head.oldOid}`);
  else throw new Error("symbolic HEAD update requires an expected old target or OID");
  return lines;
}


function refUpdateLines(updates: readonly CheckoutRefUpdate[], extra: readonly string[] = []): string[] {
  const lines = [...extra];
  for (const update of updates) {
    if (update.kind === "create") lines.push(`create ${update.ref} ${update.newOid}`);
    else if (update.kind === "update") lines.push(`update ${update.ref} ${update.newOid} ${update.oldOid}`);
    else lines.push(`delete ${update.ref} ${update.oldOid}`);
  }
  return lines;
}

function safeReservationRef(ref: string): boolean {
  return ref.startsWith("refs/") && ref.length <= 1024 && !ref.includes("..")
    && !ref.includes("\\") && !ref.includes("//") && !ref.endsWith("/") && !ref.endsWith(".lock");
}

type JournalPreparedTransaction = NonNullable<CheckoutJournal["expectedNew"]["preparedTransactions"]>[number];

function expectedLockBytes(line: string): { ref: string; bytes: string } | undefined {
  const fields = line.split(" ");
  const command = fields[0];
  const ref = fields[1];
  if (!ref || (ref !== "HEAD" && !ref.startsWith("refs/"))) return undefined;
  if (command === "create" || command === "update") {
    const oid = fields[2];
    if (!oid) return undefined;
    return { ref, bytes: Buffer.from(`${oid}\n`).toString("base64") };
  }
  if (command === "delete" || command === "verify" || command === "symref-update" || command === "symref-verify") {
    return { ref, bytes: Buffer.alloc(0).toString("base64") };
  }
  return undefined;
}

async function preparedTransactionIntent(
  ctx: RepoCtx,
  id: JournalPreparedTransaction["id"],
  ownerPid: number,
  lines: readonly string[],
  includeHeadReservation: boolean,
  identity: LockIdentitySource = systemLockIdentity,
): Promise<JournalPreparedTransaction> {
  const current = await identity.current();
  const child = await identity.probe(ownerPid);
  // The journalled owner must be exact, so anything short of a read incarnation
  // aborts. That is only ever ONE deferred cycle: the platform probe answers on
  // the next attempt, and the two outcomes are named apart so a recurring
  // deferral is diagnosable from the log line alone rather than reading as a
  // dead child. A permanently unanswerable probe is a platform defect to fix at
  // the probe (see darwinProcessStart), not a state to record here.
  if (child.status !== "alive") {
    throw new Error(child.status === "dead"
      ? "prepared Git child died before its intent was recorded"
      : "prepared Git child incarnation could not be read");
  }
  const byPath = new Map<string, Set<string>>();
  const add = (abs: string, bytes: string) => {
    const key = path.resolve(abs);
    const values = byPath.get(key) ?? new Set<string>();
    values.add(bytes);
    byPath.set(key, values);
  };
  for (const line of lines) {
    const expected = expectedLockBytes(line);
    if (!expected) continue;
    const abs = expected.ref === "HEAD" ? path.join(ctx.gitDir, "HEAD.lock") : path.join(ctx.commonDir, `${expected.ref}.lock`);
    add(abs, expected.bytes);
  }
  // Updating the checked-out referent also makes files-backend Git reserve
  // HEAD, even when HEAD itself is intentionally omitted from the commands.
  if (includeHeadReservation) add(path.join(ctx.gitDir, "HEAD.lock"), Buffer.alloc(0).toString("base64"));

  const packed = await fs.readFile(path.join(ctx.commonDir, "packed-refs"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const packedNames = new Set(packed.split("\n").filter((line) => line && !line.startsWith("#") && !line.startsWith("^")).map((line) => line.split(" ")[1]).filter(Boolean));
  const deleted = new Set(lines.filter((line) => line.startsWith("delete refs/")).map((line) => line.split(" ")[1]!));
  if ([...deleted].some((ref) => packedNames.has(ref))) {
    const packedLock = path.join(ctx.commonDir, "packed-refs.lock");
    // Files-backend Git may stage either the current packed file or the
    // delete-filtered successor depending on exactly where it dies.
    add(packedLock, Buffer.from(packed).toString("base64"));
    if (deleted.size > 0) {
      const kept: string[] = [];
      let omitPeeled = false;
      for (const line of packed.split("\n")) {
        if (line.startsWith("^")) {
          if (!omitPeeled) kept.push(line);
          continue;
        }
        const ref = line && !line.startsWith("#") ? line.split(" ")[1] : undefined;
        omitPeeled = ref !== undefined && deleted.has(ref);
        if (!omitPeeled) kept.push(line);
      }
      add(packedLock, Buffer.from(kept.join("\n")).toString("base64"));
    }
  }

  return {
    id,
    ownerPid,
    owner: {
      hostId: current.hostId,
      bootId: current.bootId,
      pid: ownerPid,
      startTime: child.startTime,
    },
    prepareStarted: true,
    locks: [...byPath].map(([lockPath, expectedBytes]) => ({ path: lockPath, expectedBytes: [...expectedBytes] })),
  };
}

async function observePreparedLockTokens(transaction: JournalPreparedTransaction): Promise<void> {
  for (const lock of transaction.locks) {
    let stat;
    try {
      stat = await fs.lstat(lock.path, { bigint: true });
    } catch {
      continue;
    }
    // Capture birth time alongside dev/ino so recovery can reject a same-bytes
    // successor that reused this freed inode. 0 = filesystem reports none.
    const token: NonNullable<typeof lock.token> = {
      dev: Number(stat.dev),
      ino: Number(stat.ino),
    };
    if (stat.birthtimeNs > 0n) token.birthtimeNs = stat.birthtimeNs.toString();
    lock.token = token;
  }
}

function activeJournalLockPaths(journal: CheckoutJournal): string[] {
  const out = new Set<string>();
  for (const transaction of journal.expectedNew.preparedTransactions ?? []) {
    if (!transaction.completed) for (const lock of transaction.locks) out.add(lock.path);
  }
  if (journal.expectedNew.headLock?.acquireStarted) out.add(journal.expectedNew.headLock.path);
  if (journal.expectedNew.indexLock) out.add(path.join(journal.binding.gitDirReal, "index.lock"));
  for (const ref of Object.keys(journal.expectedNew.reservedLocks ?? {})) out.add(path.join(journal.binding.commonDirReal, `${ref}.lock`));
  return [...out];
}

/** Retention is one-directional: this journal is the only authority that can
 * attribute and release the locks it names, so anything short of proven absence
 * keeps it. A discarded journal turns its surviving lock into a permanently
 * stale-unattributed lock that needs `rbox doctor` and a human. */
async function journalLocksRemain(journal: CheckoutJournal | undefined): Promise<boolean> {
  if (!journal) return false;
  for (const abs of activeJournalLockPaths(journal)) if ((await probeLock(abs)).kind !== "absent") return true;
  try {
    const origHeadLock = await readRegularFileNoFollow(path.join(journal.binding.gitDirReal, "ORIG_HEAD.lock"));
    if (origHeadLock?.bytes.equals(Buffer.from(journal.journalId))) return true;
  } catch {
    // readRegularFileNoFollow reports only ENOENT as absence and throws on
    // everything else. An unreadable or non-regular ORIG_HEAD.lock is the same
    // indeterminate state as above, and must not escape as a rejection from a
    // caller that is already handling a deferral.
    return true;
  }
  return false;
}

async function acquireOrigHeadLock(ctx: RepoCtx, journalId: string): Promise<OwnedGitLock> {
  const lockPath = path.join(ctx.gitDir, "ORIG_HEAD.lock");
  const tmp = path.join(ctx.gitDir, `ORIG_HEAD.lock.tmp-${crypto.randomBytes(8).toString("hex")}`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(journalId);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.link(tmp, lockPath);
    await fsyncDirectory(ctx.gitDir);
    // The link above succeeded, so absence and unreadability are both anomalies.
    // Neither may hand back a lock we cannot later prove we still own.
    const probe = await probeLock(lockPath);
    if (probe.kind !== "present") throw new Error(`could not identify owned ORIG_HEAD.lock: ${probe.kind}`);
    return probe.token;
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

async function releaseOrigHeadLock(ctx: RepoCtx, journalId: string, token: OwnedGitLock | undefined): Promise<void> {
  if (!token) return;
  const live = await readRegularFileNoFollow(token.path);
  if (!live || live.token.dev !== token.dev || live.token.ino !== token.ino || !live.bytes.equals(Buffer.from(journalId))) {
    throw new Error("ORIG_HEAD.lock ownership changed before release");
  }
  await fs.rm(token.path, { force: true });
  await fsyncDirectory(ctx.gitDir);
}

async function origHeadEquals(ctx: RepoCtx, expected: Uint8Array | null): Promise<boolean> {
  const live = await readRegularFileNoFollow(path.join(ctx.gitDir, "ORIG_HEAD"));
  if (live === undefined || expected === null) return live === undefined && expected === null;
  return live.bytes.equals(Buffer.from(expected));
}

async function restoreOpStateWithCrash(ctx: RepoCtx, desired: Array<{ rel: string; tmp: string }>, crashAt?: CommitCheckoutOptions["crashAt"]): Promise<void> {
  const want = new Set(desired.map((entry) => entry.rel));
  for (const rel of Object.keys(await readOpState(ctx.gitDir, async () => ""))) {
    if (!want.has(rel)) {
      await fs.rm(path.join(ctx.gitDir, rel), { force: true });
      crashAt?.("mid-op-state");
    }
  }
  for (const { rel, tmp } of desired) {
    const dest = path.join(ctx.gitDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await moveFileAtomic(tmp, dest);
    crashAt?.("mid-op-state");
  }
  await pruneEmptyOpStateDirs(ctx.gitDir, want);
}

/** The pinned 10-step checkout commit from design 116 (r1 F3/r2 F4/r3 F6). */
export async function commitCheckout<T = unknown>(ctx: RepoCtx, plan: CheckoutPlan, opts: CommitCheckoutOptions<T>): Promise<CommitCheckoutResult> {
  const persistJournal = (): Promise<void> => opts.journal
    ? addTimedMs(opts.chainTimings, "journalMs", () =>
        updateCheckoutJournal(opts.journal!.workspaceRoot, opts.journal!.relPath, opts.journal!.value))
    : Promise.resolve();
  if (!(opts.capabilitySupported ?? await checkoutTransactionSupported(ctx.repoDir, opts.capabilityProbe))) return { status: "unsupported", reason: "git lacks prepared transactional symref-update" };

  if ((plan.candidateIndexPath === undefined) === (plan.removeIndex !== true)) {
    return { status: "defer", reason: "checkout plan must publish index bytes or explicit index absence" };
  }
  if ((plan.refReservations?.length ?? 0) > 0 && !opts.journal) {
    return { status: "defer", reason: "checkout ref reservations require a durable intent journal" };
  }

  const staged = path.join(ctx.gitDir, `.rbox-candidate-index-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  let tx: RefTransaction | undefined;
  let postHeadTx: RefTransaction | undefined;
  let indexHandle: fs.FileHandle | undefined;
  let indexToken: OwnedGitLock | undefined;
  let indexObservation: MarkerObservation | undefined;
  let headHandle: fs.FileHandle | undefined;
  let headToken: OwnedGitLock | undefined;
  let headObservation: MarkerObservation | undefined;
  let origHeadToken: OwnedGitLock | undefined;
  let origHeadCleanupDurabilityPending = false;
  let reservationCleanupDurabilityPending = false;
  let checkoutLockCleanupDurabilityPending = false;
  /** Single source of the deferral verdict: any pending cleanup durability or
   * any not-provably-gone journal lock keeps the journal for intent recovery. */
  const deferWith = async (reason: string): Promise<CommitCheckoutResult> =>
    origHeadCleanupDurabilityPending || reservationCleanupDurabilityPending || checkoutLockCleanupDurabilityPending
      || await journalLocksRemain(opts.journal?.value)
      ? { status: "defer", reason, journalIntact: true }
      : { status: "defer", reason };
  const reservationTokens: OwnedGitLock[] = [];
  const reservationObservations = new Map<string, MarkerObservation>();
  const releaseReservations = async (): Promise<void> => {
    if (reservationTokens.length === 0) return;
    reservationCleanupDurabilityPending = true;
    let exact = true;
    for (const token of [...reservationTokens].reverse()) {
      const observation = reservationObservations.get(token.path);
      if (!observation) {
        exact = false;
        continue;
      }
      const released = await addTimedMs(opts.chainTimings, "journalMs", () => releaseObservedLock(token.path, observation));
      if (!released.released || !released.durable) exact = false;
    }
    if (!exact) throw new Error("checkout reservation exact release was not durable");
    reservationTokens.length = 0;
    reservationObservations.clear();
    reservationCleanupDurabilityPending = false;
  };
  let refsCommitted = false;
  let mutationLease: MutationLease | undefined;
  const indexLock = path.join(ctx.gitDir, "index.lock");
  const releaseExactCheckoutLock = async (lockPath: string, observation: MarkerObservation | undefined): Promise<void> => {
    if (!observation) throw new Error(`checkout lock lacks exact release observation: ${lockPath}`);
    checkoutLockCleanupDurabilityPending = true;
    const released = await addTimedMs(opts.chainTimings, "journalMs", () => releaseObservedLock(lockPath, observation));
    if (!released.released || !released.durable) throw new Error(`checkout lock exact release failed: ${lockPath}`);
    checkoutLockCleanupDurabilityPending = false;
  };
  const releasePlannedOrigHeadLock = async (): Promise<void> => {
    if (!origHeadToken) return;
    // Stays true if unlink or its directory fsync fails. The caller must retain
    // journal.id even when the path currently appears absent: power loss could
    // resurrect an unlink whose directory update was not durable.
    origHeadCleanupDurabilityPending = true;
    await addTimedMs(opts.chainTimings, "journalMs", () => releaseOrigHeadLock(ctx, plan.origHeadLock?.journalId ?? "", origHeadToken!));
    origHeadToken = undefined;
    origHeadCleanupDurabilityPending = false;
  };
  try {
    let candidate: Buffer | undefined;
    let indexHash: string | undefined;
    if (plan.candidateIndexPath) await addTimedMs(opts.chainTimings, "indexOpStateMs", async () => {
      await fs.copyFile(plan.candidateIndexPath!, staged);
      await clearIndexResolveUndo(ctx.repoDir, staged); // private GIT_INDEX_FILE, never live index.
      candidate = await fs.readFile(staged);
      indexHash = hashBytes(candidate);
    });
    if (opts.journal) {
      opts.journal.value.expectedNew.indexHash = indexHash;
      await persistJournal();
    }

    const connected = await addTimedMs(opts.chainTimings, "connectivityProofMs", () => opts.connectivityProof
      ? opts.connectivityProof(ctx.repoDir, plan.plannedGraphRoots)
      : defaultConnectivityProof(ctx.repoDir, plan.plannedGraphRoots, plan.malformedOrigHeadPreserved === true));
    if (!connected) return { status: "defer", reason: "planned graph connectivity proof failed" };
    try { opts.crashAt?.("after-connectivity-proof"); } catch (error) { throw new InjectedCheckoutCrash(error); }

    const locksBeforePrepare = new Map<string, string>();
    for (const abs of await allGitLocks(ctx)) {
      const probe = await probeLock(abs);
      // Membership alone decides ownership below. Record an indeterminate path
      // as pre-existing so a lock we could not prove absent before prepare is
      // never later claimed as one this sequence created.
      if (probe.kind === "present") locksBeforePrepare.set(probe.token.path, `${probe.token.dev}:${probe.token.ino}`);
      else if (probe.kind === "indeterminate") locksBeforePrepare.set(path.resolve(abs), "indeterminate");
    }

    const primaryLines = transactionLines(plan);
    mutationLease = opts.mutationBoundary?.enter({ phase: "git-prepare", repository: ctx.repoDir });
    tx = new RefTransaction(ctx.repoDir, plan.reflogMessage);
    let primaryIntent!: JournalPreparedTransaction;
    await addTimedMs(opts.chainTimings, "refTxnExclusiveMs", async () => {
      await tx!.start();
      await tx!.write("option no-deref");
      for (const line of primaryLines) await tx!.write(line);
      primaryIntent = await preparedTransactionIntent(ctx, "primary", await tx!.processId(), primaryLines, plan.head.kind === "symbolic", opts.identity);
    });
    if (opts.journal) {
      opts.journal.value.expectedNew.preparedTransactions = [
        ...(opts.journal.value.expectedNew.preparedTransactions ?? []).filter((entry) => entry.id !== "primary"),
        primaryIntent,
      ];
      await persistJournal();
    }
    // This is the first operation that can make native Git lockfiles visible.
    // Check after every setup/journal await so a closed gate never reaches it.
    if (mutationLease?.abortRequested) throw new MutationGateClosedError();
    await addTimedMs(opts.chainTimings, "refTxnExclusiveMs", () => tx!.prepare());
    const postHeadLines = refUpdateLines(plan.postHeadRefUpdates ?? [], plan.postHeadExtraTransactionLines);
    await opts.afterPrepareChild?.(await tx.processId(), "primary");
    await addTimedMs(opts.chainTimings, "journalMs", () => observePreparedLockTokens(primaryIntent));
    if (opts.journal) {
      await persistJournal();
    }
    try { opts.crashAt?.("after-prepare"); } catch (error) { throw new InjectedCheckoutCrash(error); }
    // A prepared native transaction is still reversible. Cooperate with a
    // shutdown immediately, before acquiring manual ref/index reservations or
    // performing the second proof.
    if (mutationLease?.abortRequested) throw new MutationGateClosedError();

    const reservationMarkers = new Map<string, string>();
    const reservationPaths = new Map<string, string>();
    if ((plan.refReservations?.length ?? 0) > 0) {
      const commonReal = await fs.realpath(ctx.commonDir);
      const owner = await systemLockIdentity.current();
      for (const reservation of plan.refReservations ?? []) {
        if (!safeReservationRef(reservation.ref)) throw new Error(`unsafe checkout ref reservation: ${reservation.ref}`);
        const lockPath = path.resolve(commonReal, `${reservation.ref}.lock`);
        if (!lockPath.startsWith(`${commonReal}${path.sep}`)) throw new Error(`checkout ref reservation escaped common dir: ${reservation.ref}`);
        reservationPaths.set(reservation.ref, lockPath);
        reservationMarkers.set(reservation.ref, formatLockMarker({ ...owner, token: crypto.randomBytes(16).toString("hex") }));
      }
      if (opts.journal) {
        opts.journal.value.expectedNew.reservedLocks = Object.fromEntries((plan.refReservations ?? []).map((reservation) => [reservation.ref, {
          marker: reservationMarkers.get(reservation.ref)!,
        }]));
        await persistJournal();
      }
    }
    for (const reservation of plan.refReservations ?? []) {
      const lockPath = reservationPaths.get(reservation.ref)!;
      await safeBoundLockParent(await fs.realpath(ctx.commonDir), lockPath, { create: true });
      if (mutationLease?.abortRequested) throw new MutationGateClosedError();
      const published = await addTimedMs(opts.chainTimings, "journalMs", () => publishLockMarker(lockPath, reservationMarkers.get(reservation.ref)!));
      if (published.status !== "created") throw new Error(`could not reserve ${reservation.ref}.lock`);
      const token = { path: lockPath, dev: Number(published.observation.dev), ino: Number(published.observation.inode) };
      reservationTokens.push(token);
      reservationObservations.set(lockPath, published.observation);
      if (opts.journal) {
        opts.journal.value.expectedNew.reservedLocks![reservation.ref] = {
          marker: reservationMarkers.get(reservation.ref)!,
          observation: serializeMarkerObservation(published.observation),
        };
        await persistJournal();
      }
      const oid = await git(ctx.repoDir, ["rev-parse", "--verify", "--quiet", reservation.ref]).catch(() => "");
      if ((oid || null) !== reservation.expectedOid) throw new Error(`reserved ref changed: ${reservation.ref}`);
    }
    if (plan.origHeadLock) {
      if (!opts.journal || opts.journal.value.journalId !== plan.origHeadLock.journalId) throw new Error("ORIG_HEAD lock plan lacks matching journal ownership");
      origHeadToken = await addTimedMs(opts.chainTimings, "journalMs", () => acquireOrigHeadLock(ctx, plan.origHeadLock!.journalId));
    }

    if (plan.head.kind === "symbolic" && plan.head.newTarget === plan.head.oldTarget) {
      // Git forbids putting HEAD and its unchanged referent in one transaction.
      // Updating the checked-out referent nevertheless makes update-ref prepare
      // HEAD.lock; verify the symbolic bytes under that transaction-owned lock.
      // Only a proven-present reservation authorizes reading HEAD under it.
      if ((await probeLock(path.join(ctx.gitDir, "HEAD.lock"))).kind !== "present") throw new Error("prepared transaction did not reserve unchanged symbolic HEAD");
      const head = (await fs.readFile(path.join(ctx.gitDir, "HEAD"), "utf8")).trim();
      if (head !== `ref: ${plan.head.oldTarget}`) throw new Error("symbolic HEAD changed before checkout commit");
    }

    // O_EXCL is the writer reservation held across the ref commit (r3 F6).
    if (opts.journal) {
      opts.journal.value.expectedNew.indexLock = { acquireStarted: false };
      await persistJournal();
    }
    if (mutationLease?.abortRequested) throw new MutationGateClosedError();
    indexHandle = await fs.open(indexLock, "wx");
    // O_EXCL just created it; absence or unreadability are both anomalies that
    // must not yield an unverifiable writer reservation.
    const indexProbe = await probeLock(indexLock);
    if (indexProbe.kind !== "present") throw new Error(`could not identify owned index.lock: ${indexProbe.kind}`);
    indexToken = indexProbe.token;
    indexObservation = await addTimedMs(opts.chainTimings, "journalMs", () => observeLockMarker(indexLock));
    if (!indexObservation) throw new Error("could not observe owned index.lock");
    if (opts.journal) {
      opts.journal.value.expectedNew.indexLock = {
        acquireStarted: true,
        observation: serializeMarkerObservation(indexObservation),
      };
      await persistJournal();
    }
    try { opts.crashAt?.("after-index-lock"); } catch (error) { throw new InjectedCheckoutCrash(error); }

    const owned: OwnedGitLock[] = [
      indexToken,
      ...(origHeadToken ? [origHeadToken] : []),
      ...reservationTokens,
      ...primaryIntent.locks.flatMap((lock) => lock.token ? [{ path: lock.path, ...lock.token }] : []),
    ];
    const expectedLocks = new Set(primaryIntent.locks.map((lock) => lock.path));
    for (const abs of await allGitLocks(ctx)) {
      if (!expectedLocks.has(abs) || abs === indexToken.path) continue;
      // Claim ownership only on proof. An indeterminate probe stays unclaimed
      // and therefore reads as a foreign lock in the busy probe below.
      const probe = await probeLock(abs);
      if (probe.kind === "present" && !locksBeforePrepare.has(probe.token.path)) owned.push(probe.token);
    }
    const proofContext: SecondProofContext = { ownedLocks: owned, busy: () => ownershipAwareGitBusy(ctx, owned) };
    const becameBusy = await proofContext.busy();
    const breadcrumbChanged = plan.origHeadLock ? !(await origHeadEquals(ctx, plan.origHeadLock.expectedOldBytes)) : false;
    const secondProofPassed = !becameBusy && !breadcrumbChanged && await opts.secondProof(proofContext);
    if (becameBusy || breadcrumbChanged || !secondProofPassed) {
      await addTimedMs(opts.chainTimings, "refTxnExclusiveMs", () => tx!.abort());
      tx = undefined;
      await postHeadTx?.abort();
      postHeadTx = undefined;
      await indexHandle.close();
      indexHandle = undefined;
      await releaseExactCheckoutLock(indexLock, indexObservation);
      indexObservation = undefined;
      indexToken = undefined;
      await releaseReservations();
      await releasePlannedOrigHeadLock();
      return await deferWith(becameBusy ? "git became busy at checkout boundary"
        : breadcrumbChanged ? ORIG_HEAD_CHANGED_AT_CHECKOUT_BOUNDARY
        : "checkout boundary proof changed");
    }

    const branchSwitchTarget = plan.head.kind === "symbolic" && plan.head.newTarget !== plan.head.oldTarget ? plan.head.newTarget : undefined;
    const branchSwitch = branchSwitchTarget !== undefined;
    if (branchSwitch && opts.journal) {
      opts.journal.value.expectedNew.headLock = {
        path: path.resolve(ctx.gitDir, "HEAD.lock"),
        acquireStarted: false,
        expectedBytes: [Buffer.alloc(0).toString("base64")],
      };
      await persistJournal();
    }
    if (mutationLease && !mutationLease.beginCommit("git-commit")) throw new MutationGateClosedError();
    await addTimedMs(opts.chainTimings, "refTxnExclusiveMs", () => tx!.commit());
    tx = undefined;
    refsCommitted = true;
    try { opts.crashAt?.("after-head-commit"); } catch (error) { throw new InjectedCheckoutCrash(error); }
    if (branchSwitch) {
      const headLockPath = path.join(ctx.gitDir, "HEAD.lock");
      headHandle = await fs.open(headLockPath, "wx");
      // As with index.lock: O_EXCL created it, so only proven presence may
      // stand in as the reservation token released after publication.
      const headProbe = await probeLock(headLockPath);
      if (headProbe.kind !== "present") throw new Error(`could not identify owned HEAD.lock reservation: ${headProbe.kind}`);
      headToken = headProbe.token;
      headObservation = await addTimedMs(opts.chainTimings, "journalMs", () => observeLockMarker(headLockPath));
      if (!headObservation) throw new Error("could not observe owned HEAD.lock reservation");
      if (opts.journal?.value.expectedNew.headLock) {
        opts.journal.value.expectedNew.headLock.acquireStarted = true;
        opts.journal.value.expectedNew.headLock.observation = serializeMarkerObservation(headObservation);
        const primary = opts.journal.value.expectedNew.preparedTransactions?.find((entry) => entry.id === "primary");
        if (primary) primary.completed = true;
        await persistJournal();
      }
      const head = await fs.readFile(path.join(ctx.gitDir, "HEAD"), "utf8");
      if (head !== `ref: ${branchSwitchTarget}\n`) throw new JournalArbitrationDefer("symbolic HEAD changed after branch-switch commit");
    } else if (opts.journal) {
      const primary = opts.journal.value.expectedNew.preparedTransactions?.find((entry) => entry.id === "primary");
      if (primary) primary.completed = true;
      await persistJournal();
    }
    if (postHeadLines.length) {
      // Git cannot prepare an update of HEAD's old referent while HEAD.lock is
      // held by the symref transaction. Keep this second expected-old commit
      // inside checkout-txn and under the same intent journal/index reservation.
      postHeadTx = new RefTransaction(ctx.repoDir, plan.postHeadReflogMessage);
      await addTimedMs(opts.chainTimings, "refTxnExclusiveMs", async () => {
        await postHeadTx!.start();
        await postHeadTx!.write("option no-deref");
        for (const line of postHeadLines) await postHeadTx!.write(line);
      });
      if (opts.journal) {
        const intent = await preparedTransactionIntent(ctx, "post-head", await postHeadTx.processId(), postHeadLines, false, opts.identity);
        opts.journal.value.expectedNew.preparedTransactions = [
          ...(opts.journal.value.expectedNew.preparedTransactions ?? []).filter((entry) => entry.id !== "post-head"),
          intent,
        ];
        await persistJournal();
      }
      await addTimedMs(opts.chainTimings, "refTxnExclusiveMs", () => postHeadTx!.prepare());
      await opts.afterPrepareChild?.(await postHeadTx.processId(), "post-head");
      if (opts.journal) {
        const intent = opts.journal.value.expectedNew.preparedTransactions?.find((entry) => entry.id === "post-head");
        if (intent) await addTimedMs(opts.chainTimings, "journalMs", () => observePreparedLockTokens(intent));
        await persistJournal();
      }
      if (opts.postHeadSecondProof && !(await opts.postHeadSecondProof())) {
        await addTimedMs(opts.chainTimings, "refTxnExclusiveMs", () => postHeadTx!.abort());
        postHeadTx = undefined;
        throw new JournalArbitrationDefer("post-HEAD branch proof changed");
      }
      await addTimedMs(opts.chainTimings, "refTxnExclusiveMs", () => postHeadTx!.commit());
      postHeadTx = undefined;
      if (opts.journal) {
        const intent = opts.journal.value.expectedNew.preparedTransactions?.find((entry) => entry.id === "post-head");
        if (intent) intent.completed = true;
        await persistJournal();
      }
    }
    try { opts.crashAt?.("after-ref-commit"); } catch (error) { throw new InjectedCheckoutCrash(error); }
    try { opts.crashAt?.("before-index-publish"); } catch (error) { throw new InjectedCheckoutCrash(error); }
    await addTimedMs(opts.chainTimings, "indexOpStateMs", async () => {
      if (candidate) {
        await indexHandle!.writeFile(candidate);
        await indexHandle!.sync();
      }
      await indexHandle!.close();
      indexHandle = undefined;
      if (candidate) {
        const live = await observeLockMarker(indexLock);
        if (!live) throw new Error("index.lock disappeared before publication");
        indexObservation = live;
        if (opts.journal?.value.expectedNew.indexLock) {
          opts.journal.value.expectedNew.indexLock = {
            acquireStarted: true,
            observation: serializeMarkerObservation(live),
          };
          await persistJournal();
        }
        const verified = await observeLockMarker(indexLock);
        if (!verified || !sameMarkerObservation(verified, live)) throw new Error("index.lock ownership changed before publication");
        await fs.rename(indexLock, path.join(ctx.gitDir, "index"));
        await fsyncDirectory(ctx.gitDir);
        indexObservation = undefined;
        indexToken = undefined;
      }
      else {
        await fs.rm(path.join(ctx.gitDir, "index"), { force: true });
        await releaseExactCheckoutLock(indexLock, indexObservation);
        indexObservation = undefined;
        indexToken = undefined;
      }
    });
    try { opts.crashAt?.("after-index-publish"); } catch (error) { throw new InjectedCheckoutCrash(error); }
    await addTimedMs(opts.chainTimings, "indexOpStateMs", () => restoreOpStateWithCrash(ctx, plan.opState, opts.crashAt));
    await releasePlannedOrigHeadLock();
    await headHandle?.close();
    headHandle = undefined;
    if (headToken) await releaseExactCheckoutLock(headToken.path, headObservation);
    headToken = undefined;
    headObservation = undefined;
    await releaseReservations();
    return { status: "committed" };
  } catch (error) {
    if (!refsCommitted) {
      await tx?.abort().catch(() => {});
      await postHeadTx?.abort().catch(() => {});
      await indexHandle?.close().catch(() => {});
      if (indexToken) await releaseExactCheckoutLock(indexLock, indexObservation).catch(() => {});
      indexToken = undefined;
      indexObservation = undefined;
      await headHandle?.close().catch(() => {});
      if (headToken) await releaseExactCheckoutLock(headToken.path, headObservation).catch(() => {});
      headToken = undefined;
      headObservation = undefined;
      await releaseReservations().catch(() => {});
      await releasePlannedOrigHeadLock().catch(() => {});
      if (error instanceof InjectedCheckoutCrash) throw error.cause;
      return await deferWith(error instanceof Error ? error.message : "checkout transaction failed");
    }
    // After ref commit, never call unconditional restoreLocal (r2 F4). The
    // durable journal's old/new arbitration is the only repair authority.
    await indexHandle?.close().catch(() => {});
    await postHeadTx?.abort().catch(() => {});
    if (indexToken) await releaseExactCheckoutLock(indexLock, indexObservation).catch(() => {});
    indexToken = undefined;
    indexObservation = undefined;
    await headHandle?.close().catch(() => {});
    if (headToken) await releaseExactCheckoutLock(headToken.path, headObservation).catch(() => {});
    headToken = undefined;
    headObservation = undefined;
    await releaseReservations().catch(() => {});
    // After ref commit, an incomplete staged op-state publication keeps the
    // pseudo-ref fence for journal recovery. Successful publication already
    // released it immediately above.
    if (error instanceof InjectedCheckoutCrash) throw error.cause;
    if (error instanceof JournalArbitrationDefer) return { status: "defer", reason: error.message, journalIntact: true };
    throw error;
  } finally {
    mutationLease?.finish();
    await fs.rm(staged, { force: true }).catch(() => {});
  }
}

class InjectedCheckoutCrash extends Error {
  constructor(readonly cause: unknown) { super("injected checkout crash"); }
}

class JournalArbitrationDefer extends Error {}
