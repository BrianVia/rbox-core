import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { hashBytes } from "../hash.js";
import { clearIndexResolveUndo, moveFileAtomic, walkFiles, type RepoCtx } from "./shared.js";
import { readOpState, pruneEmptyOpStateDirs } from "./refs.js";
import { updateCheckoutJournal, type CheckoutJournal } from "./journal.js";

const exec = promisify(execFile);
const ZERO_OID = "0".repeat(40);

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
  head: CheckoutHeadUpdate;
  /** create-only recovery-pin lines already provenance-persisted by keep-pins. */
  extraTransactionLines?: string[];
  plannedGraphRoots: string[];
  opState: Array<{ rel: string; tmp: string }>;
  /** Refs read by HEAD but not mutated in this transaction. Their ordinary
   * ref lock is held across the boundary proof and commit. */
  refReservations?: Array<{ ref: string; expectedOid: string }>;
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
  connectivityProof?: (repoDir: string, roots: readonly string[]) => Promise<boolean>;
  secondProof: (context: SecondProofContext) => Promise<boolean>;
  journal?: { workspaceRoot: string; relPath: string; value: CheckoutJournal<TIntended> };
  crashAt?: (point: "after-connectivity-proof" | "after-prepare" | "after-index-lock" | "after-head-commit" | "after-ref-commit" | "before-index-publish" | "after-index-publish" | "mid-op-state") => void;
  /** Test seam for the real failure mode where Git dies after prepare: ok. */
  afterPrepareChild?: (pid: number, transaction: "primary" | "post-head") => void | Promise<void>;
  capabilityProbe?: CheckoutCapabilityProbe;
  /** Caller already ran the exact capability probe for this transaction. */
  capabilitySupported?: boolean;
}

export type CommitCheckoutResult =
  | { status: "committed"; indexHash?: string }
  | { status: "defer"; reason: string; journalIntact?: true }
  | { status: "unsupported"; reason: string };

export type CheckoutCapabilityProbe = (gitVersion: string) => Promise<boolean>;
const capabilityCache = new Map<string, boolean>();
let injectedCapabilityProbe: CheckoutCapabilityProbe | undefined;

export function setCheckoutCapabilityProbeForTests(probe: CheckoutCapabilityProbe | undefined): void {
  injectedCapabilityProbe = probe;
}

export function resetCheckoutCapabilityProbeCacheForTests(): void {
  capabilityCache.clear();
  injectedCapabilityProbe = undefined;
}

function cleanGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    ...extra,
  } as NodeJS.ProcessEnv;
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

  constructor(repoDir: string) {
    this.ready = this.initialize(repoDir);
  }

  private async initialize(repoDir: string): Promise<void> {
    // Bun 1.3's node:child_process buffers a pipe-backed stdin until end(),
    // which cannot drive start/prepare/commit interactively. A private FIFO is
    // still an ordinary kernel pipe to Git, but fs.write reaches it immediately.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-update-ref-"));
    const fifo = path.join(dir, "stdin");
    this.controlDir = dir;
    this.stdoutPath = path.join(dir, "stdout");
    this.stderrPath = path.join(dir, "stderr");
    await exec("mkfifo", [fifo]);
    this.child = spawn("sh", ["-c", 'exec git -C "$1" update-ref --stdin <"$2" >"$3" 2>"$4"', "rbox-update-ref", repoDir, fifo, this.stdoutPath, this.stderrPath], {
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
    await tx.start();
    await tx.write("option no-deref");
    await tx.write("symref-update HEAD refs/heads/probe ref refs/heads/main");
    await tx.prepare();
    await tx.commit();
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function checkoutTransactionSupported(repoDir: string, probe?: CheckoutCapabilityProbe): Promise<boolean> {
  const { stdout } = await exec("git", ["--version"], { env: cleanGitEnv() });
  const version = stdout.toString().trim();
  const cached = capabilityCache.get(version);
  if (cached !== undefined) return cached;
  const supported = await (probe ?? injectedCapabilityProbe ?? (async () => defaultCapabilityProbe()))(version);
  capabilityCache.set(version, supported);
  return supported;
}

async function defaultConnectivityProof(repoDir: string, roots: readonly string[]): Promise<boolean> {
  if (roots.length === 0) return true;
  try {
    await exec("git", ["-C", repoDir, "rev-list", "--quiet", ...roots, "--"], { env: cleanGitEnv({ GIT_NO_LAZY_FETCH: "1" }), maxBuffer: 16 * 1024 * 1024 });
    // fsck is deliberately pre-commit (r2 F4); there is no post-commit broad
    // rollback that could clobber a human commit.
    await exec("git", ["-C", repoDir, "fsck", "--connectivity-only", "--no-dangling", ...roots], { env: cleanGitEnv({ GIT_NO_LAZY_FETCH: "1" }), maxBuffer: 16 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function lockToken(abs: string): Promise<OwnedGitLock | undefined> {
  try {
    const st = await fs.lstat(abs);
    return { path: path.resolve(abs), dev: st.dev, ino: st.ino };
  } catch {
    return undefined;
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
    const token = await lockToken(abs);
    if (!token || allow.get(token.path) !== `${token.dev}:${token.ino}`) return true;
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
): Promise<JournalPreparedTransaction> {
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
    prepareStarted: true,
    locks: [...byPath].map(([lockPath, expectedBytes]) => ({ path: lockPath, expectedBytes: [...expectedBytes] })),
  };
}

async function observePreparedLockTokens(transaction: JournalPreparedTransaction): Promise<void> {
  for (const lock of transaction.locks) {
    const token = await lockToken(lock.path);
    if (token) lock.token = { dev: token.dev, ino: token.ino };
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

async function journalLocksRemain(journal: CheckoutJournal | undefined): Promise<boolean> {
  if (!journal) return false;
  for (const abs of activeJournalLockPaths(journal)) if (await lockToken(abs)) return true;
  return false;
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
  if (!(opts.capabilitySupported ?? await checkoutTransactionSupported(ctx.repoDir, opts.capabilityProbe))) return { status: "unsupported", reason: "git lacks prepared transactional symref-update" };

  if ((plan.candidateIndexPath === undefined) === (plan.removeIndex !== true)) {
    return { status: "defer", reason: "checkout plan must publish index bytes or explicit index absence" };
  }

  const staged = path.join(ctx.gitDir, `.rbox-candidate-index-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  let tx: RefTransaction | undefined;
  let postHeadTx: RefTransaction | undefined;
  let indexHandle: fs.FileHandle | undefined;
  let indexToken: OwnedGitLock | undefined;
  let headHandle: fs.FileHandle | undefined;
  let headToken: OwnedGitLock | undefined;
  const reservationHandles: fs.FileHandle[] = [];
  const reservationTokens: OwnedGitLock[] = [];
  let refsCommitted = false;
  const indexLock = path.join(ctx.gitDir, "index.lock");
  try {
    let candidate: Buffer | undefined;
    let indexHash: string | undefined;
    if (plan.candidateIndexPath) {
      await fs.copyFile(plan.candidateIndexPath, staged);
      await clearIndexResolveUndo(ctx.repoDir, staged); // private GIT_INDEX_FILE, never live index.
      candidate = await fs.readFile(staged);
      indexHash = hashBytes(candidate);
    }
    if (opts.journal) {
      opts.journal.value.expectedNew.indexHash = indexHash;
      await updateCheckoutJournal(opts.journal.workspaceRoot, opts.journal.relPath, opts.journal.value);
    }

    if (!(await (opts.connectivityProof ?? defaultConnectivityProof)(ctx.repoDir, plan.plannedGraphRoots))) return { status: "defer", reason: "planned graph connectivity proof failed" };
    try { opts.crashAt?.("after-connectivity-proof"); } catch (error) { throw new InjectedCheckoutCrash(error); }

    const locksBeforePrepare = new Map<string, string>();
    for (const abs of await allGitLocks(ctx)) {
      const token = await lockToken(abs);
      if (token) locksBeforePrepare.set(token.path, `${token.dev}:${token.ino}`);
    }

    const primaryLines = transactionLines(plan);
    tx = new RefTransaction(ctx.repoDir);
    await tx.start();
    await tx.write("option no-deref");
    for (const line of primaryLines) await tx.write(line);
    const primaryIntent = await preparedTransactionIntent(ctx, "primary", await tx.processId(), primaryLines, plan.head.kind === "symbolic");
    if (opts.journal) {
      opts.journal.value.expectedNew.preparedTransactions = [
        ...(opts.journal.value.expectedNew.preparedTransactions ?? []).filter((entry) => entry.id !== "primary"),
        primaryIntent,
      ];
      await updateCheckoutJournal(opts.journal.workspaceRoot, opts.journal.relPath, opts.journal.value);
    }
    await tx.prepare();
    const postHeadLines = refUpdateLines(plan.postHeadRefUpdates ?? [], plan.postHeadExtraTransactionLines);
    await opts.afterPrepareChild?.(await tx.processId(), "primary");
    await observePreparedLockTokens(primaryIntent);
    if (opts.journal) {
      await updateCheckoutJournal(opts.journal.workspaceRoot, opts.journal.relPath, opts.journal.value);
    }
    try { opts.crashAt?.("after-prepare"); } catch (error) { throw new InjectedCheckoutCrash(error); }

    for (const reservation of plan.refReservations ?? []) {
      const lockPath = path.join(ctx.commonDir, `${reservation.ref}.lock`);
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      const handle = await fs.open(lockPath, "wx");
      reservationHandles.push(handle);
      const token = await lockToken(lockPath);
      if (!token) throw new Error(`could not identify owned ${reservation.ref}.lock`);
      reservationTokens.push(token);
      const { stdout } = await exec("git", ["-C", ctx.repoDir, "rev-parse", "--verify", reservation.ref], { env: cleanGitEnv() });
      if (stdout.toString().trim() !== reservation.expectedOid) throw new Error(`reserved ref changed: ${reservation.ref}`);
    }
    if (opts.journal && reservationTokens.length) {
      opts.journal.value.expectedNew.reservedLocks = Object.fromEntries((plan.refReservations ?? []).map((reservation, i) => [reservation.ref, {
        dev: reservationTokens[i]!.dev,
        ino: reservationTokens[i]!.ino,
      }]));
      await updateCheckoutJournal(opts.journal.workspaceRoot, opts.journal.relPath, opts.journal.value);
    }

    if (plan.head.kind === "symbolic" && plan.head.newTarget === plan.head.oldTarget) {
      // Git forbids putting HEAD and its unchanged referent in one transaction.
      // Updating the checked-out referent nevertheless makes update-ref prepare
      // HEAD.lock; verify the symbolic bytes under that transaction-owned lock.
      if (!(await lockToken(path.join(ctx.gitDir, "HEAD.lock")))) throw new Error("prepared transaction did not reserve unchanged symbolic HEAD");
      const head = (await fs.readFile(path.join(ctx.gitDir, "HEAD"), "utf8")).trim();
      if (head !== `ref: ${plan.head.oldTarget}`) throw new Error("symbolic HEAD changed before checkout commit");
    }

    // O_EXCL is the writer reservation held across the ref commit (r3 F6).
    indexHandle = await fs.open(indexLock, "wx");
    indexToken = await lockToken(indexLock);
    if (!indexToken) throw new Error("could not identify owned index.lock");
    if (opts.journal) {
      opts.journal.value.expectedNew.indexLock = { dev: indexToken.dev, ino: indexToken.ino };
      await updateCheckoutJournal(opts.journal.workspaceRoot, opts.journal.relPath, opts.journal.value);
    }
    try { opts.crashAt?.("after-index-lock"); } catch (error) { throw new InjectedCheckoutCrash(error); }

    const owned: OwnedGitLock[] = [
      indexToken,
      ...reservationTokens,
      ...primaryIntent.locks.flatMap((lock) => lock.token ? [{ path: lock.path, ...lock.token }] : []),
    ];
    const expectedLocks = new Set(primaryIntent.locks.map((lock) => lock.path));
    for (const abs of await allGitLocks(ctx)) {
      if (!expectedLocks.has(abs) || abs === indexToken.path) continue;
      const token = await lockToken(abs);
      if (token && !locksBeforePrepare.has(token.path)) owned.push(token);
    }
    const proofContext: SecondProofContext = { ownedLocks: owned, busy: () => ownershipAwareGitBusy(ctx, owned) };
    const becameBusy = await proofContext.busy();
    const secondProofPassed = !becameBusy && await opts.secondProof(proofContext);
    if (becameBusy || !secondProofPassed) {
      await tx.abort();
      tx = undefined;
      await postHeadTx?.abort();
      postHeadTx = undefined;
      await indexHandle.close();
      indexHandle = undefined;
      await fs.rm(indexLock, { force: true });
      for (const handle of reservationHandles) await handle.close().catch(() => {});
      reservationHandles.length = 0;
      for (const token of reservationTokens) await fs.rm(token.path, { force: true }).catch(() => {});
      reservationTokens.length = 0;
      const reason = becameBusy ? "git became busy at checkout boundary" : "checkout boundary proof changed";
      return await journalLocksRemain(opts.journal?.value) ? { status: "defer", reason, journalIntact: true } : { status: "defer", reason };
    }

    const branchSwitchTarget = plan.head.kind === "symbolic" && plan.head.newTarget !== plan.head.oldTarget ? plan.head.newTarget : undefined;
    const branchSwitch = branchSwitchTarget !== undefined;
    if (branchSwitch && opts.journal) {
      opts.journal.value.expectedNew.headLock = {
        path: path.resolve(ctx.gitDir, "HEAD.lock"),
        acquireStarted: true,
        expectedBytes: [Buffer.alloc(0).toString("base64")],
      };
      await updateCheckoutJournal(opts.journal.workspaceRoot, opts.journal.relPath, opts.journal.value);
    }
    await tx.commit();
    tx = undefined;
    refsCommitted = true;
    try { opts.crashAt?.("after-head-commit"); } catch (error) { throw new InjectedCheckoutCrash(error); }
    if (branchSwitch) {
      const headLockPath = path.join(ctx.gitDir, "HEAD.lock");
      headHandle = await fs.open(headLockPath, "wx");
      headToken = await lockToken(headLockPath);
      if (!headToken) throw new Error("could not identify owned HEAD.lock reservation");
      if (opts.journal?.value.expectedNew.headLock) {
        opts.journal.value.expectedNew.headLock.token = { dev: headToken.dev, ino: headToken.ino };
        const primary = opts.journal.value.expectedNew.preparedTransactions?.find((entry) => entry.id === "primary");
        if (primary) primary.completed = true;
        await updateCheckoutJournal(opts.journal.workspaceRoot, opts.journal.relPath, opts.journal.value);
      }
      const head = await fs.readFile(path.join(ctx.gitDir, "HEAD"), "utf8");
      if (head !== `ref: ${branchSwitchTarget}\n`) throw new JournalArbitrationDefer("symbolic HEAD changed after branch-switch commit");
    } else if (opts.journal) {
      const primary = opts.journal.value.expectedNew.preparedTransactions?.find((entry) => entry.id === "primary");
      if (primary) primary.completed = true;
      await updateCheckoutJournal(opts.journal.workspaceRoot, opts.journal.relPath, opts.journal.value);
    }
    if (postHeadLines.length) {
      // Git cannot prepare an update of HEAD's old referent while HEAD.lock is
      // held by the symref transaction. Keep this second expected-old commit
      // inside checkout-txn and under the same intent journal/index reservation.
      postHeadTx = new RefTransaction(ctx.repoDir);
      await postHeadTx.start();
      await postHeadTx.write("option no-deref");
      for (const line of postHeadLines) await postHeadTx.write(line);
      if (opts.journal) {
        const intent = await preparedTransactionIntent(ctx, "post-head", await postHeadTx.processId(), postHeadLines, false);
        opts.journal.value.expectedNew.preparedTransactions = [
          ...(opts.journal.value.expectedNew.preparedTransactions ?? []).filter((entry) => entry.id !== "post-head"),
          intent,
        ];
        await updateCheckoutJournal(opts.journal.workspaceRoot, opts.journal.relPath, opts.journal.value);
      }
      await postHeadTx.prepare();
      await opts.afterPrepareChild?.(await postHeadTx.processId(), "post-head");
      if (opts.journal) {
        const intent = opts.journal.value.expectedNew.preparedTransactions?.find((entry) => entry.id === "post-head");
        if (intent) await observePreparedLockTokens(intent);
        await updateCheckoutJournal(opts.journal.workspaceRoot, opts.journal.relPath, opts.journal.value);
      }
      await postHeadTx.commit();
      postHeadTx = undefined;
      if (opts.journal) {
        const intent = opts.journal.value.expectedNew.preparedTransactions?.find((entry) => entry.id === "post-head");
        if (intent) intent.completed = true;
        await updateCheckoutJournal(opts.journal.workspaceRoot, opts.journal.relPath, opts.journal.value);
      }
    }
    try { opts.crashAt?.("after-ref-commit"); } catch (error) { throw new InjectedCheckoutCrash(error); }
    try { opts.crashAt?.("before-index-publish"); } catch (error) { throw new InjectedCheckoutCrash(error); }
    if (candidate) {
      await indexHandle.writeFile(candidate);
      await indexHandle.sync();
    }
    await indexHandle.close();
    indexHandle = undefined;
    if (candidate) await fs.rename(indexLock, path.join(ctx.gitDir, "index"));
    else {
      await fs.rm(path.join(ctx.gitDir, "index"), { force: true });
      await fs.rm(indexLock, { force: true });
    }
    try { opts.crashAt?.("after-index-publish"); } catch (error) { throw new InjectedCheckoutCrash(error); }
    await restoreOpStateWithCrash(ctx, plan.opState, opts.crashAt);
    await headHandle?.close();
    headHandle = undefined;
    if (headToken) await fs.rm(headToken.path, { force: true });
    headToken = undefined;
    for (const handle of reservationHandles) await handle.close();
    reservationHandles.length = 0;
    for (const token of reservationTokens) await fs.rm(token.path, { force: true });
    reservationTokens.length = 0;
    return { status: "committed", ...(indexHash === undefined ? {} : { indexHash }) };
  } catch (error) {
    if (!refsCommitted) {
      await tx?.abort().catch(() => {});
      await postHeadTx?.abort().catch(() => {});
      await indexHandle?.close().catch(() => {});
      if (indexToken) await fs.rm(indexLock, { force: true }).catch(() => {});
      await headHandle?.close().catch(() => {});
      if (headToken) await fs.rm(headToken.path, { force: true }).catch(() => {});
      for (const handle of reservationHandles) await handle.close().catch(() => {});
      for (const token of reservationTokens) await fs.rm(token.path, { force: true }).catch(() => {});
      if (error instanceof InjectedCheckoutCrash) throw error.cause;
      const reason = error instanceof Error ? error.message : "checkout transaction failed";
      return await journalLocksRemain(opts.journal?.value) ? { status: "defer", reason, journalIntact: true } : { status: "defer", reason };
    }
    // After ref commit, never call unconditional restoreLocal (r2 F4). The
    // durable journal's old/new arbitration is the only repair authority.
    await indexHandle?.close().catch(() => {});
    await postHeadTx?.abort().catch(() => {});
    if (indexToken) await fs.rm(indexLock, { force: true }).catch(() => {});
    await headHandle?.close().catch(() => {});
    if (headToken) await fs.rm(headToken.path, { force: true }).catch(() => {});
    for (const handle of reservationHandles) await handle.close().catch(() => {});
    for (const token of reservationTokens) await fs.rm(token.path, { force: true }).catch(() => {});
    if (error instanceof InjectedCheckoutCrash) throw error.cause;
    if (error instanceof JournalArbitrationDefer) return { status: "defer", reason: error.message, journalIntact: true };
    throw error;
  } finally {
    await fs.rm(staged, { force: true }).catch(() => {});
  }
}

class InjectedCheckoutCrash extends Error {
  constructor(readonly cause: unknown) { super("injected checkout crash"); }
}

class JournalArbitrationDefer extends Error {}
