#!/usr/bin/env bun
/**
 * Mint and burn disposable accounts through the real dev Clerk → rbox web-login path.
 *
 * This tool is intentionally locked to the deployed dev worker and a Clerk test key.
 * It never accepts a URL flag or a generic CLERK_SECRET_KEY.
 */
import path from "node:path";
import { resolveSecretFileKey } from "../rig/lib/account.js";

export const DEV_API = "https://rbox-dev-api.brian-via.workers.dev";
export const DEV_CLERK_ISSUER = "https://cosmic-phoenix-51.clerk.accounts.dev";
const DEV_BROWSER_ORIGIN = "http://localhost:5173";
const CLERK_API = "https://api.clerk.com/v1";
const CLERK_SECRET_KEY = "CLERK_DEV_SECRET_KEY";
const REPO_ROOT = path.resolve(import.meta.dir, "../..");

const HELP = `Disposable rbox dev-account lifecycle

Usage:
  RBOX_API=${DEV_API} bun scripts/e2e/mint-account.ts mint
  RBOX_API=${DEV_API} bun scripts/e2e/mint-account.ts burn <accountId>
  bun scripts/e2e/mint-account.ts --help

mint
  Creates a verified e2e+<nonce>@rbox.to user in the dev Clerk instance,
  creates a Clerk session, exchanges its JWT through POST /v1/web/session
  (the real browser first-login path), and prints JSON containing accountId,
  email, and the short-lived rbox web sessionToken.

burn <accountId>
  Resolves the disposable Clerk user, re-enters the real web-session path,
  calls owner-only DELETE /v1/account, then verifies the account is no longer
  reachable. Hard purge remains subject to the API's deletion grace period.

Required:
  RBOX_API must be set to exactly the deployed dev worker above.
  ${CLERK_SECRET_KEY}=sk_test_... must exist in dev-keys.local.secret at the
  repo root (the primary checkout is checked when running from a worktree).

Safety:
  Production, localhost, alternate workers, URL credentials/paths/queries,
  unset RBOX_API, and sk_live keys are refused. Generic CLERK_SECRET_KEY is ignored.`;

interface ClerkUser {
  id: string;
  external_id?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: Array<{ id?: string; email_address?: string; verification?: { status?: string } | null }>;
  private_metadata?: Record<string, unknown>;
}

interface WebSession {
  token: string;
  accountId: string;
}

/** Exact target guard. Exported so the refusal matrix is unit-tested without I/O. */
export function resolveTargetApi(env: Pick<NodeJS.ProcessEnv, "RBOX_API">): string {
  const raw = env.RBOX_API?.trim();
  if (!raw) throw new Error(`refusing to run: RBOX_API must be set to ${DEV_API}`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`refusing to run: invalid RBOX_API (expected ${DEV_API})`);
  }
  const rootPath = url.pathname === "" || url.pathname === "/";
  if (url.origin !== DEV_API || !rootPath || url.username || url.password || url.search || url.hash) {
    throw new Error(`refusing non-dev target: RBOX_API must be exactly ${DEV_API}`);
  }
  return DEV_API;
}

/** A Clerk development key is structurally distinct from every production key. */
export function assertDevClerkSecret(secret: string): void {
  if (!secret.startsWith("sk_test_") || secret.length <= "sk_test_".length) {
    throw new Error(`refusing Clerk key: ${CLERK_SECRET_KEY} must be a non-empty sk_test_ development key`);
  }
}

/** Defense in depth for burn: only identities minted and tagged by this tool qualify. */
export function assertDisposableClerkUser(user: ClerkUser, accountId: string): void {
  const primary = user.email_addresses?.find((email) => email.id === user.primary_email_address_id);
  const marked = user.private_metadata?.rbox_e2e_disposable === true
    && user.private_metadata?.rbox_account_id === accountId;
  if (user.external_id !== accountId || !marked || primary?.verification?.status !== "verified"
    || !/^e2e\+[a-z0-9-]+@rbox\.to$/.test(primary.email_address ?? "")) {
    throw new Error(`refusing burn: Clerk identity for ${accountId} is not a verified disposable e2e user`);
  }
}

function clerkSecret(): string {
  const secret = resolveSecretFileKey(REPO_ROOT, CLERK_SECRET_KEY);
  assertDevClerkSecret(secret);
  return secret;
}

function responseDetail(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine ? `: ${oneLine.slice(0, 500)}` : "";
}

async function jsonRequest<T>(label: string, input: string, init: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} failed (${res.status})${responseDetail(text)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function clerkHeaders(secret: string): HeadersInit {
  return {
    authorization: `Bearer ${secret}`,
    "content-type": "application/json",
    origin: DEV_BROWSER_ORIGIN,
  };
}

async function createClerkUser(secret: string, email: string): Promise<ClerkUser> {
  return jsonRequest<ClerkUser>("Clerk user creation", `${CLERK_API}/users`, {
    method: "POST",
    headers: clerkHeaders(secret),
    body: JSON.stringify({ email_address: [email], skip_password_requirement: true }),
  });
}

async function createClerkJwt(secret: string, userId: string): Promise<string> {
  const session = await jsonRequest<{ id?: string }>("Clerk session creation", `${CLERK_API}/sessions`, {
    method: "POST",
    headers: clerkHeaders(secret),
    body: JSON.stringify({ user_id: userId }),
  });
  if (!session.id) throw new Error("Clerk session creation returned no session id");
  const token = await jsonRequest<{ jwt?: string }>("Clerk session token creation", `${CLERK_API}/sessions/${encodeURIComponent(session.id)}/tokens`, {
    method: "POST",
    headers: clerkHeaders(secret),
    body: JSON.stringify({ expires_in_seconds: 300 }),
  });
  if (!token.jwt) throw new Error("Clerk session token creation returned no JWT");
  assertDevClerkJwt(token.jwt);
  return token.jwt;
}

function assertDevClerkJwt(jwt: string): void {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as { iss?: unknown; azp?: unknown };
    if (payload.iss !== DEV_CLERK_ISSUER) throw new Error(`unexpected issuer ${String(payload.iss)}`);
    // Backend-minted session tokens carry no azp claim; a present azp must
    // still match the dev dashboard origin (never a prod origin).
    if (payload.azp !== undefined && payload.azp !== DEV_BROWSER_ORIGIN) throw new Error(`unexpected authorized party ${String(payload.azp)}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`refusing Clerk JWT: expected dev issuer and ${DEV_BROWSER_ORIGIN} azp (${detail})`);
  }
}

async function exchangeWebSession(api: string, clerkJwt: string): Promise<WebSession> {
  const session = await jsonRequest<Partial<WebSession>>("rbox first-login exchange", `${api}/v1/web/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: DEV_BROWSER_ORIGIN },
    body: JSON.stringify({ token: clerkJwt }),
  });
  if (!session.token || !session.accountId) throw new Error("rbox first-login exchange returned incomplete credentials");
  return { token: session.token, accountId: session.accountId };
}

async function accountStatus(api: string, token: string): Promise<{ status: number; accountId?: string; linked?: boolean }> {
  const res = await fetch(`${api}/v1/account/status`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return { status: res.status };
  const body = (await res.json()) as { accountId?: string; linked?: boolean };
  return { status: res.status, accountId: body.accountId, linked: body.linked };
}

async function tagClerkUser(secret: string, userId: string, accountId: string): Promise<void> {
  // Clerk split these surfaces: external_id lives on PATCH /users/{id};
  // private_metadata is deprecated there and lives on PATCH /users/{id}/metadata.
  await jsonRequest<ClerkUser>("Clerk external-id tagging", `${CLERK_API}/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: clerkHeaders(secret),
    body: JSON.stringify({ external_id: accountId }),
  });
  await jsonRequest<ClerkUser>("Clerk disposable-user tagging", `${CLERK_API}/users/${encodeURIComponent(userId)}/metadata`, {
    method: "PATCH",
    headers: clerkHeaders(secret),
    body: JSON.stringify({
      private_metadata: { rbox_e2e_disposable: true, rbox_account_id: accountId },
    }),
  });
}

async function deleteClerkUser(secret: string, userId: string): Promise<void> {
  const res = await fetch(`${CLERK_API}/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: clerkHeaders(secret),
  });
  if (!res.ok && res.status !== 404) throw new Error(`Clerk cleanup failed (${res.status})`);
}

async function findClerkUser(secret: string, accountId: string): Promise<ClerkUser> {
  const query = new URLSearchParams({ external_id: accountId, limit: "2" });
  const result = await jsonRequest<ClerkUser[] | { data?: ClerkUser[] }>("Clerk disposable-user lookup", `${CLERK_API}/users?${query}`, {
    headers: clerkHeaders(secret),
  });
  const users = Array.isArray(result) ? result : result.data ?? [];
  const exact = users.filter((user) => user.external_id === accountId);
  if (exact.length !== 1) throw new Error(`expected one disposable Clerk user for ${accountId}, found ${exact.length}`);
  const user = exact[0]!;
  assertDisposableClerkUser(user, accountId);
  return user;
}

async function requestAccountDeletion(api: string, token: string, accountId: string): Promise<{ status: string; deletedAt: number; purgeAfter: number }> {
  return jsonRequest("account deletion", `${api}/v1/account`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ confirm: accountId }),
  });
}

export async function mint(api: string, secret: string): Promise<{ accountId: string; email: string; sessionToken: string }> {
  const nonce = `${Date.now().toString(36)}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const email = `e2e+${nonce}@rbox.to`;
  let user: ClerkUser | undefined;
  let web: WebSession | undefined;
  try {
    user = await createClerkUser(secret, email);
    if (!user.id) throw new Error("Clerk user creation returned no user id");
    const clerkJwt = await createClerkJwt(secret, user.id);
    web = await exchangeWebSession(api, clerkJwt);
    const status = await accountStatus(api, web.token);
    if (status.status !== 200 || status.accountId !== web.accountId || status.linked !== true) {
      throw new Error(`first-login status verification failed (${status.status})`);
    }
    await tagClerkUser(secret, user.id, web.accountId);
    return { accountId: web.accountId, email, sessionToken: web.token };
  } catch (error) {
    if (web) await requestAccountDeletion(api, web.token, web.accountId).catch(() => {});
    if (user?.id) await deleteClerkUser(secret, user.id).catch(() => {});
    throw error;
  }
}

export async function burn(api: string, secret: string, accountId: string): Promise<{ accountId: string; status: string; purgeAfter: number; verified: string }> {
  if (!/^acct_[0-9a-f]{16}$/.test(accountId)) throw new Error("burn requires an acct_<16 lowercase hex> account id");
  const user = await findClerkUser(secret, accountId);
  const clerkJwt = await createClerkJwt(secret, user.id);
  const web = await exchangeWebSession(api, clerkJwt);
  if (web.accountId !== accountId) throw new Error(`refusing burn: Clerk identity resolved to ${web.accountId}, not ${accountId}`);
  const before = await accountStatus(api, web.token);
  if (before.status !== 200 || before.accountId !== accountId) throw new Error(`pre-burn account verification failed (${before.status})`);
  const deleted = await requestAccountDeletion(api, web.token, accountId);
  if (deleted.status !== "pending" || !Number.isFinite(deleted.deletedAt) || !Number.isFinite(deleted.purgeAfter)
    || deleted.purgeAfter <= deleted.deletedAt) {
    throw new Error("account deletion returned an invalid pending-deletion receipt");
  }
  const after = await accountStatus(api, web.token);
  if (after.status !== 401) throw new Error(`burn verification failed: deleted account remained reachable (${after.status})`);
  return { accountId, status: deleted.status, purgeAfter: deleted.purgeAfter, verified: "account_inaccessible" };
}

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [command, accountId, ...extra] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(HELP);
    return;
  }
  if ((command !== "mint" && command !== "burn") || extra.length > 0 || (command === "mint" && accountId) || (command === "burn" && !accountId)) {
    throw new Error("invalid arguments; run with --help for usage");
  }
  const api = resolveTargetApi(env);
  const secret = clerkSecret();
  const result = command === "mint" ? await mint(api, secret) : await burn(api, secret, accountId!);
  console.log(JSON.stringify(result));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`mint-account: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
