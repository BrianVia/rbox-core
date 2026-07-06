import type { AccountKeysDTO } from "../e2ee-remote.js";
import { AccountAlreadyBootstrappedError, translateRemoteError } from "./errors.js";
import type { RemoteContext } from "./context.js";

// ---- E2EE key + signed-commit transport (design 12 §13.2) ----------------

export async function bootstrapKeys(ctx: RemoteContext, body: unknown): Promise<void> {
  const r = await ctx.postJson("/v1/keys/bootstrap", body);
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
  const r = await fetch(`${ctx.baseUrl}/v1/keys/account`, { headers: ctx.auth });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(translateRemoteError(r.status, "keys/account failed", undefined, "account keys not found"));
  return (await r.json()) as AccountKeysDTO;
}

export async function putDeviceKeys(ctx: RemoteContext, body: unknown): Promise<void> {
  const r = await ctx.postJson("/v1/keys/device", body);
  if (!r.ok) throw new Error(translateRemoteError(r.status, "keys/device failed", await r.text(), "account keys not found"));
}

/** Atomic device-keys + roster admission (C5). 409 → caller refetches + retries. */
export async function admitDevice(ctx: RemoteContext, body: unknown): Promise<{ ok: boolean; conflict?: boolean }> {
  const r = await ctx.postJson("/v1/keys/admit", body);
  if (r.status === 409) return { ok: false, conflict: true };
  if (!r.ok) throw new Error(translateRemoteError(r.status, "keys/admit failed", await r.text(), "account keys not found"));
  return { ok: true };
}

export async function appendRoster(ctx: RemoteContext, body: unknown): Promise<{ ok: boolean; conflict?: boolean }> {
  const r = await ctx.postJson("/v1/keys/roster", body);
  if (r.status === 409) return { ok: false, conflict: true };
  if (!r.ok) throw new Error(translateRemoteError(r.status, "keys/roster failed", await r.text(), "account keys not found"));
  return { ok: true };
}

export async function getWorkspaceKeys(ctx: RemoteContext, workspaceId: string): Promise<Array<{ keyEpoch: number; kekWrap: string }>> {
  const r = await fetch(`${ctx.baseUrl}/v1/keys/workspace/${workspaceId}`, { headers: ctx.auth });
  if (!r.ok) throw new Error(translateRemoteError(r.status, "keys/workspace GET failed", undefined, "workspace not found — check you're in the right directory"));
  return ((await r.json()) as { keys: Array<{ keyEpoch: number; kekWrap: string }> }).keys;
}

export async function putWorkspaceKey(ctx: RemoteContext, workspaceId: string, keyEpoch: number, kekWrap: string): Promise<{ keyEpoch: number; kekWrap: string }> {
  const r = await ctx.postJson("/v1/keys/workspace", { workspaceId, keyEpoch, kekWrap });
  if (!r.ok) throw new Error(translateRemoteError(r.status, "keys/workspace POST failed", await r.text(), "workspace not found — check you're in the right directory"));
  return (await r.json()) as { keyEpoch: number; kekWrap: string };
}

// ---- pairing (split-secret; tokenSecret never sent — design 12 §13.5) -----

export async function pairCreate(ctx: RemoteContext, body: { tokenId: string; mkWrap: string; admissionGrant: string }): Promise<{ token: string }> {
  const r = await ctx.postJson("/v1/auth/pair/create", body);
  if (!r.ok) throw new Error(translateRemoteError(r.status, "pair/create failed", await r.text(), "pairing token not found"));
  return (await r.json()) as { token: string };
}
