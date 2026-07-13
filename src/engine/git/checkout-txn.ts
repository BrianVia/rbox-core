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
  candidateIndexPath: string;
  refUpdates: CheckoutRefUpdate[];
  head: CheckoutHeadUpdate;
  /** create-only recovery-pin lines already provenance-persisted by keep-pins. */
  extraTransactionLines?: string[];
  plannedGraphRoots: string[];
  opState: Array<{ rel: string; tmp: string }>;
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
  crashAt?: (point: "after-connectivity-proof" | "after-prepare" | "after-index-lock" | "after-ref-commit" | "before-index-publish" | "mid-op-state") => void;
  capabilityProbe?: CheckoutCapabilityProbe;
}

export type CommitCheckoutResult =
  | { status: "committed"; indexHash: string }
  | { status: "defer"; reason: string }
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
      if (this.child!.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const stderr = await fs.readFile(this.stderrPath!, "utf8").catch(() => "");
    throw new Error(`update-ref ${command} failed: ${stderr.trim() || "no response"}`);
  }

  async start(): Promise<void> { await this.response("start"); }
  async prepare(): Promise<void> { await this.response("prepare"); }
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
    const code = this.child ? await new Promise<number | null>((resolve, reject) => {
      if (this.child!.exitCode !== null) return resolve(this.child!.exitCode);
      this.child!.once("error", reject);
      this.child!.once("close", resolve);
    }) : 1;
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
  else if (plan.head.newTarget === plan.head.oldTarget) { /* no HEAD write */ }
  else if (plan.head.oldTarget) lines.push(`symref-update HEAD ${plan.head.newTarget} ref ${plan.head.oldTarget}`);
  else if (plan.head.oldOid) lines.push(`symref-update HEAD ${plan.head.newTarget} oid ${plan.head.oldOid}`);
  else throw new Error("symbolic HEAD update requires an expected old target or OID");
  return lines;
}

function expectedTransactionLockPaths(ctx: RepoCtx, plan: CheckoutPlan): Set<string> {
  const locks = new Set<string>([path.resolve(ctx.gitDir, "HEAD.lock"), path.resolve(ctx.commonDir, "packed-refs.lock")]);
  for (const update of plan.refUpdates) locks.add(path.resolve(ctx.commonDir, `${update.ref}.lock`));
  for (const line of plan.extraTransactionLines ?? []) {
    const match = /^(?:create|update|delete|verify) (refs\/\S+)/.exec(line);
    if (match) locks.add(path.resolve(ctx.commonDir, `${match[1]}.lock`));
  }
  return locks;
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
  if (!(await checkoutTransactionSupported(ctx.repoDir, opts.capabilityProbe))) return { status: "unsupported", reason: "git lacks prepared transactional symref-update" };

  const staged = path.join(ctx.gitDir, `.rbox-candidate-index-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  let tx: RefTransaction | undefined;
  let indexHandle: fs.FileHandle | undefined;
  let indexToken: OwnedGitLock | undefined;
  let refsCommitted = false;
  const indexLock = path.join(ctx.gitDir, "index.lock");
  try {
    await fs.copyFile(plan.candidateIndexPath, staged);
    await clearIndexResolveUndo(ctx.repoDir, staged); // private GIT_INDEX_FILE, never live index.
    const candidate = await fs.readFile(staged);
    const indexHash = hashBytes(candidate);
    if (opts.journal) {
      opts.journal.value.expectedNew.indexHash = indexHash;
      await updateCheckoutJournal(opts.journal.workspaceRoot, opts.journal.relPath, opts.journal.value);
    }

    if (!(await (opts.connectivityProof ?? defaultConnectivityProof)(ctx.repoDir, plan.plannedGraphRoots))) return { status: "defer", reason: "planned graph connectivity proof failed" };
    opts.crashAt?.("after-connectivity-proof");

    tx = new RefTransaction(ctx.repoDir);
    await tx.start();
    await tx.write("option no-deref");
    for (const line of transactionLines(plan)) await tx.write(line);
    await tx.prepare();
    opts.crashAt?.("after-prepare");

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
    opts.crashAt?.("after-index-lock");

    const owned: OwnedGitLock[] = [indexToken];
    const expectedLocks = expectedTransactionLockPaths(ctx, plan);
    for (const abs of await allGitLocks(ctx)) {
      if (!expectedLocks.has(abs) || abs === indexToken.path) continue;
      const token = await lockToken(abs);
      if (token) owned.push(token);
    }
    const proofContext: SecondProofContext = { ownedLocks: owned, busy: () => ownershipAwareGitBusy(ctx, owned) };
    if (await proofContext.busy() || !(await opts.secondProof(proofContext))) {
      await tx.abort();
      tx = undefined;
      await indexHandle.close();
      indexHandle = undefined;
      await fs.rm(indexLock, { force: true });
      return { status: "defer", reason: "checkout boundary proof changed or git became busy" };
    }

    await tx.commit();
    tx = undefined;
    refsCommitted = true;
    opts.crashAt?.("after-ref-commit");
    opts.crashAt?.("before-index-publish");
    await indexHandle.writeFile(candidate);
    await indexHandle.sync();
    await indexHandle.close();
    indexHandle = undefined;
    await fs.rename(indexLock, path.join(ctx.gitDir, "index"));
    await restoreOpStateWithCrash(ctx, plan.opState, opts.crashAt);
    return { status: "committed", indexHash };
  } catch (error) {
    if (!refsCommitted) {
      await tx?.abort().catch(() => {});
      await indexHandle?.close().catch(() => {});
      await fs.rm(indexLock, { force: true }).catch(() => {});
      return { status: "defer", reason: error instanceof Error ? error.message : "checkout transaction failed" };
    }
    // After ref commit, never call unconditional restoreLocal (r2 F4). The
    // durable journal's old/new arbitration is the only repair authority.
    await indexHandle?.close().catch(() => {});
    await fs.rm(indexLock, { force: true }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(staged, { force: true }).catch(() => {});
  }
}
