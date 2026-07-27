/**
 * The durable local binding registry (design 211).
 *
 * `~/.rbox/workspaces.json` — the machine's record of every workspace root this
 * CLI has bound. It exists because the aggregate surfaces (`rbox status --all`,
 * `rbox doctor --all`) cannot enumerate workspaces any other way: arbitrary
 * roots are not discoverable by scanning the filesystem, and the daemon
 * desired-state rows under `~/.rbox/daemons` only exist once background sync has
 * been started at least once.
 *
 * Never synced, never sent to the server, never authoritative: a binding's truth
 * is always `<root>/.rbox/workspace.json`. The registry only remembers WHERE to
 * look, and reports what it finds — including roots that are gone.
 *
 * Reads return the UNION of the persisted entries and the live desired-daemon
 * rows. That union is the migration: an existing user's started workspaces
 * appear on the first run with no manual step, and it cannot resurrect an
 * untracked workspace because `untrack` deletes the daemon runtime directory the
 * desired row lives in.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { acquireLock, type OwnedLock } from "../engine/git/lockfile.js";
import { writeFileAtomic } from "../engine/fsutil.js";
import { readDesiredDaemonRows } from "./autostart-cmd.js";
import { currentWorkspaceId } from "./daemon/runtime-state.js";
import { rboxDir } from "./rbox-paths.js";
import { RBOX_DIR } from "./workspace-config.js";

const REGISTRY_FILE = "workspaces.json";
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 25;
/** How long a recorded entry stays "fresh enough" that a mere resolve rewrites nothing. */
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export interface BindingRegistryEntry {
  /** Absolute, resolved. The registry key. */
  root: string;
  workspaceId: string;
  name?: string;
  accountId?: string;
  boundAt: string;
  lastSeenAt: string;
}

interface BindingRegistryFileV1 {
  schemaVersion: 1;
  entries: BindingRegistryEntry[];
}

export type BindingHealth = "bound" | "missing" | "rebound";

export interface BindingRegistryRow extends BindingRegistryEntry {
  health: BindingHealth;
  /** The workspace id the root is CURRENTLY bound to; absent when the root is gone. */
  currentWorkspaceId?: string;
  /** True when this row exists only because a daemon desired-state row named it. */
  derived: boolean;
}

/**
 * `rboxDir()` already honors `RBOX_HOME`, so every suite that redirects `~/.rbox`
 * is isolated for free. `RBOX_TEST_BINDING_REGISTRY_DIR` covers the suites that
 * do NOT set `RBOX_HOME` (main-dispatch, front-door) so a unit test can never
 * write a junk entry into the developer's real registry — the same escape hatch
 * the lock-identity ledger uses. An explicit `RBOX_HOME` always wins.
 */
export function bindingRegistryDir(): string {
  if (!process.env.RBOX_HOME && process.env.RBOX_TEST_BINDING_REGISTRY_DIR) {
    return process.env.RBOX_TEST_BINDING_REGISTRY_DIR;
  }
  return rboxDir();
}

export const bindingRegistryPath = (): string => path.join(bindingRegistryDir(), REGISTRY_FILE);

const workspaceConfigPath = (root: string): string => path.join(root, RBOX_DIR, "workspace.json");

function validEntry(value: unknown): value is BindingRegistryEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Partial<BindingRegistryEntry>;
  return typeof e.root === "string" && path.isAbsolute(e.root)
    && typeof e.workspaceId === "string" && e.workspaceId.length > 0
    && typeof e.boundAt === "string" && typeof e.lastSeenAt === "string"
    && (e.name === undefined || typeof e.name === "string")
    && (e.accountId === undefined || typeof e.accountId === "string");
}

/** The persisted half only. A corrupt or absent file reads as empty: the registry
 * is never allowed to be the reason a command fails. */
export async function readPersistedEntries(): Promise<BindingRegistryEntry[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(bindingRegistryPath(), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BindingRegistryFileV1>;
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.entries)) return [];
    const byRoot = new Map<string, BindingRegistryEntry>();
    for (const entry of parsed.entries) {
      if (validEntry(entry)) byRoot.set(path.resolve(entry.root), { ...entry, root: path.resolve(entry.root) });
    }
    return [...byRoot.values()];
  } catch {
    return [];
  }
}

async function writeEntries(entries: BindingRegistryEntry[]): Promise<void> {
  const file: BindingRegistryFileV1 = {
    schemaVersion: 1,
    entries: [...entries].sort((a, b) => a.root.localeCompare(b.root)),
  };
  const target = bindingRegistryPath();
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFileAtomic(target, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

async function registryLock(): Promise<OwnedLock> {
  const lockPath = `${bindingRegistryPath()}.lock`;
  await fsp.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const acquired = await acquireLock(lockPath);
    if (acquired.status === "acquired") return acquired.lock;
    if (acquired.status === "unsupported" || acquired.status === "error") {
      throw new Error(`cannot lock the workspace registry: ${String(acquired.error)}`);
    }
    if (Date.now() >= deadline) throw new Error("the workspace registry is busy — re-run the command in a moment");
    await new Promise<void>((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

/** Read-modify-write under the registry lock. Returning `undefined` writes nothing. */
async function mutate(
  mutation: (current: BindingRegistryEntry[]) => BindingRegistryEntry[] | undefined,
): Promise<void> {
  const lock = await registryLock();
  try {
    const next = mutation(await readPersistedEntries());
    if (next !== undefined) await writeEntries(next);
  } finally {
    await lock.release();
  }
}

export interface RememberedBinding {
  remoteWorkspaceId: string;
  name?: string;
  accountId?: string;
}

function upsert(
  entries: BindingRegistryEntry[],
  root: string,
  binding: RememberedBinding,
  nowIso: string,
): BindingRegistryEntry[] {
  const others = entries.filter((entry) => entry.root !== root);
  const prev = entries.find((entry) => entry.root === root);
  // A rebind starts a new binding lifetime: nothing from the old workspace —
  // not its name, not its account, not its bind date — carries over.
  const carried = prev?.workspaceId === binding.remoteWorkspaceId ? prev : undefined;
  const name = binding.name ?? carried?.name;
  const accountId = binding.accountId ?? carried?.accountId;
  return [...others, {
    root,
    workspaceId: binding.remoteWorkspaceId,
    boundAt: carried?.boundAt ?? nowIso,
    lastSeenAt: nowIso,
    ...(name === undefined ? {} : { name }),
    ...(accountId === undefined ? {} : { accountId }),
  }];
}

/**
 * Record a binding this command just wrote. BEST EFFORT: a busy lock or an
 * unwritable `~/.rbox` must never fail the `track`/`init`/`adopt` it rides along
 * with, and `rememberResolvedRoot` re-adds the entry on the next command.
 */
export async function rememberBinding(root: string, binding: RememberedBinding, now = () => new Date()): Promise<void> {
  const abs = path.resolve(root);
  await mutate((entries) => upsert(entries, abs, binding, now().toISOString()))
    .catch(() => undefined);
}

/**
 * The convergence net: every workspace-local command that resolves a root calls
 * this, which is what folds in workspaces bound by an older binary that never
 * started background sync. Read-mostly — it takes no lock and writes nothing
 * unless the entry is absent, its identity changed, or it has gone stale.
 */
export async function rememberResolvedRoot(root: string, now = () => new Date()): Promise<void> {
  const abs = path.resolve(root);
  try {
    const cfg = JSON.parse(await fsp.readFile(workspaceConfigPath(abs), "utf8")) as {
      remoteWorkspaceId?: unknown;
      name?: unknown;
    };
    if (typeof cfg.remoteWorkspaceId !== "string" || cfg.remoteWorkspaceId.length === 0) return;
    const name = typeof cfg.name === "string" ? cfg.name : undefined;
    const at = now();
    const prev = (await readPersistedEntries()).find((entry) => entry.root === abs);
    const fresh = prev !== undefined
      && prev.workspaceId === cfg.remoteWorkspaceId
      && prev.name === name
      && at.getTime() - Date.parse(prev.lastSeenAt) < REFRESH_INTERVAL_MS;
    if (fresh) return;
    await mutate((entries) => upsert(entries, abs, { remoteWorkspaceId: cfg.remoteWorkspaceId as string, ...(name ? { name } : {}) }, at.toISOString()));
  } catch {
    // Best effort by design (see rememberBinding).
  }
}

/** Drop a root from the registry. Returns true when an entry was actually removed. */
export async function forgetBinding(root: string): Promise<boolean> {
  const abs = path.resolve(root);
  let removed = false;
  await mutate((entries) => {
    const next = entries.filter((entry) => entry.root !== abs);
    if (next.length === entries.length) return undefined;
    removed = true;
    return next;
  }).catch(() => undefined);
  return removed;
}

/** Is this root known to the registry at all (persisted or daemon-derived)? */
export async function isRegisteredRoot(root: string): Promise<boolean> {
  const abs = path.resolve(root);
  return (await readBindingRegistry()).some((row) => row.root === abs);
}

export interface ReadRegistryDeps {
  readDesiredDaemonRows?: typeof readDesiredDaemonRows;
  /** Defaults to the shared `currentWorkspaceId` reader, so binding truth has
   * exactly one definition across doctor, autostart, and the registry. */
  readBoundWorkspaceId?: (root: string) => string | undefined;
}

/**
 * The effective registry: persisted entries UNIONed with the daemon desired-state
 * rows, each classified against what is actually on disk right now. Stale roots
 * are REPORTED (`missing`/`rebound`), never silently dropped — an aggregate view
 * that quietly forgets a workspace is worse than one that shows a problem.
 */
export async function readBindingRegistry(deps: ReadRegistryDeps = {}): Promise<BindingRegistryRow[]> {
  const readDesired = deps.readDesiredDaemonRows ?? readDesiredDaemonRows;
  const readBound = deps.readBoundWorkspaceId ?? currentWorkspaceId;
  const byRoot = new Map<string, { entry: BindingRegistryEntry; derived: boolean }>();
  for (const row of await readDesired().catch(() => [])) {
    const abs = path.resolve(row.desired.rootPath);
    if (byRoot.has(abs)) continue;
    byRoot.set(abs, {
      derived: true,
      entry: {
        root: abs,
        workspaceId: row.desired.workspaceId,
        boundAt: row.desired.at,
        lastSeenAt: row.desired.at,
        ...(row.desired.accountId ? { accountId: row.desired.accountId } : {}),
      },
    });
  }
  // Persisted entries win: they carry the cached name and the true bind date.
  for (const entry of await readPersistedEntries()) byRoot.set(entry.root, { entry, derived: false });

  const rows: BindingRegistryRow[] = [];
  for (const { entry, derived } of byRoot.values()) {
    const current = readBound(entry.root);
    const health: BindingHealth = current === undefined
      ? "missing"
      : current === entry.workspaceId ? "bound" : "rebound";
    rows.push({ ...entry, derived, health, ...(current === undefined ? {} : { currentWorkspaceId: current }) });
  }
  return rows.sort((a, b) => a.root.localeCompare(b.root));
}
