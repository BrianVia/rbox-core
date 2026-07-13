/**
 * Dependency-drift detection (design 29 §"Dependency-drift notifications").
 *
 * The honest signal — the only claim we can prove without running a package
 * manager — is: *this folder's lockfile changed since rbox last recorded it here.*
 * We content-hash each lockfile and compare to the hash we last saw; a difference
 * is the drift. We NEVER run an install (MF5): we print the exact copy-pasteable
 * command (generated from the shipped engine rule table, so drift and `deps install`
 * can never disagree) and the human runs it.
 *
 * State lives in a GLOBAL file (`~/.config/rbox/deps-state.json`, 0600, atomic
 * write) keyed by absolute lockfile path, so the check works in any directory and
 * each lockfile change nudges at most once.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { ECOSYSTEM_RULES, detectProjects, hashFile, writeFileAtomic, type EcosystemRule } from "../engine/index.js";
import { depsStatePath } from "./rbox-paths.js";

// ── state ────────────────────────────────────────────────────────────────────

interface LockEntry {
  hash: string;
  /** mtime (ms, rounded) + size form the cheap gate that early-exits without hashing. */
  mtime: number;
  size: number;
  /** The last hash we actually notified about — so we nudge at most once per change. */
  notifiedHash?: string;
}

export interface DepsState {
  version: 1;
  /** Instant toggle the shell hook reads (`deps notify on|off`); explicit
   *  `rbox deps drift` ignores it. */
  notifyEnabled: boolean;
  /** Every rc file `notify install` touched, so `uninstall`/`status` cover all shells. */
  hooks: { shell: string; rcFile: string }[];
  locks: Record<string, LockEntry>;
}

const EMPTY_STATE: DepsState = { version: 1, notifyEnabled: true, hooks: [], locks: {} };

export async function loadDepsState(): Promise<DepsState> {
  try {
    const raw = await fsp.readFile(depsStatePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DepsState>;
    return { ...EMPTY_STATE, ...parsed, locks: parsed.locks ?? {}, hooks: parsed.hooks ?? [] };
  } catch {
    return { ...EMPTY_STATE, locks: {}, hooks: [] };
  }
}

export async function saveDepsState(state: DepsState): Promise<void> {
  const file = depsStatePath();
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Shared atomic write (temp + fsync + rename) so concurrent shells never read a
  // half-written file; chmod 0600 since it stores absolute folder paths.
  await writeFileAtomic(file, JSON.stringify(state, null, 2));
  await fsp.chmod(file, 0o600).catch(() => {});
}

// ── notices ──────────────────────────────────────────────────────────────────

export interface DriftNotice {
  /** Display directory (relative to cwd when possible). */
  dir: string;
  lockfile: string;
  /** Full-tier suggested command (engine `tool baseArgs`), or undefined for tier-b. */
  command?: string;
}

/** The full-tier command is exactly the engine's `tool baseArgs` (e.g. `npm ci`,
 *  `cargo fetch --locked`), so drift and `deps install` never disagree. */
export function fullTierCommand(rule: EcosystemRule): string {
  return [rule.tool, ...rule.baseArgs].join(" ");
}

/** One copy-pasteable line per notice; capped at the top 3 to avoid a wall of text. */
export function renderNotices(notices: DriftNotice[]): string {
  const top = notices.slice(0, 3);
  const lines = top.map((n) =>
    n.command
      ? `dependencies changed in ${n.dir} — run \`${n.command}\` to update.`
      : `\`${n.lockfile}\` changed in ${n.dir} — re-install to get the latest dependencies.`
  );
  if (notices.length > top.length) lines.push(`… and ${notices.length - top.length} more`);
  return lines.map((l) => `> ${l}`).join("\n");
}

// ── detection ─────────────────────────────────────────────────────────────────

const LOCK_NAMES = new Set(ECOSYSTEM_RULES.flatMap((r) => r.lockfiles));
const MAX_UPWALK = 25;

async function mtimeOf(p: string): Promise<number | undefined> {
  try {
    return (await fsp.stat(p)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Bounded up-walk from `startDir` to the NEAREST directory containing a lockfile
 * (stopping at the git root / filesystem root / a depth cap). This is what makes a
 * monorepo cheap: entering a sub-package reports the workspace root's drift once,
 * instead of a recursive descent into every package. One `readdir` per level (vs a
 * stat per candidate lockfile) keeps the per-`cd` hot path cheap.
 */
export async function findNearestProjectDir(startDir: string): Promise<{ dir: string; locks: string[] } | undefined> {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth <= MAX_UPWALK; depth++) {
    let entries: Set<string>;
    try {
      entries = new Set(await fsp.readdir(dir));
    } catch {
      return undefined; // unreadable directory
    }
    const locks = [...LOCK_NAMES].filter((n) => entries.has(n));
    if (locks.length) return { dir, locks };
    if (entries.has(".git")) return undefined; // crossed a repo root, no lockfile
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** Show a project dir relative to cwd when it's at/under cwd (the common cd-hook /
 *  in-workspace case → `./api`), else its absolute path (avoids `../../../var/…`). */
function displayDir(projectDir: string): string {
  const rel = path.relative(process.cwd(), projectDir);
  if (rel === "") return ".";
  return rel.startsWith("..") ? projectDir : `./${rel}`;
}

/** Update the lock entry, optionally marking `hash` as notified. */
function record(state: DepsState, absLock: string, e: LockEntry, notifiedHash?: string): void {
  state.locks[absLock] = { ...e, notifiedHash: notifiedHash ?? e.notifiedHash };
}

/**
 * Check one project's lockfile against recorded state. Mutates `state`; returns a
 * notice when (and only when) the lockfile content changed AND we haven't already
 * nudged for exactly this content AND a local install dir doesn't look fresher.
 *
 * `force` (post-sync nudge) skips the cheap mtime gate and the baseline-silent rule:
 * after a sync WRITES a changed lockfile, a first sighting is a real change worth a
 * nudge — but we still respect the once-per-change idempotency.
 */
async function checkProject(
  projectDir: string,
  lockfile: string,
  rule: EcosystemRule,
  ambiguous: boolean,
  state: DepsState,
  force: boolean
): Promise<DriftNotice | null> {
  const absLock = path.join(projectDir, lockfile);
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(absLock);
  } catch {
    return null; // vanished between detect and check
  }
  const prior = state.locks[absLock];
  const mtime = Math.round(stat.mtimeMs);
  const size = stat.size;
  if (!force && prior && prior.mtime === mtime && prior.size === size) return null; // cheap gate

  const hash = await hashFile(absLock, size); // shared streaming SHA-256 (engine/hash)
  const entry: LockEntry = { hash, mtime, size, notifiedHash: prior?.notifiedHash };
  const changed = !prior || prior.hash !== hash;

  if (!changed) {
    record(state, absLock, entry); // mtime touched, bytes identical → no notice
    return null;
  }
  if (!force && !prior) {
    record(state, absLock, entry); // first sighting via the cd hook → establish baseline silently
    return null;
  }
  // Optional false-positive suppressor: a local installDir newer than the lockfile
  // "looks freshly installed". Cargo/Go install into a global cache (installDir null)
  // and rely on the hash signal alone.
  if (rule.installDir) {
    const instMtime = await mtimeOf(path.join(projectDir, rule.installDir));
    if (instMtime !== undefined && instMtime >= stat.mtimeMs) {
      record(state, absLock, entry, hash); // looks fresh → suppress + mark resolved
      return null;
    }
  }
  if (prior?.notifiedHash === hash) {
    record(state, absLock, entry, hash); // already nudged for exactly this content
    return null;
  }
  record(state, absLock, entry, hash);
  return { dir: displayDir(projectDir), lockfile, command: ambiguous ? undefined : fullTierCommand(rule) };
}

/** Drift suppressed entirely? (per-repo opt-out via env; the dashboard/config flag
 *  is honored separately where a workspace config is in hand.) */
function driftDisabledByEnv(): boolean {
  return process.env.RBOX_NO_DRIFT === "1";
}

/**
 * Run the drift check for `startDir` now (the `deps drift` command and the cd hook).
 * `quiet` is the hook's mode: it honors the `notifyEnabled` toggle and stays silent
 * when off. Returns the notices (also persists updated state).
 */
export async function checkDrift(startDir: string, opts: { quiet?: boolean } = {}): Promise<DriftNotice[]> {
  if (driftDisabledByEnv()) return [];
  const state = await loadDepsState();
  if (opts.quiet && !state.notifyEnabled) return [];

  const found = await findNearestProjectDir(startDir);
  if (!found) return [];

  const notices: DriftNotice[] = [];
  // detectProjects maps the dir's lockfiles → rules + ambiguity (dir "" = basenames).
  for (const { lockfile, rule, ambiguous } of detectProjects(found.locks)) {
    const n = await checkProject(found.dir, lockfile, rule, ambiguous, state, false);
    if (n) notices.push(n);
  }
  await saveDepsState(state);
  return notices;
}

/**
 * Post-sync nudge: after a `sync`/`pull` writes files, flag any written lockfile.
 * We KNOW these changed (we just wrote them), so this forces the check — but still
 * records state so the cd hook won't re-nudge the same change. `writtenRelPaths` are
 * workspace-relative POSIX paths from the sync actions.
 */
export async function nudgeForWrittenPaths(root: string, writtenRelPaths: string[]): Promise<DriftNotice[]> {
  if (driftDisabledByEnv()) return [];
  // Group written lockfiles by their directory; check each dir once.
  const dirs = new Map<string, string[]>();
  for (const rel of writtenRelPaths) {
    const base = path.posix.basename(rel);
    if (!LOCK_NAMES.has(base)) continue;
    const dir = path.dirname(path.resolve(root, rel));
    const list = dirs.get(dir) ?? [];
    list.push(base);
    dirs.set(dir, list);
  }
  if (dirs.size === 0) return [];

  const state = await loadDepsState();
  const notices: DriftNotice[] = [];
  for (const [dir, locks] of dirs) {
    for (const { lockfile, rule, ambiguous } of detectProjects(locks)) {
      const n = await checkProject(dir, lockfile, rule, ambiguous, state, true);
      if (n) notices.push(n);
    }
  }
  await saveDepsState(state);
  return notices;
}

/** `rbox deps drift [path]` command. Prints notices to stderr; silent when clean. */
export async function driftCmd(startDir: string, quiet: boolean): Promise<void> {
  const notices = await checkDrift(startDir, { quiet });
  if (notices.length) process.stderr.write(`${renderNotices(notices)}\n`);
  else if (!quiet) process.stderr.write("dependencies are up to date (no lockfile drift here).\n");
}
