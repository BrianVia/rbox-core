import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../engine/fsutil.js";

export const KIT_BANNER = "rbox RECOVERY KIT — keep this somewhere safe";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export interface RecoveryKitOptions {
  kit: boolean;
  kitPath?: string;
}

export interface KitTargetEnv {
  homeDir: string;
  downloadsExists: boolean;
}

export interface RenderKitInput {
  accountId: string;
  deviceId?: string;
  phrase: string;
  hostname: string;
  generatedAt: Date;
}

export interface RecoveryKitRecord {
  path: string;
  writtenAt: string;
}

export type RecoveryKitFileState = "present" | "unrecognized" | "missing";

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

export function kitTargetDir(env: KitTargetEnv): string {
  return env.downloadsExists ? path.join(env.homeDir, "Downloads") : env.homeDir;
}

export function kitFileName(accountId: string, date: Date): string {
  return `rbox-recovery-kit-${accountHex16(accountId)}-${localYmd(date)}.txt`;
}

export function renderKit(input: RenderKitInput): string {
  const generated = localIso(input.generatedAt);
  const device = input.deviceId ? `${input.hostname} (${input.deviceId})` : input.hostname;
  return [
    KIT_BANNER,
    "",
    `Account: ${input.accountId}`,
    `Generated: ${generated}`,
    `Device: ${device}`,
    "",
    "Recovery phrase:",
    "",
    `    ${input.phrase}`,
    "",
    "How to recover:",
    "",
    "1. Install rbox:",
    "   curl -fsSL https://rbox.to/install.sh | sh",
    "2. Sign in on the new machine:",
    "   rbox login",
    "3. Re-enroll encryption:",
    "   rbox key recover",
    "4. Paste the 24-word phrase above when prompted.",
    "",
    "Warnings:",
    "",
    "- Anyone with this phrase can decrypt your rbox data.",
    "- rbox has no escrow and can never reset this phrase for you.",
    "",
  ].join("\n");
}

export async function defaultKitTargetDir(homeDir = os.homedir()): Promise<string> {
  const downloads = path.join(homeDir, "Downloads");
  try {
    const st = await fs.stat(downloads);
    return st.isDirectory() ? downloads : homeDir;
  } catch {
    return homeDir;
  }
}

export async function defaultKitPath(accountId: string, date = new Date(), homeDir = os.homedir()): Promise<string> {
  return path.join(await defaultKitTargetDir(homeDir), kitFileName(accountId, date));
}

export function displayPath(file: string, homeDir = os.homedir()): string {
  const absHome = path.resolve(homeDir);
  const absFile = path.resolve(file);
  if (absFile === absHome) return "~";
  if (absFile.startsWith(absHome + path.sep)) return `~/${path.relative(absHome, absFile)}`;
  return file;
}

export async function writeRecoveryKit(
  phrase: string,
  creds: { accountId?: string; deviceId?: string },
  explicitPath?: string,
  now = new Date()
): Promise<{ path: string; writtenAt: string; recordError?: Error }> {
  if (!creds.accountId) throw new Error("credential has no account id; cannot write a recovery kit");
  const file = explicitPath ? resolveUserPath(explicitPath) : await defaultKitPath(creds.accountId, now);
  const content = renderKit({ accountId: creds.accountId, deviceId: creds.deviceId, phrase, hostname: os.hostname(), generatedAt: now });
  await secretSafeWrite(file, content);
  const actual = await fs.readFile(file, "utf8");
  if (actual !== content) throw new Error("recovery kit verification failed after write");

  const writtenAt = now.toISOString();
  let recordError: Error | undefined;
  try {
    await writeRecoveryKitRecord(creds.accountId, { path: file, writtenAt });
  } catch (e) {
    recordError = e instanceof Error ? e : new Error(String(e));
  }
  return { path: file, writtenAt, ...(recordError ? { recordError } : {}) };
}

export async function readRecoveryKitRecord(accountId: string): Promise<RecoveryKitRecord | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(recordPath(accountId), "utf8")) as Partial<RecoveryKitRecord>;
    if (typeof parsed.path !== "string" || typeof parsed.writtenAt !== "string") return undefined;
    return { path: parsed.path, writtenAt: parsed.writtenAt };
  } catch {
    return undefined;
  }
}

export async function recoveryKitFileState(record: RecoveryKitRecord): Promise<RecoveryKitFileState> {
  let raw: string;
  try {
    raw = await fs.readFile(record.path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unrecognized";
  }
  return raw.split(/\r?\n/, 1)[0] === KIT_BANNER ? "present" : "unrecognized";
}

export function recoveryKitRecordPath(accountId: string): string {
  return recordPath(accountId);
}

async function writeRecoveryKitRecord(accountId: string, record: RecoveryKitRecord): Promise<void> {
  const file = recordPath(accountId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: DIR_MODE });
  await secretSafeWrite(file, `${JSON.stringify(record, null, 2)}\n`);
}

async function secretSafeWrite(file: string, data: string): Promise<void> {
  const dir = path.dirname(file);
  const existing = await fs.lstat(file).catch((e) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  });
  if (existing?.isSymbolicLink()) throw new Error(`refusing to write recovery kit through a symlink: ${file}`);
  if (existing && !existing.isFile()) throw new Error(`refusing to replace non-file recovery kit path: ${file}`);

  await writeFileAtomic(file, data, { flag: "wx", mode: FILE_MODE });
  await fs.chmod(file, FILE_MODE).catch(() => {});
}

function recordPath(accountId: string): string {
  const home = process.env.RBOX_HOME || os.homedir();
  return path.join(home, ".rbox", "e2ee", accountId, "kit.json");
}

function resolveUserPath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith(`~${path.sep}`) || p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

export function accountHex16(accountId: string): string {
  const match = accountId.match(/^acct_([0-9a-f]{16})$/i);
  if (!match) throw new Error(`account id does not contain a 16-hex suffix: ${accountId}`);
  return match[1]!.toLowerCase();
}

export function localYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function localIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const sec = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}:${sec}`;
}
