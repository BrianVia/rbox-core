import type { AccountKeysDTO } from "../e2ee-remote.js";
import { AccountAlreadyBootstrappedError } from "./errors.js";
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
  throw new Error(`keys/bootstrap failed: ${r.status} ${text}`);
}

export async function getAccountKeys(ctx: RemoteContext): Promise<AccountKeysDTO | null> {
  const r = await fetch(`${ctx.baseUrl}/v1/keys/account`, { headers: ctx.auth });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`keys/account failed: ${r.status}`);
  return (await r.json()) as AccountKeysDTO;
}

export async function putDeviceKeys(ctx: RemoteContext, body: unknown): Promise<void> {
  const r = await ctx.postJson("/v1/keys/device", body);
  if (!r.ok) throw new Error(`keys/device failed: ${r.status} ${await r.text()}`);
}

/** Atomic device-keys + roster admission (C5). 409 → caller refetches + retries. */
export async function admitDevice(ctx: RemoteContext, body: unknown): Promise<{ ok: boolean; conflict?: boolean }> {
  const r = await ctx.postJson("/v1/keys/admit", body);
  if (r.status === 409) return { ok: false, conflict: true };
  if (!r.ok) throw new Error(`keys/admit failed: ${r.status} ${await r.text()}`);
  return { ok: true };
}

export async function appendRoster(ctx: RemoteContext, body: unknown): Promise<{ ok: boolean; conflict?: boolean }> {
  const r = await ctx.postJson("/v1/keys/roster", body);
  if (r.status === 409) return { ok: false, conflict: true };
  if (!r.ok) throw new Error(`keys/roster failed: ${r.status} ${await r.text()}`);
  return { ok: true };
}

export async function getWorkspaceKeys(ctx: RemoteContext, workspaceId: string): Promise<Array<{ keyEpoch: number; kekWrap: string }>> {
  const r = await fetch(`${ctx.baseUrl}/v1/keys/workspace/${workspaceId}`, { headers: ctx.auth });
  if (!r.ok) throw new Error(`keys/workspace GET failed: ${r.status}`);
  return ((await r.json()) as { keys: Array<{ keyEpoch: number; kekWrap: string }> }).keys;
}

export async function putWorkspaceKey(ctx: RemoteContext, workspaceId: string, keyEpoch: number, kekWrap: string): Promise<{ keyEpoch: number; kekWrap: string }> {
  const r = await ctx.postJson("/v1/keys/workspace", { workspaceId, keyEpoch, kekWrap });
  if (!r.ok) throw new Error(`keys/workspace POST failed: ${r.status} ${await r.text()}`);
  return (await r.json()) as { keyEpoch: number; kekWrap: string };
}

// ---- pairing (split-secret; tokenSecret never sent — design 12 §13.5) -----

export async function pairCreate(ctx: RemoteContext, body: { tokenId: string; mkWrap: string; admissionGrant: string }): Promise<{ token: string }> {
  const r = await ctx.postJson("/v1/auth/pair/create", body);
  if (!r.ok) throw new Error(`pair/create failed: ${r.status} ${await r.text()}`);
  return (await r.json()) as { token: string };
}
