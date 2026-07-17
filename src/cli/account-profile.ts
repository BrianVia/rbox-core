import fs from "node:fs/promises";
import path from "node:path";
import { rboxDir } from "./rbox-paths.js";

/** Non-secret, best-effort display metadata cached outside credentials.json. */
export interface AccountProfile {
  accountId: string;
  email: string | null;
  signInMethod: string | null;
  plan: string | null;
}

type AccountProfileWrite = Omit<AccountProfile, "plan"> & { plan?: string | null };

const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/;
export const accountProfilePath = (): string => path.join(rboxDir(), "account-profile.json");

/** A renderable identity field, or null for absent/malformed/terminal-unsafe input. */
export function identityField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && !CONTROL_CHAR.test(value) ? value : null;
}

export function validateProfile(value: unknown): AccountProfile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<AccountProfile>;
  const accountId = identityField(candidate.accountId);
  const email = candidate.email === null ? null : identityField(candidate.email);
  const signInMethod = candidate.signInMethod === null ? null : identityField(candidate.signInMethod);
  const plan = candidate.plan == null ? null : identityField(candidate.plan);
  if (!accountId
    || (candidate.email !== null && !email)
    || (candidate.signInMethod !== null && !signInMethod)
    || (candidate.plan != null && !plan)) return undefined;
  return { accountId, email, signInMethod, plan };
}

function parseProfile(raw: string): AccountProfile | undefined {
  try {
    return validateProfile(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export async function readAccountProfile(accountId: string): Promise<AccountProfile | undefined> {
  try {
    const profile = parseProfile(await fs.readFile(accountProfilePath(), "utf8"));
    return profile?.accountId === accountId ? profile : undefined;
  } catch {
    return undefined;
  }
}

async function persistAccountProfile(profile: AccountProfile): Promise<void> {
  await fs.mkdir(rboxDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(accountProfilePath(), `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(accountProfilePath(), 0o600).catch(() => {});
}

let profileOperations: Promise<void> = Promise.resolve();

/** Queue a failure-absorbing cache write without delaying the caller's result. */
export function scheduleAccountProfileWrite(profile: AccountProfileWrite): void {
  const normalized = validateProfile(profile);
  if (!normalized) return;
  profileOperations = profileOperations.then(() => persistAccountProfile(normalized)).catch(() => {});
}

/** Test/process-lifecycle seam: wait for all profile work queued so far. */
export async function flushAccountProfileWrites(): Promise<void> {
  await profileOperations;
}

/** Ordered after older writes so logout cannot be undone by queued cache work. */
export async function clearAccountProfile(): Promise<void> {
  profileOperations = profileOperations.then(() => fs.rm(accountProfilePath(), { force: true })).catch(() => {});
  await profileOperations;
}

/** Human identity from the local profile cache; never performs network I/O. */
export async function getIdentity(accountId: string): Promise<{ email: string; signInMethod: string | null } | undefined> {
  const profile = await readAccountProfile(accountId);
  if (!profile?.email) return undefined;
  return { email: profile.email, signInMethod: profile.signInMethod };
}

/** Preferred text identity, falling back to a sign-in method when email is absent. */
export function identityText(email: string | null | undefined, signInMethod: string | null | undefined): string | undefined {
  return email ? `${email}${signInMethod ? ` (${signInMethod})` : ""}` : signInMethod || undefined;
}
