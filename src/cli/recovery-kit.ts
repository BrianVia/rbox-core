import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureDirectoryChain,
  fsyncCreatedDirectoryAncestors,
  fsyncDirectory,
  writeFileAtomic,
} from "../engine/fsutil.js";
import { phraseToRk, rkToPhrase } from "../engine/e2ee/index.js";
import { RECOVERY_KIT_SERVICE } from "./genesis-seam.js";
import type { KeychainArtifact, KeychainProbe } from "./recovery-kit-keychain.js";
import { assertAccountId } from "./account-id.js";

export const KIT_BANNER = "rbox RECOVERY KIT — keep this somewhere safe";
const FILE_MODE = 0o600;
const MAX_KIT_BYTES = 16 * 1024;
const OFFER_LOCK_MESSAGE = "another rbox process is updating recovery-kit state — retry";

type RecoveryKitWriteStep =
  | "parent-validated" | "before-temp-parent-check" | "before-rename-parent-check"
  | `atomic-${"temp-opened" | "temp-written" | "temp-synced" | "temp-closed" | "before-rename" | "after-rename"}`
  | "before-readback" | "after-readback" | "after-published-fsync" | "after-directory-fsync";
type RecoveryKitWriteTestHook = (step: RecoveryKitWriteStep, file: string) => void | Promise<void>;
let recoveryKitWriteTestHook: RecoveryKitWriteTestHook | undefined;

/** @internal Deterministic fault/race injection for the governed writer. */
export function installRecoveryKitWriteTestHook(hook: RecoveryKitWriteTestHook | undefined): () => void {
  const previous = recoveryKitWriteTestHook;
  recoveryKitWriteTestHook = hook;
  return () => { recoveryKitWriteTestHook = previous };
}

export interface RecoveryKitOptions { kit: boolean; kitPath?: string }
export interface KitTargetEnv { homeDir: string; downloadsExists: boolean }
export interface RenderKitInput { accountId: string; deviceId?: string; phrase: string; hostname: string; generatedAt: Date }

export interface PlaintextArtifact {
  path: string;
  writtenAt: string;
  cleanup: "pending" | "declined" | "failed";
}

export type RecoveryKitOfferSurface = "login" | "status" | "genesis" | "backup" | "recover" | "wizard-recover";
export type RecoveryKitPhraseSource = "cached-rk" | "typed" | "in-hand";
export type RecoveryKitOfferOutcome = "claimed" | "shown" | "accepted" | "declined";

export interface RecoveryKitOffer {
  claimedAt: string;
  surface: RecoveryKitOfferSurface;
  phraseSource: RecoveryKitPhraseSource;
  outcome: RecoveryKitOfferOutcome;
}

export const ONE_PASSWORD_FIELD_ID = "rboxRecoveryPhrase" as const;
export const MAX_ONE_PASSWORD_ARTIFACTS = 16;

export interface OnePasswordArtifactIdentity {
  rboxAccountId: string;
  accountUuid: string;
  vaultUuid: string;
  itemUuid: string;
  fieldId: typeof ONE_PASSWORD_FIELD_ID;
  operationTag: string;
}

export type OnePasswordArtifact = OnePasswordArtifactIdentity & {
  writtenAt: string;
} & (
  | { state: "active" }
  | {
      state: "invalidated";
      invalidatedAt: string;
      invalidationReason: "missing" | "mismatch";
    }
);

export type OnePasswordArtifactStatus =
  | (OnePasswordArtifact & { status: "recorded" })
  | (OnePasswordArtifact & { status: "invalidated" });

export interface RecoveryKitRecord {
  version: 3;
  accountId: string;
  keychain?: KeychainArtifact;
  plaintextArtifacts: PlaintextArtifact[];
  onePasswordArtifacts: OnePasswordArtifact[];
  offer?: RecoveryKitOffer;
}

export type RecoveryKitRecordRead =
  | { state: "missing" }
  | { state: "recognized"; record: RecoveryKitRecord }
  | { state: "unknown" };

export type RecoveryKitFileState = "present" | "unrecognized" | "missing" | "unavailable";
export type RecoveryKitSafety = "backed-up" | "at-risk" | "unknown";

export function recoveryKitOptionsFromFlags(flags: Record<string, string>): RecoveryKitOptions {
  if (flags.kit !== undefined && flags.kit !== "true") throw new Error("`--kit` does not take a path; use `--kit-path <path>`");
  if (flags["kit-path"] === "true") throw new Error("`--kit-path` needs a path");
  const kitPath = flags["kit-path"];
  return { kit: flags.kit === "true" || kitPath !== undefined, ...(kitPath !== undefined ? { kitPath } : {}) };
}

export type RecoveryKitAction = "none" | "offer" | "write" | "write-suppress-echo";
export function recoveryKitAction(interactive: boolean, opts: RecoveryKitOptions): RecoveryKitAction {
  if (!interactive) return opts.kit ? "write-suppress-echo" : "none";
  return opts.kit ? "write" : "offer";
}

export function kitTargetDir(env: KitTargetEnv): string { return env.downloadsExists ? path.join(env.homeDir, "Downloads") : env.homeDir }
export function kitFileName(accountId: string, date: Date): string { return `rbox-recovery-kit-${accountHex16(accountId)}-${localYmd(date)}.txt` }

export function renderKit(input: RenderKitInput): string {
  const generated = localIso(input.generatedAt);
  const device = input.deviceId ? `${input.hostname} (${input.deviceId})` : input.hostname;
  return [KIT_BANNER, "", `Account: ${input.accountId}`, `Generated: ${generated}`, `Device: ${device}`, "", "Recovery phrase:", "", `    ${input.phrase}`, "", "How to recover:", "", "1. Install rbox:", "   curl -fsSL https://rbox.to/install.sh | sh", "2. Sign in on the new machine:", "   rbox login", "3. Re-enroll encryption:", "   rbox key recover", "4. Paste the 24-word phrase above when prompted.", "", "Warnings:", "", "- Anyone with this phrase can decrypt your rbox data.", "- rbox has no escrow and can never reset this phrase for you.", ""].join("\n");
}

export async function defaultKitTargetDir(homeDir = os.homedir()): Promise<string> {
  const downloads = path.join(homeDir, "Downloads");
  try { return (await fs.stat(downloads)).isDirectory() ? downloads : homeDir } catch { return homeDir }
}
export async function defaultKitPath(accountId: string, date = new Date(), homeDir = os.homedir()): Promise<string> { return path.join(await defaultKitTargetDir(homeDir), kitFileName(accountId, date)) }

/** Resolve the exact absolute artifact selected for durable genesis completion. */
export async function resolveRecoveryKitPath(accountId: string, explicitPath?: string, now = new Date()): Promise<string> {
  return explicitPath ? resolveUserPath(explicitPath) : defaultKitPath(accountId, now);
}

export function displayPath(file: string, homeDir = os.homedir()): string {
  const absHome = path.resolve(homeDir); const absFile = path.resolve(file);
  if (absFile === absHome) return "~";
  if (absFile.startsWith(absHome + path.sep)) return `~/${path.relative(absHome, absFile)}`;
  return file;
}

function exactKeys(value: object, allowed: readonly string[]): boolean {
  const actual = Object.keys(value).sort(); const expected = [...allowed].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function validIso(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
function validAbsolute(value: unknown): value is string { return typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value && !value.includes("\0") && !/[\r\n]/.test(value) }
function validProviderId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) }
function validOperationTag(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}

function parsePlaintextArtifact(value: unknown): PlaintextArtifact | undefined {
  if (!isObject(value) || !exactKeys(value, ["path", "writtenAt", "cleanup"])) return undefined;
  if (!validAbsolute(value.path) || !validIso(value.writtenAt) || !["pending", "declined", "failed"].includes(String(value.cleanup))) return undefined;
  return { path: value.path, writtenAt: value.writtenAt, cleanup: value.cleanup as PlaintextArtifact["cleanup"] };
}
function parseKeychainArtifact(value: unknown, accountId: string): KeychainArtifact | undefined {
  if (!isObject(value)) return undefined;
  const keys = Object.keys(value);
  if (!keys.every((key) => ["service", "account", "keychainPath", "writtenAt", "discoveredAt"].includes(key))) return undefined;
  if (!keys.includes("service") || !keys.includes("account") || !keys.includes("keychainPath")) return undefined;
  if (value.service !== RECOVERY_KIT_SERVICE || value.account !== accountId || !validAbsolute(value.keychainPath)) return undefined;
  if (value.writtenAt !== undefined && !validIso(value.writtenAt)) return undefined;
  if (value.discoveredAt !== undefined && !validIso(value.discoveredAt)) return undefined;
  if (value.writtenAt === undefined && value.discoveredAt === undefined) return undefined;
  return { service: RECOVERY_KIT_SERVICE, account: accountId, keychainPath: value.keychainPath, ...(value.writtenAt ? { writtenAt: value.writtenAt as string } : {}), ...(value.discoveredAt ? { discoveredAt: value.discoveredAt as string } : {}) };
}
function parseOffer(value: unknown): RecoveryKitOffer | undefined {
  if (!isObject(value) || !exactKeys(value, ["claimedAt", "surface", "phraseSource", "outcome"])) return undefined;
  if (!validIso(value.claimedAt)) return undefined;
  if (!["login", "status", "genesis", "backup", "recover", "wizard-recover"].includes(String(value.surface))) return undefined;
  if (!["cached-rk", "typed", "in-hand"].includes(String(value.phraseSource))) return undefined;
  if (!["claimed", "shown", "accepted", "declined"].includes(String(value.outcome))) return undefined;
  return value as unknown as RecoveryKitOffer;
}

function parseOnePasswordArtifact(value: unknown, accountId: string): OnePasswordArtifact | undefined {
  if (!isObject(value)) return undefined;
  const common = ["rboxAccountId", "accountUuid", "vaultUuid", "itemUuid", "fieldId", "operationTag", "writtenAt", "state"];
  const activeKeys = common;
  const invalidatedKeys = [...common, "invalidatedAt", "invalidationReason"];
  if (value.state === "active") {
    if (!exactKeys(value, activeKeys)) return undefined;
  } else if (value.state === "invalidated") {
    if (!exactKeys(value, invalidatedKeys)) return undefined;
    if (!validIso(value.invalidatedAt) || !["missing", "mismatch"].includes(String(value.invalidationReason))) return undefined;
  } else {
    return undefined;
  }
  if (value.rboxAccountId !== accountId || value.fieldId !== ONE_PASSWORD_FIELD_ID || !validIso(value.writtenAt)) return undefined;
  if (!validProviderId(value.accountUuid) || !validProviderId(value.vaultUuid) || !validProviderId(value.itemUuid) || !validOperationTag(value.operationTag)) return undefined;
  const identity: OnePasswordArtifactIdentity = {
    rboxAccountId: accountId,
    accountUuid: value.accountUuid,
    vaultUuid: value.vaultUuid,
    itemUuid: value.itemUuid,
    fieldId: ONE_PASSWORD_FIELD_ID,
    operationTag: value.operationTag,
  };
  return value.state === "active"
    ? { ...identity, writtenAt: value.writtenAt, state: "active" }
    : {
        ...identity,
        writtenAt: value.writtenAt,
        state: "invalidated",
        invalidatedAt: value.invalidatedAt as string,
        invalidationReason: value.invalidationReason as "missing" | "mismatch",
      };
}

function sameOnePasswordIdentity(left: OnePasswordArtifactIdentity, right: OnePasswordArtifactIdentity): boolean {
  return left.accountUuid === right.accountUuid && left.vaultUuid === right.vaultUuid && left.itemUuid === right.itemUuid;
}

export function parseRecoveryKitRecord(value: unknown, accountId: string): RecoveryKitRecord | undefined {
  if (!isObject(value)) return undefined;
  if (!("version" in value) && !("kind" in value) && exactKeys(value, ["path", "writtenAt"]) && validAbsolute(value.path) && validIso(value.writtenAt)) {
    return { version: 3, accountId, plaintextArtifacts: [{ path: value.path, writtenAt: value.writtenAt, cleanup: "pending" }], onePasswordArtifacts: [] };
  }
  const v2Allowed = ["version", "accountId", "keychain", "plaintextArtifacts", "offer"];
  const v3Allowed = [...v2Allowed, "onePasswordArtifacts"];
  if (value.version !== 2 && value.version !== 3) return undefined;
  const allowed = value.version === 2 ? v2Allowed : v3Allowed;
  if (!Object.keys(value).every((key) => allowed.includes(key)) || value.accountId !== accountId || !Array.isArray(value.plaintextArtifacts)) return undefined;
  if (!("version" in value) || !("accountId" in value) || !("plaintextArtifacts" in value)) return undefined;
  if (value.version === 3 && !Array.isArray(value.onePasswordArtifacts)) return undefined;
  const plaintextArtifacts = value.plaintextArtifacts.map(parsePlaintextArtifact);
  if (plaintextArtifacts.some((item) => !item)) return undefined;
  const keychain = value.keychain === undefined ? undefined : parseKeychainArtifact(value.keychain, accountId);
  const offer = value.offer === undefined ? undefined : parseOffer(value.offer);
  if (value.keychain !== undefined && !keychain || value.offer !== undefined && !offer) return undefined;
  const onePasswordArtifacts = value.version === 3
    ? (value.onePasswordArtifacts as unknown[]).map((artifact) => parseOnePasswordArtifact(artifact, accountId))
    : [];
  if (onePasswordArtifacts.length > MAX_ONE_PASSWORD_ARTIFACTS || onePasswordArtifacts.some((artifact) => !artifact)) return undefined;
  const identities = new Set<string>();
  for (const artifact of onePasswordArtifacts as OnePasswordArtifact[]) {
    const identity = `${artifact.accountUuid}\0${artifact.vaultUuid}\0${artifact.itemUuid}`;
    if (identities.has(identity)) return undefined;
    identities.add(identity);
  }
  return {
    version: 3,
    accountId,
    ...(keychain ? { keychain } : {}),
    plaintextArtifacts: plaintextArtifacts as PlaintextArtifact[],
    onePasswordArtifacts: onePasswordArtifacts as OnePasswordArtifact[],
    ...(offer ? { offer } : {}),
  };
}

export async function readRecoveryKitRecordState(accountId: string): Promise<RecoveryKitRecordRead> {
  try {
    const raw = await fs.readFile(recordPath(accountId), "utf8");
    let value: unknown;
    try { value = JSON.parse(raw) } catch { return { state: "unknown" } }
    const record = parseRecoveryKitRecord(value, accountId);
    return record ? { state: "recognized", record } : { state: "unknown" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { state: "missing" } : { state: "unknown" };
  }
}
export async function readRecoveryKitRecord(accountId: string): Promise<RecoveryKitRecord | undefined> {
  const result = await readRecoveryKitRecordState(accountId);
  return result.state === "recognized" ? result.record : undefined;
}

async function hardenedWrite(file: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(file);
  const created = await ensureDirectoryChain(dir, "recovery-kit directory");
  await fsyncCreatedDirectoryAncestors(dir, created);
  const parent = await fs.lstat(dir, { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error(`unsafe recovery-kit parent directory: ${dir}`);
  const verifyParent = async () => {
    const current = await fs.lstat(dir, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== parent.dev || current.ino !== parent.ino) {
      throw new Error(`recovery-kit parent directory changed during publication: ${dir}`);
    }
  };
  await recoveryKitWriteTestHook?.("parent-validated", file);
  const existing = await fs.lstat(file).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw new Error(`refusing to write recovery kit through a symlink: ${file}`);
  if (existing && !existing.isFile()) throw new Error(`refusing to replace non-file recovery kit path: ${file}`);
  await writeFileAtomic(file, data, {
    flag: "wx",
    mode: FILE_MODE,
    exactMode: true,
    beforeTempCreate: async () => {
      await recoveryKitWriteTestHook?.("before-temp-parent-check", file);
      await verifyParent();
    },
    beforeRename: async () => {
      await recoveryKitWriteTestHook?.("before-rename-parent-check", file);
      await verifyParent();
      return true;
    },
    onStep: (step) => recoveryKitWriteTestHook?.(`atomic-${step}`, file),
  });
  await recoveryKitWriteTestHook?.("before-readback", file);
  const handle = await fs.open(file, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.readFile();
    if (!Buffer.from(actual).equals(Buffer.from(data))) throw new Error("recovery-kit exact read-back failed");
    await recoveryKitWriteTestHook?.("after-readback", file);
    await handle.sync();
    await recoveryKitWriteTestHook?.("after-published-fsync", file);
  } finally { await handle.close() }
  await fsyncDirectory(dir);
  await recoveryKitWriteTestHook?.("after-directory-fsync", file);
}

async function withRecordLock<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
  const lock = `${recordPath(accountId)}.lock`;
  const dir = path.dirname(lock);
  const created = await ensureDirectoryChain(dir, "recovery-kit record directory");
  await fsyncCreatedDirectoryAncestors(dir, created);
  let handle: fs.FileHandle;
  try { handle = await fs.open(lock, "wx", FILE_MODE) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let holder = 0;
    try { holder = Number((await fs.readFile(lock, "utf8")).trim()) } catch {}
    let alive = Number.isInteger(holder) && holder > 0;
    if (alive) try { process.kill(holder, 0) } catch (e) { alive = (e as NodeJS.ErrnoException).code === "EPERM" }
    if (alive) throw new Error(OFFER_LOCK_MESSAGE);
    await fs.unlink(lock); await fsyncDirectory(dir); handle = await fs.open(lock, "wx", FILE_MODE);
  }
  try {
    await handle.writeFile(String(process.pid)); await handle.sync(); await handle.close(); await fsyncDirectory(dir);
    return await operation();
  } finally {
    await handle.close().catch(() => {}); await fs.unlink(lock).catch(() => {}); await fsyncDirectory(dir).catch(() => {});
  }
}

export async function mutateRecoveryKitRecord(accountId: string, mutate: (current: RecoveryKitRecord) => RecoveryKitRecord): Promise<RecoveryKitRecord> {
  return withRecordLock(accountId, async () => {
    const loaded = await readRecoveryKitRecordState(accountId);
    if (loaded.state === "unknown") throw new Error("refusing to overwrite an unknown recovery-kit record");
    const current = loaded.state === "recognized" ? loaded.record : { version: 3 as const, accountId, plaintextArtifacts: [], onePasswordArtifacts: [] };
    return writeRecoveryKitRecordUnlocked(accountId, mutate(current));
  });
}

async function writeRecoveryKitRecordUnlocked(accountId: string, next: RecoveryKitRecord): Promise<RecoveryKitRecord> {
  const validated = parseRecoveryKitRecord(next, accountId);
  if (!validated) throw new Error("invalid recovery-kit record mutation");
  await hardenedWrite(recordPath(accountId), `${JSON.stringify(validated, null, 2)}\n`);
  return validated;
}

export async function writeRecoveryKit(
  phrase: string,
  creds: { accountId?: string; deviceId?: string },
  explicitPath?: string,
  now = new Date()
): Promise<{ path: string; writtenAt: string; recordError?: Error }> {
  if (!creds.accountId) throw new Error("credential has no account id; cannot write a recovery kit");
  const file = await resolveRecoveryKitPath(creds.accountId, explicitPath, now);
  const content = renderKit({ accountId: creds.accountId, deviceId: creds.deviceId, phrase, hostname: os.hostname(), generatedAt: now });
  await hardenedWrite(file, content);
  const writtenAt = now.toISOString();
  let recordError: Error | undefined;
  try {
    await mutateRecoveryKitRecord(creds.accountId, (current) => ({ ...current, plaintextArtifacts: [...current.plaintextArtifacts.filter((item) => item.path !== file), { path: file, writtenAt, cleanup: "pending" }] }));
  } catch (error) { recordError = error instanceof Error ? error : new Error(String(error)) }
  return { path: file, writtenAt, ...(recordError ? { recordError } : {}) };
}

export async function recordKeychainArtifact(accountId: string, artifact: KeychainArtifact): Promise<void> {
  if (!parseKeychainArtifact(artifact, accountId)) throw new Error("invalid Keychain artifact metadata");
  await mutateRecoveryKitRecord(accountId, (current) => ({ ...current, keychain: artifact }));
}

export async function mergeDiscoveredKeychainArtifact(accountId: string, artifact: KeychainArtifact): Promise<"merged" | "unchanged" | "conflict"> {
  if (!parseKeychainArtifact(artifact, accountId) || !artifact.discoveredAt || artifact.writtenAt) throw new Error("invalid discovered Keychain metadata");
  let outcome: "merged" | "unchanged" | "conflict" = "merged";
  await mutateRecoveryKitRecord(accountId, (current) => {
    if (!current.keychain) return { ...current, keychain: artifact };
    const same = current.keychain.service === artifact.service && current.keychain.account === artifact.account && current.keychain.keychainPath === artifact.keychainPath;
    if (!same) { outcome = "conflict"; return current }
    if (current.keychain.discoveredAt) { outcome = "unchanged"; return current }
    return { ...current, keychain: { ...current.keychain, discoveredAt: artifact.discoveredAt } };
  });
  return outcome;
}

export async function recordOnePasswordArtifact(accountId: string, artifact: OnePasswordArtifact): Promise<"recorded" | "unchanged"> {
  const parsed = parseOnePasswordArtifact(artifact, accountId);
  if (!parsed || parsed.state !== "active") throw new Error("invalid active 1Password artifact metadata");
  let outcome: "recorded" | "unchanged" = "recorded";
  await mutateRecoveryKitRecord(accountId, (current) => {
    const existing = current.onePasswordArtifacts.find((candidate) => sameOnePasswordIdentity(candidate, parsed));
    if (existing) {
      // Idempotent re-record: the same active item (same account/vault/item
      // identity, operationTag, field, and rbox account) may be recorded again on
      // resume after a crash between the provider write and the durable progress
      // append. Tolerate a drifted `writtenAt` — keep the original record — rather
      // than hard-erroring, which previously wedged that destination permanently.
      if (existing.state === "active"
        && existing.operationTag === parsed.operationTag
        && existing.fieldId === parsed.fieldId
        && existing.rboxAccountId === parsed.rboxAccountId) {
        outcome = "unchanged";
        return current;
      }
      throw new Error("conflicting 1Password artifact identity");
    }
    if (current.onePasswordArtifacts.length >= MAX_ONE_PASSWORD_ARTIFACTS) throw new Error("1Password artifact history is full");
    return { ...current, onePasswordArtifacts: [...current.onePasswordArtifacts, parsed] };
  });
  return outcome;
}

export async function invalidateOnePasswordArtifact(
  accountId: string,
  identity: OnePasswordArtifactIdentity,
  reason: "missing" | "mismatch",
  now = new Date(),
): Promise<"invalidated" | "unchanged"> {
  const probe = parseOnePasswordArtifact({ ...identity, writtenAt: now.toISOString(), state: "active" }, accountId);
  if (!probe) throw new Error("invalid 1Password artifact identity");
  let outcome: "invalidated" | "unchanged" = "invalidated";
  await mutateRecoveryKitRecord(accountId, (current) => {
    const index = current.onePasswordArtifacts.findIndex((candidate) => sameOnePasswordIdentity(candidate, probe));
    if (index < 0) throw new Error("1Password artifact identity is not recorded");
    const existing = current.onePasswordArtifacts[index]!;
    if (existing.operationTag !== identity.operationTag || existing.fieldId !== identity.fieldId || existing.rboxAccountId !== identity.rboxAccountId) {
      throw new Error("1Password artifact locator does not match the recorded active artifact");
    }
    if (existing.state === "invalidated") {
      if (existing.invalidationReason !== reason) throw new Error("1Password artifact has a conflicting invalidation");
      outcome = "unchanged";
      return current;
    }
    const replacement: OnePasswordArtifact = {
      ...existing,
      state: "invalidated",
      invalidatedAt: now.toISOString(),
      invalidationReason: reason,
    };
    const onePasswordArtifacts = [...current.onePasswordArtifacts];
    onePasswordArtifacts[index] = replacement;
    return { ...current, onePasswordArtifacts };
  });
  return outcome;
}

export function onePasswordArtifactStatuses(record: RecoveryKitRecord): OnePasswordArtifactStatus[] {
  return record.onePasswordArtifacts.map((artifact) => artifact.state === "active"
    ? { ...artifact, status: "recorded" }
    : { ...artifact, status: "invalidated" });
}

export async function claimRecoveryKitOffer(
  accountId: string,
  surface: RecoveryKitOfferSurface,
  phraseSource: RecoveryKitPhraseSource,
  actionablePreflight: () => Promise<boolean>,
  now = new Date()
): Promise<boolean> {
  // A verified-live claimant may spend the Keychain timeout, termination
  // grace, and durable publication time under this lock. Keep waiting until
  // it releases or publishes; a dead holder is reclaimed by withRecordLock.
  for (let attempt = 0; ; attempt++) {
    try {
      return await withRecordLock(accountId, async () => {
        const loaded = await readRecoveryKitRecordState(accountId);
        if (loaded.state === "unknown") throw new Error("refusing to overwrite an unknown recovery-kit record");
        const current = loaded.state === "recognized" ? loaded.record : { version: 3 as const, accountId, plaintextArtifacts: [], onePasswordArtifacts: [] };
        if (current.offer || !(await actionablePreflight())) return false;
        await writeRecoveryKitRecordUnlocked(accountId, { ...current, offer: { claimedAt: now.toISOString(), surface, phraseSource, outcome: "claimed" } });
        return true;
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== OFFER_LOCK_MESSAGE) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
      const current = await readRecoveryKitRecordState(accountId);
      if (current.state === "recognized" && current.record.offer) return false;
    }
  }
}

export async function updateRecoveryKitOfferOutcome(accountId: string, outcome: Exclude<RecoveryKitOfferOutcome, "claimed">): Promise<void> {
  await mutateRecoveryKitRecord(accountId, (current) => current.offer ? { ...current, offer: { ...current.offer, outcome } } : current);
}

export async function recoveryKitFileState(accountId: string, artifact: PlaintextArtifact | undefined): Promise<RecoveryKitFileState> {
  assertAccountId(accountId);
  if (!artifact) return "missing";
  const parsed = await readPlaintextKit(artifact.path);
  if (parsed.state !== "present") return parsed.state;
  if (parsed.accountId !== accountId) return "unrecognized";
  return "present";
}

export async function readPlaintextKit(file: string): Promise<{ state: RecoveryKitFileState; accountId?: string; phrase?: string; dev?: number; ino?: number }> {
  let before: fsSync.Stats | undefined; let handle: fs.FileHandle | undefined;
  try {
    before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink()) return { state: "unrecognized" };
    if (before.size > MAX_KIT_BYTES) return { state: "unrecognized" };
    handle = await fs.open(file, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
    const openStat = await handle.stat();
    if (!openStat.isFile() || openStat.size > MAX_KIT_BYTES || openStat.dev !== before.dev || openStat.ino !== before.ino) return { state: "unrecognized" };
    const raw = await handle.readFile({ encoding: "utf8" });
    const after = await fs.lstat(file);
    if (after.dev !== openStat.dev || after.ino !== openStat.ino) return { state: "unrecognized" };
    const lines = raw.split(/\r?\n/);
    if (lines[0] !== KIT_BANNER) return { state: "unrecognized" };
    const account = lines.find((line) => line.startsWith("Account: "))?.slice(9);
    const phraseLine = lines.find((line) => line.startsWith("    "))?.trim();
    if (!account || !/^acct_[0-9a-f]{16}$/.test(account) || !phraseLine) return { state: "unrecognized" };
    const rk = await phraseToRk(phraseLine).catch(() => undefined);
    if (!rk) return { state: "unrecognized" };
    try {
      const phrase = await rkToPhrase(rk);
      if (phrase !== phraseLine) return { state: "unrecognized" };
      return { state: "present", accountId: account, phrase, dev: openStat.dev, ino: openStat.ino };
    } finally { rk.fill(0) }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing" };
    return { state: "unavailable" };
  } finally { await handle?.close().catch(() => {}) }
}

export async function deleteMatchingPlaintextArtifact(accountId: string, artifact: PlaintextArtifact, canonicalPhrase: string): Promise<boolean> {
  const first = await readPlaintextKit(artifact.path);
  if (first.state !== "present" || first.accountId !== accountId || first.phrase !== canonicalPhrase) return false;
  const second = await readPlaintextKit(artifact.path);
  if (second.state !== "present" || second.accountId !== accountId || second.phrase !== canonicalPhrase) return false;
  const before = await fs.lstat(artifact.path);
  if (!before.isFile() || before.isSymbolicLink() || before.dev !== second.dev || before.ino !== second.ino) return false;
  await fs.unlink(artifact.path); await fsyncDirectory(path.dirname(artifact.path));
  await mutateRecoveryKitRecord(accountId, (current) => ({ ...current, plaintextArtifacts: current.plaintextArtifacts.filter((item) => item.path !== artifact.path) }));
  return true;
}

export async function markPlaintextCleanup(accountId: string, artifactPath: string, cleanup: "declined" | "failed"): Promise<void> {
  await mutateRecoveryKitRecord(accountId, (current) => ({
    ...current,
    plaintextArtifacts: current.plaintextArtifacts.map((item) => item.path === artifactPath ? { ...item, cleanup } : item),
  }));
}

export function pathIsInsideRemovalRoot(candidate: string, removalRoot: string): boolean {
  const root = path.resolve(removalRoot); const value = path.resolve(candidate);
  return value === root || value.startsWith(root + path.sep);
}

export function recoveryKitSafety(recordState: RecoveryKitRecordRead, states: { keychain?: KeychainProbe; plaintext: RecoveryKitFileState[] }, removalRoot: string): RecoveryKitSafety {
  if (recordState.state === "unknown") return "unknown";
  if (recordState.state === "missing") return "at-risk";
  const record = recordState.record;
  const presentOutside = record.plaintextArtifacts.some((item, index) => states.plaintext[index] === "present" && !pathIsInsideRemovalRoot(item.path, removalRoot))
    || Boolean(record.keychain && states.keychain === "present" && !pathIsInsideRemovalRoot(record.keychain.keychainPath, removalRoot));
  if (presentOutside) return "backed-up";
  if (states.keychain === "unavailable" || states.plaintext.includes("unavailable")) return "unknown";
  if (record.onePasswordArtifacts.some((artifact) => artifact.state === "active")) return "unknown";
  return "at-risk";
}

export function recoveryKitRecordPath(accountId: string): string { return recordPath(accountId) }
function recordPath(accountId: string): string {
  assertAccountId(accountId);
  const e2eeDir = path.resolve(process.env.RBOX_HOME || os.homedir(), ".rbox", "e2ee");
  const accountDir = path.resolve(e2eeDir, accountId);
  if (path.dirname(accountDir) !== e2eeDir) throw new Error("recovery-kit account directory escaped containment");
  const file = path.resolve(accountDir, "kit.json");
  if (path.dirname(file) !== accountDir) throw new Error("recovery-kit record path escaped account directory");
  return file;
}
function resolveUserPath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return path.resolve(value);
}
export function accountHex16(accountId: string): string {
  const match = accountId.match(/^acct_([0-9a-f]{16})$/);
  if (!match) throw new Error(`account id does not contain a 16-hex suffix: ${accountId}`);
  return match[1]!;
}
export function localYmd(date: Date): string { return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}` }
function localIso(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}` }
