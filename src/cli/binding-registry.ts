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
import { fsyncDirectory, writeFileAtomic } from "../engine/fsutil.js";
import { readDesiredDaemonRows } from "./autostart/desired-state.js";
import { currentWorkspaceId } from "./daemon/runtime-state.js";
import { bindingRegistryDir, bindingRegistryPath } from "./rbox-paths.js";
import { RBOX_DIR } from "./workspace-config.js";

export { bindingRegistryDir, bindingRegistryPath };

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
  /** Design 212 §3.1b layer 4: the REDUNDANT scope witness. The binding record
   *  (`<root>/.rbox/workspace.json`) is canonical; this row exists so a lost or
   *  omitted scope there can be DETECTED rather than read as legacy-unscoped. */
  scope?: string[];
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

const workspaceConfigPath = (root: string): string => path.join(root, RBOX_DIR, "workspace.json");

function validEntry(value: unknown): value is BindingRegistryEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Partial<BindingRegistryEntry>;
  return typeof e.root === "string" && path.isAbsolute(e.root)
    && typeof e.workspaceId === "string" && e.workspaceId.length > 0
    && typeof e.boundAt === "string" && typeof e.lastSeenAt === "string"
    && (e.name === undefined || typeof e.name === "string")
    && (e.accountId === undefined || typeof e.accountId === "string")
    && (e.scope === undefined || (Array.isArray(e.scope) && e.scope.every((p) => typeof p === "string")));
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
  await writeFileAtomic(target, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, exactMode: true });
  // Same durability contract as the desired-state record this mirrors: without
  // the directory fsync, power loss can discard a rename we already reported as
  // successful and silently restore the previous registry.
  await fsyncDirectory(path.dirname(target));
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
  scope?: string[];
}

function upsert(
  entries: BindingRegistryEntry[],
  root: string,
  binding: RememberedBinding,
  nowIso: string,
  /** True when `binding` was read from the workspace config and therefore states
   * the whole truth about the name — including that it was CLEARED. Carrying a
   * stale cached name forward there would make every later resolve see a
   * mismatch and rewrite the file again, forever. */
  authoritativeName = false,
  /** Only the design-212 scope transaction states the whole truth about scope,
   * including its REMOVAL. Every other writer may add or refresh the witness but
   * must never drop it: a binding record that silently lost its scope field is
   * exactly what this row exists to catch. */
  authoritativeScope = false,
): BindingRegistryEntry[] {
  const others = entries.filter((entry) => entry.root !== root);
  const prev = entries.find((entry) => entry.root === root);
  // A rebind starts a new binding lifetime: nothing from the old workspace —
  // not its name, not its account, not its bind date — carries over.
  const carried = prev?.workspaceId === binding.remoteWorkspaceId ? prev : undefined;
  // An empty name is the same as no name; storing "" would make the freshness
  // comparison in `rememberResolvedRoot` rewrite the file on every command.
  const observed = binding.name?.length ? binding.name : undefined;
  const name = authoritativeName ? observed : observed ?? carried?.name;
  const accountId = (binding.accountId?.length ? binding.accountId : undefined) ?? carried?.accountId;
  const observedScope = binding.scope?.length ? [...binding.scope] : undefined;
  const scope = authoritativeScope ? observedScope : observedScope ?? carried?.scope;
  return [...others, {
    root,
    workspaceId: binding.remoteWorkspaceId,
    boundAt: carried?.boundAt ?? nowIso,
    lastSeenAt: nowIso,
    ...(name === undefined ? {} : { name }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(scope === undefined ? {} : { scope }),
  }];
}

/**
 * Record a binding this command just wrote. BEST EFFORT: a busy lock or an
 * unwritable `~/.rbox` must never fail the `track`/`init`/`adopt` it rides along
 * with, and `rememberResolvedRoot` re-adds the entry on the next command.
 *
 * The binding is re-read INSIDE the lock. Without that, a caller holding a
 * snapshot from before a concurrent `untrack` would resurrect the very entry
 * that untrack just removed.
 */
export async function rememberBinding(root: string, binding: RememberedBinding, now = () => new Date()): Promise<void> {
  const abs = path.resolve(root);
  await mutate((entries) => (
    currentWorkspaceId(abs) === binding.remoteWorkspaceId
      ? upsert(entries, abs, binding, now().toISOString())
      : undefined
  )).catch(() => undefined);
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
    const observed = await readBindingIdentity(abs);
    if (observed === undefined) return;
    const at = now();
    const prev = (await readPersistedEntries()).find((entry) => entry.root === abs);
    // A far-future `lastSeenAt` (clock skew, a hand-edited file) must not read as
    // permanently fresh, so the age has to be inside the window from BELOW too.
    const age = prev === undefined ? Number.NaN : at.getTime() - Date.parse(prev.lastSeenAt);
    const fresh = prev !== undefined
      && prev.workspaceId === observed.remoteWorkspaceId
      && prev.name === observed.name
      && (observed.scope === undefined || prev.scope?.join("\n") === observed.scope.join("\n"))
      && Number.isFinite(age) && age >= 0 && age < REFRESH_INTERVAL_MS;
    if (fresh) return;
    // Re-read the binding under the lock: the snapshot above may predate a
    // concurrent `untrack`, and writing it back would resurrect that entry.
    await mutate((entries) => (
      currentWorkspaceId(abs) === observed.remoteWorkspaceId
        ? upsert(entries, abs, observed, at.toISOString(), true)
        : undefined
    ));
  } catch {
    // Best effort by design (see rememberBinding).
  }
}

/** The registry-relevant identity of a binding on disk, or undefined when the
 * root carries no usable one. An empty name is normalized away so it compares
 * equal to the omitted field the entry stores. */
async function readBindingIdentity(root: string): Promise<RememberedBinding | undefined> {
  const cfg = JSON.parse(await fsp.readFile(workspaceConfigPath(root), "utf8")) as {
    remoteWorkspaceId?: unknown;
    name?: unknown;
    scope?: unknown;
  };
  if (typeof cfg.remoteWorkspaceId !== "string" || cfg.remoteWorkspaceId.length === 0) return undefined;
  const name = typeof cfg.name === "string" && cfg.name.length > 0 ? cfg.name : undefined;
  const scope = Array.isArray(cfg.scope) && cfg.scope.length > 0 && cfg.scope.every((p) => typeof p === "string")
    ? (cfg.scope as string[])
    : undefined;
  return {
    remoteWorkspaceId: cfg.remoteWorkspaceId,
    ...(name === undefined ? {} : { name }),
    ...(scope === undefined ? {} : { scope }),
  };
}

/**
 * Write the design-212 scope witness authoritatively — the ONLY path allowed to
 * REMOVE it. Called inside the scope transaction's commit, after the binding
 * record has accepted the same set (design 212 §3.3).
 */
export async function recordBindingScope(root: string, workspaceId: string, scope: readonly string[] | undefined, now = () => new Date()): Promise<void> {
  const abs = path.resolve(root);
  await mutate((entries) => {
    if (currentWorkspaceId(abs) !== workspaceId) return undefined;
    return upsert(entries, abs, {
      remoteWorkspaceId: workspaceId,
      ...(scope && scope.length > 0 ? { scope: [...scope] } : {}),
    }, now().toISOString(), false, true);
  });
}

/**
 * Drop a root from the registry. Returns true when an entry was actually
 * removed. Unlike the record paths this THROWS on a lock or write failure:
 * untrack prints "this machine no longer lists it", and that claim must not be
 * made about an entry that is still on disk.
 */
export async function forgetBinding(root: string): Promise<boolean> {
  const abs = path.resolve(root);
  let removed = false;
  await mutate((entries) => {
    const next = entries.filter((entry) => entry.root !== abs);
    if (next.length === entries.length) return undefined;
    removed = true;
    return next;
  });
  return removed;
}

/** Strict, crash-retryable root relocation for `rbox config repair`.
 * Preserves the complete cached row and binding lifetime under the registry's
 * existing global lock. Unlike rememberBinding, failures are never swallowed. */
export async function relocateBinding(
  oldRoot: string,
  newRoot: string,
  expectedWorkspaceId: string,
): Promise<"moved" | "already-relocated" | "absent"> {
  const oldAbs = path.resolve(oldRoot);
  const newAbs = path.resolve(newRoot);
  let result: "moved" | "already-relocated" | "absent" = "absent";
  await mutate((entries) => {
    const source = entries.find((entry) => entry.root === oldAbs);
    const destination = entries.find((entry) => entry.root === newAbs);
    if (source !== undefined && source.workspaceId !== expectedWorkspaceId) {
      throw new Error(`workspace registry source ${oldAbs} belongs to a different workspace`);
    }
    if (destination !== undefined && destination.workspaceId !== expectedWorkspaceId) {
      throw new Error(`workspace registry destination ${newAbs} belongs to a different workspace`);
    }
    if (source === undefined) {
      result = destination === undefined ? "absent" : "already-relocated";
      return undefined;
    }
    result = "moved";
    return [
      ...entries.filter((entry) => entry.root !== oldAbs && entry.root !== newAbs),
      { ...source, root: newAbs },
    ];
  });
  return result;
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
