import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RBOX_DIR } from "../config.js";
import { acquireLock, type OwnedLock } from "../../engine/lockfile.js";
import { fsyncDirectory, writeFileAtomic } from "../../engine/fsutil.js";
import { currentWorkspaceId, daemonRuntimeDir, type DaemonModeIntent } from "../daemon-control.js";
import { credentialsForStrictFlow, loadCredentials } from "../credentials.js";
import type { DaemonMode } from "../daemon/ambient-status.js";

const DESIRED_FILE = "desired.json";

export type DesiredDaemonStateValue = "running" | "stopped";

/** "stopped for maintenance, resume to `resume`" — the durable form of a stop that
 *  owes a restart. Only the holder of `id` may close the window. */
export interface DaemonMaintenance {
  id: string;
  resume: DesiredDaemonStateValue;
  at: string;
}

export interface DesiredDaemonState {
  rootPath: string;
  state: DesiredDaemonStateValue;
  accountId: string;
  workspaceId: string;
  at: string;
  pullOnly?: boolean;
  pendingModeIntent?: DaemonMode;
  maintenance?: DaemonMaintenance;
}

export interface DesiredStateRow {
  key: string;
  path: string;
  desired: DesiredDaemonState;
}

export type AutostartWorkspaceStatus = DesiredDaemonState & {
  status: DesiredDaemonStateValue | "stale" | "mismatch";
  key: string;
  desiredPath: string;
  reason?: string;
};

export interface CommonDeps {
  loadCredentials?: typeof loadCredentials;
}

export interface DesiredDeps extends CommonDeps {
  now?: () => Date;
  /** Explicit start intent. Omission preserves desired.json's valid prior mode. */
  mode?: DaemonMode;
  /** Compatibility for setup/older callers; true is an explicit pull-only intent. */
  pullOnly?: boolean;
  /** Bounded wait for the scope-transition lock before reporting an edit in progress. */
  lockWaitMs?: number;
}

const rboxHome = () => path.join(process.env.RBOX_HOME || os.homedir(), RBOX_DIR);
const daemonsDir = () => path.join(rboxHome(), "daemons");
const workspaceConfigPath = (root: string) => path.join(root, RBOX_DIR, "workspace.json");

export const desiredStatePath = (root: string): string => path.join(daemonRuntimeDir(root), DESIRED_FILE);

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function parseMaintenance(v: unknown): DaemonMaintenance | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const m = v as Partial<DaemonMaintenance>;
  if (typeof m.id !== "string" || !m.id) return undefined;
  if (m.resume !== "running" && m.resume !== "stopped") return undefined;
  return { id: m.id, resume: m.resume, at: typeof m.at === "string" ? m.at : "" };
}

function parseDesired(raw: string): DesiredDaemonState | undefined {
  try {
    const v = JSON.parse(raw) as Partial<DesiredDaemonState>;
    if (v.state !== "running" && v.state !== "stopped") return undefined;
    if (typeof v.rootPath !== "string" || !v.rootPath) return undefined;
    if (typeof v.accountId !== "string" || !v.accountId) return undefined;
    if (typeof v.workspaceId !== "string" || !v.workspaceId) return undefined;
    if (typeof v.at !== "string" || !v.at) return undefined;
    if (v.pullOnly !== undefined && typeof v.pullOnly !== "boolean") return undefined;
    if (v.pendingModeIntent !== undefined && v.pendingModeIntent !== "pull-only" && v.pendingModeIntent !== "read-write") return undefined;
    const maintenance = parseMaintenance(v.maintenance);
    return {
      rootPath: v.rootPath,
      state: v.state,
      accountId: v.accountId,
      workspaceId: v.workspaceId,
      at: v.at,
      ...(v.pullOnly === true ? { pullOnly: true } : {}),
      ...(v.pendingModeIntent === undefined ? {} : { pendingModeIntent: v.pendingModeIntent }),
      ...(maintenance === undefined ? {} : { maintenance }),
    };
  } catch {
    return undefined;
  }
}

export async function desiredContext(root: string, state: DesiredDaemonStateValue, deps: DesiredDeps = {}): Promise<DesiredDaemonState> {
  const abs = path.resolve(root);
  const creds = credentialsForStrictFlow(await (deps.loadCredentials ?? loadCredentials)());
  const accountId = creds?.accountId;
  const workspaceId = currentWorkspaceId(abs);
  if (!accountId) throw new Error("not logged in — run `rbox login` before changing background sync state");
  if (!workspaceId) throw new Error(`No rbox workspace at ${abs}. Run: rbox track ${abs}`);
  return {
    rootPath: abs,
    state,
    accountId,
    workspaceId,
    at: (deps.now ?? (() => new Date()))().toISOString(),
    ...(deps.pullOnly === true ? { pullOnly: true } : {}),
  };
}

/** Preserve the durable identity and outstanding obligations of a validated
 * boot/upgrade row while rebasing its root onto the caller's normalized path. */
export function resumeDesiredIdentity(root: string, desired: DesiredDaemonState): DesiredDaemonState {
  return {
    rootPath: root,
    state: "running",
    accountId: desired.accountId,
    workspaceId: desired.workspaceId,
    at: desired.at,
    ...(desired.pullOnly === true ? { pullOnly: true } : {}),
    ...(desired.pendingModeIntent === undefined ? {} : { pendingModeIntent: desired.pendingModeIntent }),
    ...(desired.maintenance === undefined ? {} : { maintenance: desired.maintenance }),
  };
}

async function writeDesiredRecord(record: DesiredDaemonState): Promise<void> {
  const p = desiredStatePath(record.rootPath);
  await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  await writeFileAtomic(p, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, exactMode: true });
  await fsyncDirectory(path.dirname(p));
}

export async function readDesiredRecord(filePath: string): Promise<DesiredDaemonState | undefined> {
  try {
    return parseDesired(await fs.readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

export function desiredMode(record: DesiredDaemonState | undefined): DaemonMode {
  // Legacy/absent desired records predate pull-only durability and therefore mean
  // the historical default, read-write.
  return record?.pullOnly === true ? "pull-only" : "read-write";
}

export function desiredWithModes(
  record: DesiredDaemonState,
  accepted: DaemonMode,
  pendingModeIntent?: DaemonMode,
): DesiredDaemonState {
  const { pullOnly: _pullOnly, pendingModeIntent: _pending, ...base } = record;
  return {
    ...base,
    ...(accepted === "pull-only" ? { pullOnly: true } : {}),
    ...(pendingModeIntent === undefined ? {} : { pendingModeIntent }),
  };
}

export function explicitMode(deps: DesiredDeps): DaemonMode | undefined {
  if (deps.mode !== undefined) return deps.mode;
  return deps.pullOnly === true ? "pull-only" : undefined;
}

export function resolveStartMode(
  previous: DesiredDaemonState | undefined,
  deps: DesiredDeps,
): { mode: DaemonMode; intent: DaemonModeIntent; explicit: boolean } {
  const explicit = explicitMode(deps);
  if (explicit !== undefined) {
    return { mode: explicit, intent: previous?.pendingModeIntent === explicit ? "pending" : "explicit", explicit: true };
  }
  if (previous?.pendingModeIntent !== undefined) {
    return { mode: previous.pendingModeIntent, intent: "pending", explicit: false };
  }
  return { mode: desiredMode(previous), intent: "preserve", explicit: false };
}

const DESIRED_LOCK_WAIT_MS = 30_000;
const DESIRED_LOCK_POLL_MS = 25;

export async function desiredRecordLock(root: string): Promise<OwnedLock> {
  const lockPath = `${desiredStatePath(root)}.lock`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + DESIRED_LOCK_WAIT_MS;
  for (;;) {
    const acquired = await acquireLock(lockPath);
    if (acquired.status === "acquired") return acquired.lock;
    if (acquired.status === "unsupported" || acquired.status === "error") {
      throw new Error(`cannot lock desired daemon state: ${String(acquired.error)}`);
    }
    if (Date.now() >= deadline) throw new Error("desired daemon state is busy — re-run the command in a moment");
    await new Promise<void>((resolve) => setTimeout(resolve, DESIRED_LOCK_POLL_MS));
  }
}

export interface DesiredRecordIo {
  read: () => Promise<DesiredDaemonState | undefined>;
  write: (record: DesiredDaemonState) => Promise<void>;
}

/** One critical section over the desired record. Park needs two writes with the
 *  daemon stopped between them and NO window in which another process can act, so
 *  the lock is scoped to the caller's whole sequence rather than to one write. */
export async function withDesiredRecordLock<T>(root: string, body: (io: DesiredRecordIo) => Promise<T>): Promise<T> {
  const lock = await desiredRecordLock(root);
  try {
    return await body({
      read: () => readDesiredRecord(desiredStatePath(root)),
      write: writeDesiredRecord,
    });
  } finally {
    await lock.release();
  }
}

export async function mutateDesiredRecord(
  root: string,
  mutation: (current: DesiredDaemonState | undefined) => Promise<DesiredDaemonState | undefined> | DesiredDaemonState | undefined,
): Promise<DesiredDaemonState | undefined> {
  return withDesiredRecordLock(root, async (io) => {
    const next = await mutation(await io.read());
    if (next !== undefined) await io.write(next);
    return next;
  });
}

export function sameDesiredGeneration(current: DesiredDaemonState | undefined, expected: DesiredDaemonState): boolean {
  return current !== undefined
    && current.rootPath === expected.rootPath
    && current.state === expected.state
    && current.accountId === expected.accountId
    && current.workspaceId === expected.workspaceId
    && current.at === expected.at
    && current.pullOnly === expected.pullOnly
    && current.pendingModeIntent === expected.pendingModeIntent;
}

async function readDesiredRows(): Promise<DesiredStateRow[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(daemonsDir());
  } catch {
    return [];
  }

  const rows: DesiredStateRow[] = [];
  for (const key of entries.sort()) {
    const p = path.join(daemonsDir(), key, DESIRED_FILE);
    const desired = await readDesiredRecord(p);
    if (desired) rows.push({ key, path: p, desired });
  }
  return rows.sort((a, b) => a.desired.rootPath.localeCompare(b.desired.rootPath));
}

export async function readDesiredDaemonRows(): Promise<DesiredStateRow[]> {
  return readDesiredRows();
}

/** Strict evidence read for folder-authority activation. Ordinary aggregate
 * diagnostics keep the tolerant reader above. */
export async function readDesiredDaemonRowsStrict(): Promise<DesiredStateRow[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(daemonsDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`cannot read ${daemonsDir()}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rows: DesiredStateRow[] = [];
  for (const key of entries.sort()) {
    const file = path.join(daemonsDir(), key, DESIRED_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const desired = parseDesired(raw);
    if (!desired) throw new Error(`cannot read ${file}: invalid desired daemon state`);
    rows.push({ key, path: file, desired });
  }
  return rows.sort((a, b) => a.desired.rootPath.localeCompare(b.desired.rootPath));
}

async function staleReason(root: string): Promise<string | undefined> {
  if (!(await exists(root))) return "root missing";
  if (!(await exists(workspaceConfigPath(root)))) return "workspace binding missing";
  return undefined;
}

export async function desiredRunningRows(accountId: string): Promise<AutostartWorkspaceStatus[]> {
  return (await autostartWorkspaceStatuses(accountId)).filter((row) => row.status === "running");
}

async function statusForDesiredRow(row: DesiredStateRow, currentAccountId?: string): Promise<AutostartWorkspaceStatus> {
  const desired = row.desired;
  const stale = await staleReason(desired.rootPath);
  if (stale) return { ...desired, status: "stale", key: row.key, desiredPath: row.path, reason: stale };
  const currentWorkspace = currentWorkspaceId(desired.rootPath);
  if (desired.workspaceId !== currentWorkspace) {
    return {
      ...desired,
      status: "mismatch",
      key: row.key,
      desiredPath: row.path,
      reason: `desired workspace ${desired.workspaceId}, current ${currentWorkspace ?? "unknown"}`,
    };
  }
  if (currentAccountId && desired.accountId !== currentAccountId) {
    return {
      ...desired,
      status: "mismatch",
      key: row.key,
      desiredPath: row.path,
      reason: `desired ${desired.accountId}, current ${currentAccountId}`,
    };
  }
  return { ...desired, status: desired.state, key: row.key, desiredPath: row.path };
}

export async function autostartWorkspaceStatuses(currentAccountId?: string): Promise<AutostartWorkspaceStatus[]> {
  const statuses: AutostartWorkspaceStatus[] = [];
  for (const row of await readDesiredRows()) {
    statuses.push(await statusForDesiredRow(row, currentAccountId));
  }
  return statuses;
}
