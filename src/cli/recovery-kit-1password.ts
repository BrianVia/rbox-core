import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const OUTPUT_LIMIT = 256 * 1024;
const SECRET_LIMIT = 4 * 1024;
const STDIN_LIMIT = 16 * 1024;
const PROBE_TIMEOUT_MS = 3_000;
const AUTH_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 1_000;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const FIELD_ID = "rboxRecoveryPhrase";
const SAFE_ENV_KEYS = new Set([
  "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "PATH",
  "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM",
]);
const PROVIDER_ENV_KEYS = new Set(["OP_ACCOUNT", "OP_BIOMETRIC_UNLOCK_ENABLED", "OP_CONFIG_DIR"]);
const SESSION_KEY_RE = /^OP_SESSION(?:_[A-Za-z0-9][A-Za-z0-9_-]{0,63})?$/;

export interface OnePasswordProcessLimits {
  timeoutMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  killGraceMs?: number;
  signal?: AbortSignal;
}

export type OnePasswordProcessResult =
  | { outcome: "exit"; code: number; stdout: Uint8Array; stderr: Uint8Array; childStarted: true }
  | { outcome: "timeout" | "signal" | "overflow"; stdout: Uint8Array; stderr: Uint8Array; childStarted: true }
  | { outcome: "cancelled"; stdout: Uint8Array; stderr: Uint8Array; childStarted: boolean }
  | { outcome: "spawn-error"; reason: "enoent" | "eacces" | "other"; stdout: Uint8Array; stderr: Uint8Array; childStarted: false };

export type RunOnePassword = (
  executable: string,
  args: readonly string[],
  stdin: Uint8Array | undefined,
  env: NodeJS.ProcessEnv,
  limits: OnePasswordProcessLimits,
) => Promise<OnePasswordProcessResult>;

export interface OnePasswordAccount {
  uuid: string;
  label: string;
}

export interface OnePasswordVault {
  uuid: string;
  name: string;
  label: string;
}

export interface OnePasswordLocator {
  accountUuid: string;
  vaultUuid: string;
  itemUuid: string;
  fieldId: typeof FIELD_ID;
  operationTag: string;
}

export type OnePasswordDiscovery =
  | { state: "available"; executable: string; version: string }
  | { state: "unavailable"; reason: "not-found" | "unsupported-version" | "probe-failed" };

export type OnePasswordReconciliation =
  | { state: "missing" }
  | { state: "found"; locator: OnePasswordLocator }
  | { state: "ambiguous" }
  | { state: "unavailable"; reason: OnePasswordFailureClass };

export type OnePasswordVerification = "valid" | "mismatch" | "unavailable";
export type OnePasswordFailureClass =
  | "cancelled" | "timeout" | "overflow" | "process-unavailable"
  | "provider-rejected" | "invalid-response";

export type OnePasswordCreateOutcome =
  | { state: "created"; locator: OnePasswordLocator }
  | { state: "child-not-started"; reason: "spawn-enoent" | "spawn-eacces" }
  | { state: "ambiguous"; reason: OnePasswordFailureClass };

export type OnePasswordSaveAttempt =
  | { state: "verified"; locator: OnePasswordLocator; source: "reconciled" | "created" }
  | { state: "missing" }
  | { state: "child-not-started"; reason: "spawn-enoent" | "spawn-eacces" }
  | { state: "ambiguous"; reason: OnePasswordFailureClass | "multiple-matches" | "verification-mismatch" };

export interface OnePasswordProvider {
  executable: string;
  env: NodeJS.ProcessEnv;
  run?: RunOnePassword;
  signal?: AbortSignal;
}

interface OnePasswordAccountCandidate {
  account_uuid?: unknown;
  id?: unknown;
  email?: unknown;
  url?: unknown;
}

interface OnePasswordVaultCandidate {
  id?: unknown;
  name?: unknown;
}

interface OnePasswordItemCandidate {
  id?: unknown;
  tags?: unknown;
  vault?: { id?: unknown };
}

function wipe(bytes: Uint8Array | undefined): void {
  bytes?.fill(0);
}

function wipeChunks(chunks: Buffer[]): void {
  for (const chunk of chunks) chunk.fill(0);
  chunks.length = 0;
}

function concatAndWipe(chunks: Buffer[]): Buffer {
  try {
    return Buffer.concat(chunks);
  } finally {
    wipeChunks(chunks);
  }
}

function appendBounded(chunks: Buffer[], chunk: Buffer, size: { value: number }, limit: number): boolean {
  size.value += chunk.length;
  if (size.value > limit) return false;
  chunks.push(Buffer.from(chunk));
  return true;
}

export function minimalOnePasswordEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && SAFE_ENV_KEYS.has(key)) result[key] = value;
  }
  return result;
}

export function providerOnePasswordEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = minimalOnePasswordEnvironment(source);
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (PROVIDER_ENV_KEYS.has(key) || SESSION_KEY_RE.test(key))) result[key] = value;
  }
  return result;
}

export async function resolveOnePasswordExecutable(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const pathValue = source.PATH;
  if (!pathValue) return undefined;
  const extensions = platform === "win32"
    ? (source.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = path.resolve(directory, `op${extension.toLowerCase()}`);
      try {
        await fs.access(candidate, platform === "win32" ? undefined : 1);
        return candidate;
      } catch {
        if (platform === "win32" && extension !== extension.toLowerCase()) {
          const originalCase = path.resolve(directory, `op${extension}`);
          try {
            await fs.access(originalCase);
            return originalCase;
          } catch {}
        }
      }
    }
  }
  return undefined;
}

export async function runOnePasswordProcess(
  executable: string,
  args: readonly string[],
  stdin: Uint8Array | undefined,
  env: NodeJS.ProcessEnv,
  limits: OnePasswordProcessLimits,
): Promise<OnePasswordProcessResult> {
  if (!path.isAbsolute(executable) || executable.includes("\0")) {
    return { outcome: "spawn-error", reason: "other", stdout: new Uint8Array(), stderr: new Uint8Array(), childStarted: false };
  }
  return await new Promise<OnePasswordProcessResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutSize = { value: 0 };
    const stderrSize = { value: 0 };
    let childStarted = false;
    let settled = false;
    let timedOut = false;
    let cancelled = limits.signal?.aborted === true;
    let overflow = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (cancelled) {
      resolve({ outcome: "cancelled", stdout: new Uint8Array(), stderr: new Uint8Array(), childStarted: false });
      return;
    }

    const child = spawn(executable, [...args], {
      shell: false,
      env,
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), limits.killGraceMs ?? KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    limits.signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, limits.timeoutMs);
    timeout.unref?.();

    child.once("spawn", () => {
      childStarted = true;
      if (!stdin || !child.stdin) return;
      const copy = Buffer.from(stdin);
      child.stdin.once("error", () => {
        copy.fill(0);
        terminate();
      });
      child.stdin.end(copy, () => copy.fill(0));
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) {
        chunk.fill(0);
        return;
      }
      const accepted = appendBounded(stdoutChunks, chunk, stdoutSize, limits.stdoutBytes);
      chunk.fill(0);
      if (!accepted) {
        overflow = true;
        terminate();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (settled) {
        chunk.fill(0);
        return;
      }
      const accepted = appendBounded(stderrChunks, chunk, stderrSize, limits.stderrBytes);
      chunk.fill(0);
      if (!accepted) {
        overflow = true;
        terminate();
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      limits.signal?.removeEventListener("abort", onAbort);
      wipeChunks(stdoutChunks);
      wipeChunks(stderrChunks);
      const reason = error.code === "ENOENT" ? "enoent" : error.code === "EACCES" ? "eacces" : "other";
      resolve({ outcome: "spawn-error", reason, stdout: new Uint8Array(), stderr: new Uint8Array(), childStarted: false });
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      limits.signal?.removeEventListener("abort", onAbort);
      const stdout = concatAndWipe(stdoutChunks);
      const stderr = concatAndWipe(stderrChunks);
      if (!childStarted) {
        wipe(stdout);
        wipe(stderr);
        resolve({ outcome: "spawn-error", reason: "other", stdout: new Uint8Array(), stderr: new Uint8Array(), childStarted: false });
      } else if (overflow) {
        resolve({ outcome: "overflow", stdout, stderr, childStarted: true });
      } else if (cancelled) {
        resolve({ outcome: "cancelled", stdout, stderr, childStarted: true });
      } else if (timedOut) {
        resolve({ outcome: "timeout", stdout, stderr, childStarted: true });
      } else if (signal) {
        resolve({ outcome: "signal", stdout, stderr, childStarted: true });
      } else {
        resolve({ outcome: "exit", code: code ?? 1, stdout, stderr, childStarted: true });
      }
    });
  });
}

function safeFailure(result: OnePasswordProcessResult): OnePasswordFailureClass {
  if (result.outcome === "timeout") return "timeout";
  if (result.outcome === "cancelled") return "cancelled";
  if (result.outcome === "overflow") return "overflow";
  if (result.outcome === "spawn-error" || result.outcome === "signal") return "process-unavailable";
  if (result.outcome === "exit") return result.code === 0 ? "invalid-response" : "provider-rejected";
  return "process-unavailable";
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

function isSafeTag(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.length === 0 || bytes.length > OUTPUT_LIMIT) return undefined;
  try {
    return JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"));
  } catch {
    return undefined;
  }
}

function sanitizeLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const sanitized = value.replace(/[\u0000-\u001f\u007f-\u009f\u001b]/g, " ").replace(/\s+/g, " ").trim();
  return sanitized.slice(0, 120) || fallback;
}

function successful(result: OnePasswordProcessResult): result is Extract<OnePasswordProcessResult, { outcome: "exit" }> {
  return result.outcome === "exit" && result.code === 0;
}

export async function detectOnePasswordCli(options: {
  executable?: string;
  env?: NodeJS.ProcessEnv;
  run?: RunOnePassword;
} = {}): Promise<OnePasswordDiscovery> {
  const source = options.env ?? process.env;
  const executable = options.executable ?? await resolveOnePasswordExecutable(source);
  if (!executable) return { state: "unavailable", reason: "not-found" };
  const run = options.run ?? runOnePasswordProcess;
  const result = await run(executable, ["--version"], undefined, minimalOnePasswordEnvironment(source), {
    timeoutMs: PROBE_TIMEOUT_MS,
    stdoutBytes: 128,
    stderrBytes: 128,
  });
  try {
    if (!successful(result)) return { state: "unavailable", reason: "probe-failed" };
    const version = Buffer.from(result.stdout).toString("utf8").trim();
    if (!/^2\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
      return { state: "unavailable", reason: "unsupported-version" };
    }
    return { state: "available", executable, version };
  } finally {
    wipe(result.stdout);
    wipe(result.stderr);
  }
}

async function runProvider(
  provider: OnePasswordProvider,
  args: readonly string[],
  stdin: Uint8Array | undefined,
  limits: Partial<OnePasswordProcessLimits> = {},
): Promise<OnePasswordProcessResult> {
  return (provider.run ?? runOnePasswordProcess)(
    provider.executable,
    args,
    stdin,
    providerOnePasswordEnvironment(provider.env),
    {
      timeoutMs: limits.timeoutMs ?? AUTH_TIMEOUT_MS,
      stdoutBytes: limits.stdoutBytes ?? OUTPUT_LIMIT,
      stderrBytes: limits.stderrBytes ?? OUTPUT_LIMIT,
      signal: limits.signal ?? provider.signal,
      killGraceMs: limits.killGraceMs,
    },
  );
}

export async function listOnePasswordAccounts(provider: OnePasswordProvider): Promise<
  { state: "ok"; accounts: OnePasswordAccount[] } | { state: "unavailable"; reason: OnePasswordFailureClass }
> {
  const result = await runProvider(provider, ["account", "list", "--format=json"], undefined);
  try {
    if (!successful(result)) return { state: "unavailable", reason: safeFailure(result) };
    const parsed = parseJson(result.stdout);
    if (!Array.isArray(parsed) || parsed.length > 64) return { state: "unavailable", reason: "invalid-response" };
    const accounts: OnePasswordAccount[] = [];
    const seen = new Set<string>();
    const labels = new Map<string, number>();
    for (const value of parsed) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "unavailable", reason: "invalid-response" };
      const row = value as OnePasswordAccountCandidate;
      const uuid = row.account_uuid ?? row.id;
      if (!isSafeId(uuid) || seen.has(uuid)) return { state: "unavailable", reason: "invalid-response" };
      seen.add(uuid);
      const email = sanitizeLabel(row.email, "");
      const url = sanitizeLabel(row.url, "");
      const label = email && url ? `${email} · ${url}` : email || url || `Account ${accounts.length + 1}`;
      labels.set(label, (labels.get(label) ?? 0) + 1);
      accounts.push({ uuid, label });
    }
    return {
      state: "ok",
      accounts: accounts.map((account) => labels.get(account.label)! > 1
        ? { ...account, label: `${account.label} · ${account.uuid}` }
        : account),
    };
  } finally {
    wipe(result.stdout);
    wipe(result.stderr);
  }
}

export async function listOnePasswordVaults(provider: OnePasswordProvider, accountUuid: string): Promise<
  { state: "ok"; vaults: OnePasswordVault[] } | { state: "unavailable"; reason: OnePasswordFailureClass }
> {
  if (!isSafeId(accountUuid)) return { state: "unavailable", reason: "invalid-response" };
  const result = await runProvider(provider, ["vault", "list", "--account", accountUuid, "--format=json"], undefined);
  try {
    if (!successful(result)) return { state: "unavailable", reason: safeFailure(result) };
    const parsed = parseJson(result.stdout);
    if (!Array.isArray(parsed) || parsed.length > 256) return { state: "unavailable", reason: "invalid-response" };
    const vaults: OnePasswordVault[] = [];
    const ids = new Set<string>();
    const names = new Map<string, number>();
    for (const value of parsed) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "unavailable", reason: "invalid-response" };
      const row = value as OnePasswordVaultCandidate;
      if (!isSafeId(row.id) || ids.has(row.id)) return { state: "unavailable", reason: "invalid-response" };
      ids.add(row.id);
      const name = sanitizeLabel(row.name, `Vault ${vaults.length + 1}`);
      names.set(name, (names.get(name) ?? 0) + 1);
      vaults.push({ uuid: row.id, name, label: name });
    }
    return {
      state: "ok",
      vaults: vaults.map((vault) => names.get(vault.name)! > 1
        ? { ...vault, label: `${vault.name} · ${vault.uuid.slice(0, 8)}` }
        : vault),
    };
  } finally {
    wipe(result.stdout);
    wipe(result.stderr);
  }
}

function validTarget(accountUuid: string, vaultUuid: string, operationTag: string): boolean {
  return isSafeId(accountUuid) && isSafeId(vaultUuid) && isSafeTag(operationTag);
}

function itemJson(phrase: string, rboxAccountId: string, operationTag: string): Uint8Array | undefined {
  if (!/^acct_[0-9a-f]{16}$/.test(rboxAccountId) || !isSafeTag(operationTag)) return undefined;
  const bytes = Buffer.from(JSON.stringify({
    title: "rbox recovery phrase",
    category: "SECURE_NOTE",
    tags: ["rbox", operationTag],
    fields: [
      { id: FIELD_ID, type: "CONCEALED", label: "Recovery phrase", value: phrase },
      { id: "rboxAccountId", type: "STRING", label: "rbox account", value: rboxAccountId },
    ],
  }), "utf8");
  if (bytes.length <= STDIN_LIMIT) return bytes;
  bytes.fill(0);
  return undefined;
}

function locatorFromCreate(value: unknown, accountUuid: string, vaultUuid: string, operationTag: string): OnePasswordLocator | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as OnePasswordItemCandidate;
  if (!isSafeId(row.id)) return undefined;
  if (row.vault !== undefined) {
    if (!row.vault || typeof row.vault !== "object" || Array.isArray(row.vault)) return undefined;
    const returnedVault = row.vault.id;
    if (returnedVault !== undefined && returnedVault !== vaultUuid) return undefined;
  }
  return { accountUuid, vaultUuid, itemUuid: row.id, fieldId: FIELD_ID, operationTag };
}

export async function createOnePasswordRecoveryItem(
  provider: OnePasswordProvider,
  input: { accountUuid: string; vaultUuid: string; operationTag: string; rboxAccountId: string; phrase: string },
): Promise<OnePasswordCreateOutcome> {
  if (!validTarget(input.accountUuid, input.vaultUuid, input.operationTag)) {
    return { state: "ambiguous", reason: "invalid-response" };
  }
  const payload = itemJson(input.phrase, input.rboxAccountId, input.operationTag);
  if (!payload) return { state: "ambiguous", reason: "invalid-response" };
  let result: OnePasswordProcessResult | undefined;
  try {
    result = await runProvider(provider, [
      "item", "create",
      "--account", input.accountUuid,
      "--vault", input.vaultUuid,
      "--format=json",
      "-",
    ], payload);
    if (result.outcome === "spawn-error" && result.reason !== "other") {
      return { state: "child-not-started", reason: result.reason === "enoent" ? "spawn-enoent" : "spawn-eacces" };
    }
    if (!successful(result)) return { state: "ambiguous", reason: safeFailure(result) };
    const locator = locatorFromCreate(parseJson(result.stdout), input.accountUuid, input.vaultUuid, input.operationTag);
    return locator ? { state: "created", locator } : { state: "ambiguous", reason: "invalid-response" };
  } finally {
    wipe(payload);
    if (result) {
      wipe(result.stdout);
      wipe(result.stderr);
    }
  }
}

export async function reconcileOnePasswordRecoveryItem(
  provider: OnePasswordProvider,
  target: { accountUuid: string; vaultUuid: string; operationTag: string },
): Promise<OnePasswordReconciliation> {
  if (!validTarget(target.accountUuid, target.vaultUuid, target.operationTag)) {
    return { state: "unavailable", reason: "invalid-response" };
  }
  const result = await runProvider(provider, [
    "item", "list",
    "--account", target.accountUuid,
    "--vault", target.vaultUuid,
    "--tags", target.operationTag,
    "--format=json",
  ], undefined);
  try {
    if (!successful(result)) return { state: "unavailable", reason: safeFailure(result) };
    const parsed = parseJson(result.stdout);
    if (!Array.isArray(parsed) || parsed.length > 256) return { state: "unavailable", reason: "invalid-response" };
    const matches: string[] = [];
    for (const value of parsed) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "unavailable", reason: "invalid-response" };
      const row = value as OnePasswordItemCandidate;
      if (!isSafeId(row.id) || !Array.isArray(row.tags) || !row.tags.every((tag) => typeof tag === "string")) {
        return { state: "unavailable", reason: "invalid-response" };
      }
      if (row.tags.includes(target.operationTag)) matches.push(row.id);
    }
    if (matches.length === 0) return { state: "missing" };
    if (matches.length !== 1) return { state: "ambiguous" };
    return {
      state: "found",
      locator: { ...target, itemUuid: matches[0]!, fieldId: FIELD_ID },
    };
  } finally {
    wipe(result.stdout);
    wipe(result.stderr);
  }
}

export async function verifyOnePasswordRecoveryItem(
  provider: OnePasswordProvider,
  locator: OnePasswordLocator,
  expectedPhrase: Uint8Array,
): Promise<OnePasswordVerification> {
  if (!validTarget(locator.accountUuid, locator.vaultUuid, locator.operationTag)
    || !isSafeId(locator.itemUuid) || locator.fieldId !== FIELD_ID
    || expectedPhrase.length === 0 || expectedPhrase.length > SECRET_LIMIT) return "unavailable";
  const reference = `op://${locator.vaultUuid}/${locator.itemUuid}/${FIELD_ID}`;
  const result = await runProvider(provider, [
    "read", "-n", reference, "--account", locator.accountUuid,
  ], undefined, { stdoutBytes: SECRET_LIMIT });
  try {
    if (!successful(result)) return "unavailable";
    if (result.stdout.length !== expectedPhrase.length) return "mismatch";
    let difference = 0;
    for (let index = 0; index < expectedPhrase.length; index++) difference |= result.stdout[index]! ^ expectedPhrase[index]!;
    return difference === 0 ? "valid" : "mismatch";
  } finally {
    wipe(result.stdout);
    wipe(result.stderr);
  }
}

/** Test-only composition of reconcile → verify → create → verify. The production
 * genesis flow (`completeGenesisDestinationSet`) drives these primitives directly
 * so it can interleave durable progress events (prepared / may-have-dispatched)
 * around the create; this convenience wrapper is retained only for unit coverage
 * of the reconcile/create/verify composition and is not called at runtime. */
export async function attemptOnePasswordRecoverySave(
  provider: OnePasswordProvider,
  input: {
    accountUuid: string;
    vaultUuid: string;
    operationTag: string;
    rboxAccountId: string;
    phrase: string;
    mayCreate: boolean;
  },
): Promise<OnePasswordSaveAttempt> {
  const expected = Buffer.from(input.phrase, "utf8");
  try {
    const reconciled = await reconcileOnePasswordRecoveryItem(provider, input);
    if (reconciled.state === "ambiguous") return { state: "ambiguous", reason: "multiple-matches" };
    if (reconciled.state === "unavailable") return { state: "ambiguous", reason: reconciled.reason };
    if (reconciled.state === "found") {
      const verification = await verifyOnePasswordRecoveryItem(provider, reconciled.locator, expected);
      if (verification === "valid") return { state: "verified", locator: reconciled.locator, source: "reconciled" };
      return { state: "ambiguous", reason: verification === "mismatch" ? "verification-mismatch" : "process-unavailable" };
    }
    if (!input.mayCreate) return { state: "missing" };
    const created = await createOnePasswordRecoveryItem(provider, input);
    if (created.state === "child-not-started") return created;
    if (created.state === "ambiguous") {
      const afterCreate = await reconcileOnePasswordRecoveryItem(provider, input);
      if (afterCreate.state === "found") {
        const verification = await verifyOnePasswordRecoveryItem(provider, afterCreate.locator, expected);
        if (verification === "valid") return { state: "verified", locator: afterCreate.locator, source: "reconciled" };
        return { state: "ambiguous", reason: verification === "mismatch" ? "verification-mismatch" : "process-unavailable" };
      }
      if (afterCreate.state === "ambiguous") return { state: "ambiguous", reason: "multiple-matches" };
      if (afterCreate.state === "unavailable") return { state: "ambiguous", reason: afterCreate.reason };
      return created;
    }
    const verification = await verifyOnePasswordRecoveryItem(provider, created.locator, expected);
    if (verification === "valid") return { state: "verified", locator: created.locator, source: "created" };
    return { state: "ambiguous", reason: verification === "mismatch" ? "verification-mismatch" : "process-unavailable" };
  } finally {
    expected.fill(0);
  }
}
