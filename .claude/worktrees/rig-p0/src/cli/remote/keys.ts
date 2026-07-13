import type { AccountKeysDTO } from "../e2ee-remote.js";
import { AccountAlreadyBootstrappedError, PAIR_TOKEN_MINT_RERUN_HINT, translateRemoteError } from "./errors.js";
import type { RemoteContext } from "./context.js";

// ---- E2EE key + signed-commit transport (design 12 §13.2) ----------------

export async function bootstrapKeys(ctx: RemoteContext, body: unknown): Promise<void> {
  const r = await ctx.postJson("/v1/keys/bootstrap", body, { op: "setting up account keys" });
  if (r.ok) return;
  const text = await r.text();
  if (r.status === 409) {
    try {
      if ((JSON.parse(text) as { error?: string }).error === "already_bootstrapped") throw new AccountAlreadyBootstrappedError();
    } catch (err) {
      if (err instanceof AccountAlreadyBootstrappedError) throw err;
    }
  }
  throw new Error(translateRemoteError(r.status, "keys/bootstrap failed", text, "account key setup not found"));
}

export async function getAccountKeys(ctx: RemoteContext): Promise<AccountKeysDTO | null> {
  const r = await ctx.fetch(`${ctx.baseUrl}/v1/keys/account`, { headers: ctx.auth }, { op: "fetching account keys" });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(translateRemoteError(r.status, "keys/account failed", undefined, "account keys not found"));
  return (await r.json()) as AccountKeysDTO;
}

export async function putDeviceKeys(ctx: RemoteContext, body: unknown): Promise<void> {
  const r = await ctx.postJson("/v1/keys/device", body, { op: "publishing device keys" });
  if (!r.ok) throw new Error(translateRemoteError(r.status, "keys/device failed", await r.text(), "account keys not found"));
}

/** Atomic device-keys + roster admission (C5). 409 → caller refetches + retries. */
export async function admitDevice(ctx: RemoteContext, body: unknown): Promise<{ ok: boolean; conflict?: boolean }> {
  const r = await ctx.postJson("/v1/keys/admit", body, { op: "admitting this device" });
  if (r.status === 409) return { ok: false, conflict: true };
  if (!r.ok) throw new Error(translateRemoteError(r.status, "keys/admit failed", await r.text(), "account keys not found"));
  return { ok: true };
}

export async function appendRoster(ctx: RemoteContext, body: unknown): Promise<{ ok: boolean; conflict?: boolean }> {
  const r = await ctx.postJson("/v1/keys/roster", body, { op: "updating the device roster" });
  if (r.status === 409) return { ok: false, conflict: true };
  if (!r.ok) throw new Error(translateRemoteError(r.status, "keys/roster failed", await r.text(), "account keys not found"));
  return { ok: true };
}

export async function getWorkspaceKeys(ctx: RemoteContext, workspaceId: string): Promise<Array<{ keyEpoch: number; kekWrap: string }>> {
  const r = await ctx.fetch(`${ctx.baseUrl}/v1/keys/workspace/${workspaceId}`, { headers: ctx.auth }, { op: "fetching workspace keys" });
  if (!r.ok) throw new Error(translateRemoteError(r.status, "keys/workspace GET failed", undefined, "workspace not found — check you're in the right directory"));
  return ((await r.json()) as { keys: Array<{ keyEpoch: number; kekWrap: string }> }).keys;
}

export async function putWorkspaceKey(ctx: RemoteContext, workspaceId: string, keyEpoch: number, kekWrap: string): Promise<{ keyEpoch: number; kekWrap: string }> {
  const r = await ctx.postJson("/v1/keys/workspace", { workspaceId, keyEpoch, kekWrap }, { op: "publishing the workspace key" });
  if (!r.ok) throw new Error(translateRemoteError(r.status, "keys/workspace POST failed", await r.text(), "workspace not found — check you're in the right directory"));
  return (await r.json()) as { keyEpoch: number; kekWrap: string };
}

// ---- pairing (split-secret; tokenSecret never sent — design 12 §13.5) -----

export async function pairCreate(ctx: RemoteContext, body: { tokenId: string; mkWrap: string; admissionGrant: string }): Promise<{ token: string }> {
  // NOT auto-retried (retries: 0): mints a pairing token; a retry after a socket-close-post-success
  // could create a second token. Off the sync hot path — a transient here just fails the pair and
  // the user re-runs the command. Still gets the timeout deadline.
  const r = await ctx.postJson("/v1/auth/pair/create", body, { retries: 0, op: "creating a pairing token", rerunHint: PAIR_TOKEN_MINT_RERUN_HINT });
  if (!r.ok) throw new Error(translateRemoteError(r.status, "pair/create failed", await r.text(), "pairing token not found"));
  return (await r.json()) as { token: string };
}

// ---- agent/API key management --------------------------------------------

export interface CreateApiKeyBody {
  tokenHash: string;
  deviceId: string;
  expiresAt: number;
  label?: string;
  displayPrefix: string;
  enrolled: true;
}

export interface ApiKeyRow {
  deviceId: string;
  label: string | null;
  displayPrefix: string;
  createdAt: number;
  lastSeenAt: number | null;
  expiresAt: number;
  revoked: boolean;
}

export async function createApiKey(ctx: RemoteContext, body: CreateApiKeyBody): Promise<{ deviceId: string; expiresAt: number }> {
  const r = await ctx.postJson("/v1/keys/api", body, { retries: 0, op: "creating an agent key" });
  if (!r.ok) throw new Error(translateRemoteError(r.status, "key create failed", await r.text(), "agent key route not found"));
  return (await r.json()) as { deviceId: string; expiresAt: number };
}

export async function listApiKeys(ctx: RemoteContext): Promise<ApiKeyRow[]> {
  const r = await ctx.fetch(`${ctx.baseUrl}/v1/keys/api`, { headers: ctx.auth }, { op: "listing agent keys" });
  if (!r.ok) throw new Error(translateRemoteError(r.status, "key list failed", await r.text(), "agent key route not found"));
  return ((await r.json()) as { keys: ApiKeyRow[] }).keys;
}

export async function revokeApiKey(ctx: RemoteContext, deviceId: string): Promise<void> {
  const r = await ctx.postJson(`/v1/keys/api/${encodeURIComponent(deviceId)}/revoke`, {}, { retries: 0, op: "revoking an agent key" });
  if (!r.ok) throw new Error(translateRemoteError(r.status, "key revoke failed", await r.text(), "agent key not found"));
}
