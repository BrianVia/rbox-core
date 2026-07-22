import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { phraseToRk, rkToPhrase } from "../engine/e2ee/index.js";
import { RECOVERY_KIT_SERVICE } from "./genesis-seam.js";

export type KeychainProbe = "present" | "missing" | "unavailable";

export interface SecurityResult {
  outcome: "exit" | "timeout" | "signal" | "overflow" | "spawn-error";
  code?: number;
  signal?: NodeJS.Signals;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface SecurityLimits {
  timeoutMs: number;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface KeychainSeams {
  platform: NodeJS.Platform;
  securityBinExists(): Promise<boolean>;
  realpath(path: string): Promise<string>;
  runSecurity(args: readonly string[], stdin: Uint8Array | undefined, limits: SecurityLimits): Promise<SecurityResult>;
}

export interface KeychainIdentity {
  service: typeof RECOVERY_KIT_SERVICE;
  account: string;
  keychainPath: string;
}

export interface KeychainArtifact extends KeychainIdentity {
  writtenAt?: string;
  discoveredAt?: string;
}

const SECURITY_BIN = "/usr/bin/security";
const STDIO_LIMIT = 64 * 1024;
const PHRASE_LIMIT = 1024;
const ACCOUNT_RE = /^acct_([0-9a-f]{16})$/;
const PHRASE_RE = /^[a-z]+( [a-z]+){23}$/;

function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}

function appendBounded(chunks: Buffer[], chunk: Buffer, state: { size: number }, max: number): boolean {
  state.size += chunk.length;
  if (state.size > max) return false;
  chunks.push(Buffer.from(chunk));
  return true;
}

export async function runSecurityProcess(
  args: readonly string[],
  stdin: Uint8Array | undefined,
  limits: SecurityLimits
): Promise<SecurityResult> {
  return await new Promise<SecurityResult>((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutSize = { size: 0 };
    const stderrSize = { size: 0 };
    let settled = false;
    let timedOut = false;
    let overflow = false;
    let spawned = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(SECURITY_BIN, [...args], {
      shell: false,
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, limits.timeoutMs);

    child.once("spawn", () => {
      spawned = true;
      if (stdin && child.stdin) {
        const stdinCopy = Buffer.from(stdin);
        child.stdin.on("error", () => { stdinCopy.fill(0); terminate() });
        child.stdin.end(stdinCopy, () => stdinCopy.fill(0));
      }
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (!appendBounded(stdout, chunk, stdoutSize, limits.stdoutBytes)) {
        overflow = true;
        terminate();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (!appendBounded(stderr, chunk, stderrSize, limits.stderrBytes)) {
        overflow = true;
        terminate();
      }
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve({ outcome: "spawn-error", stdout: new Uint8Array(), stderr: new Uint8Array() });
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);
      if (!spawned) resolve({ outcome: "spawn-error", stdout: out, stderr: err });
      else if (overflow) resolve({ outcome: "overflow", stdout: out, stderr: err });
      else if (timedOut) resolve({ outcome: "timeout", stdout: out, stderr: err });
      else if (signal) resolve({ outcome: "signal", signal, stdout: out, stderr: err });
      else resolve({ outcome: "exit", code: code ?? undefined, stdout: out, stderr: err });
    });
  });
}

export const defaultKeychainSeams: KeychainSeams = {
  platform: process.platform,
  securityBinExists: async () => {
    try {
      await fs.access(SECURITY_BIN);
      return true;
    } catch {
      return false;
    }
  },
  realpath: (value) => fs.realpath(value),
  runSecurity: runSecurityProcess,
};

function requireExit(result: SecurityResult, operation: string): void {
  if (result.outcome !== "exit" || result.code !== 0) throw new Error(`${operation} failed (${safeSecurityClass(result)})`);
}

export function safeSecurityClass(result: SecurityResult): string {
  if (result.outcome !== "exit") return result.outcome;
  if (result.code === 0) return "ok";
  if (result.code === 44) return "item-missing";
  return "denied-or-unavailable";
}

export function validateKeychainPath(value: string): string {
  if (!value || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes("\0") || /[\r\n]/.test(value)) {
    throw new Error("invalid explicit Keychain path");
  }
  return value;
}

export function encodeSecurityInteractiveToken(value: string): string {
  if (value.includes("\0") || /[\r\n]/.test(value)) throw new Error("invalid security command token");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function strictAccount(accountId: string): string {
  if (!ACCOUNT_RE.test(accountId)) throw new Error("malformed account id for recovery Keychain item");
  return accountId;
}

export async function canonicalRecoveryPhrase(phrase: string): Promise<string> {
  const rk = await phraseToRk(phrase.trim());
  try {
    const canonical = await rkToPhrase(rk);
    if (!PHRASE_RE.test(canonical)) throw new Error("recovery phrase is not canonical");
    return canonical;
  } finally {
    wipe(rk);
  }
}

export function buildSecurityAddInput(canonicalPhrase: string, accountId: string, keychainPath: string): Uint8Array {
  strictAccount(accountId);
  validateKeychainPath(keychainPath);
  if (!PHRASE_RE.test(canonicalPhrase)) throw new Error("recovery phrase is not canonical");
  const hex = accountId.slice("acct_".length);
  const tokens = [
    "add-generic-password",
    "-U",
    "-s", encodeSecurityInteractiveToken(RECOVERY_KIT_SERVICE),
    "-a", encodeSecurityInteractiveToken(accountId),
    "-l", encodeSecurityInteractiveToken(`rbox recovery phrase (${hex})`),
    "-j", encodeSecurityInteractiveToken("24-word rbox recovery phrase. Restore: install rbox, rbox login, rbox key recover."),
    "-w", encodeSecurityInteractiveToken(canonicalPhrase),
    encodeSecurityInteractiveToken(keychainPath),
  ];
  const bytes = Buffer.from(`${tokens.join(" ")}\n`, "utf8");
  if (bytes.length >= 4096) {
    wipe(bytes);
    throw new Error("Keychain command exceeds the 4095-byte safety limit");
  }
  return bytes;
}

export async function resolveLoginKeychain(seams: KeychainSeams = defaultKeychainSeams): Promise<string> {
  if (seams.platform !== "darwin" || !(await seams.securityBinExists())) throw new Error("macOS Keychain is unavailable");
  const result = await seams.runSecurity(["login-keychain", "-d", "user"], undefined, {
    timeoutMs: 15_000,
    stdoutBytes: STDIO_LIMIT,
    stderrBytes: STDIO_LIMIT,
  });
  try {
    requireExit(result, "login Keychain resolution");
    const raw = Buffer.from(result.stdout).toString("utf8").trim();
    const token = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1).replace(/\\([\\"])/g, "$1") : raw;
    if (!token || token.split(/\r?\n/).length !== 1) throw new Error("login Keychain resolution returned an invalid path");
    return validateKeychainPath(await seams.realpath(validateKeychainPath(token)));
  } finally {
    wipe(result.stdout);
    wipe(result.stderr);
  }
}

function identityArgs(artifact: KeychainIdentity, includeSecret: boolean): string[] {
  strictAccount(artifact.account);
  if (artifact.service !== RECOVERY_KIT_SERVICE) throw new Error("unrecognized recovery Keychain service");
  validateKeychainPath(artifact.keychainPath);
  return [
    "find-generic-password",
    "-s", artifact.service,
    "-a", artifact.account,
    ...(includeSecret ? ["-w"] : []),
    artifact.keychainPath,
  ];
}

function stripOneTerminalNewline(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  if (end > 0 && bytes[end - 1] === 0x0a) {
    end--;
    if (end > 0 && bytes[end - 1] === 0x0d) end--;
  }
  return bytes.slice(0, end);
}

export async function writeKeychainKit(
  phrase: string,
  accountId: string,
  keychainPath: string,
  seams: KeychainSeams = defaultKeychainSeams,
  now = new Date()
): Promise<KeychainArtifact> {
  if (seams.platform !== "darwin") throw new Error("macOS Keychain is unavailable");
  const canonical = await canonicalRecoveryPhrase(phrase);
  const input = buildSecurityAddInput(canonical, accountId, keychainPath);
  const identity: KeychainIdentity = { service: RECOVERY_KIT_SERVICE, account: strictAccount(accountId), keychainPath: validateKeychainPath(keychainPath) };
  let add: SecurityResult | undefined;
  let verify: SecurityResult | undefined;
  const timeoutMs = process.stdin.isTTY === true && process.stderr.isTTY === true ? 60_000 : 15_000;
  try {
    add = await seams.runSecurity(["-i"], input, { timeoutMs, stdoutBytes: STDIO_LIMIT, stderrBytes: STDIO_LIMIT });
    requireExit(add, "Keychain save");
    verify = await seams.runSecurity(identityArgs(identity, true), undefined, { timeoutMs, stdoutBytes: PHRASE_LIMIT, stderrBytes: STDIO_LIMIT });
    requireExit(verify, "Keychain verification");
    const actual = stripOneTerminalNewline(verify.stdout);
    const expected = Buffer.from(canonical, "utf8");
    try {
      if (!Buffer.from(actual).equals(expected)) throw new Error("Keychain verification mismatch");
    } finally { expected.fill(0) }
    return { ...identity, writtenAt: now.toISOString() };
  } finally {
    wipe(input);
    if (add) { wipe(add.stdout); wipe(add.stderr); }
    if (verify) { wipe(verify.stdout); wipe(verify.stderr); }
  }
}

export async function probeKeychainKit(record: KeychainArtifact, seams: KeychainSeams = defaultKeychainSeams): Promise<KeychainProbe> {
  if (seams.platform !== "darwin") return "unavailable";
  let result: SecurityResult | undefined;
  try {
    if (await seams.realpath(record.keychainPath) !== record.keychainPath) return "unavailable";
    result = await seams.runSecurity(identityArgs(record, false), undefined, { timeoutMs: 5_000, stdoutBytes: STDIO_LIMIT, stderrBytes: STDIO_LIMIT });
    if (result.outcome !== "exit") return "unavailable";
    if (result.code === 0) {
      const output = Buffer.from(result.stdout).toString("utf8");
      return output.length > 0 && !output.includes("\0") ? "present" : "unavailable";
    }
    return result.code === 44 ? "missing" : "unavailable";
  } catch {
    return "unavailable";
  } finally {
    if (result) { wipe(result.stdout); wipe(result.stderr); }
  }
}

export async function readKeychainKit(record: KeychainArtifact, seams: KeychainSeams = defaultKeychainSeams): Promise<Uint8Array> {
  if (seams.platform !== "darwin") throw new Error("macOS Keychain is unavailable");
  if (await seams.realpath(record.keychainPath) !== record.keychainPath) throw new Error("persisted Keychain identity is no longer canonical");
  const result = await seams.runSecurity(identityArgs(record, true), undefined, { timeoutMs: 60_000, stdoutBytes: PHRASE_LIMIT, stderrBytes: STDIO_LIMIT });
  try {
    requireExit(result, "Keychain read");
    const secret = stripOneTerminalNewline(result.stdout);
    if (!secret.length || secret.length > PHRASE_LIMIT) throw new Error("Keychain read returned a malformed secret");
    return Uint8Array.from(secret);
  } finally {
    wipe(result.stdout);
    wipe(result.stderr);
  }
}
