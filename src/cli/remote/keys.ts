import type { AccountKeysDTO, GenesisAccountObservation, GenesisPresence } from "../e2ee-remote.js";
import { AccountAlreadyBootstrappedError, errorCode, GenesisBootstrapTerminalError, LegacyGenesisServiceError, translateRemoteError } from "./errors.js";
import type { RemoteContext } from "./context.js";
import type { JsonObject } from "../../json.js";

// ---- E2EE key + signed-commit transport (design 12 §13.2) ----------------

export async function bootstrapKeys(ctx: RemoteContext, body: unknown): Promise<void> {
  const r = typeof body === "string" ? await ctx.postExactJson("/v1/keys/bootstrap",body,{op:"setting up account keys"}) : await ctx.postExactJson("/v1/keys/bootstrap",JSON.stringify(body),{op:"setting up account keys"});
  if (r.ok) return;
  const text = await r.text();
  if (r.status === 410) {
    const code = errorCode(text) ?? "account_erased";
    throw new GenesisBootstrapTerminalError(410, code, "this account no longer exists; its encrypted data has been erased");
  }
  if (r.status >= 400 && r.status < 500 && r.status !== 409 && r.status !== 423 && r.status !== 428 && r.status !== 429) {
    throw new GenesisBootstrapTerminalError(r.status, "bootstrap_rejected", translateRemoteError(r.status, "keys/bootstrap failed", text, "account key setup not found"));
  }
  if (r.status === 409) {
    if (errorCode(text) === "already_bootstrapped") throw new AccountAlreadyBootstrappedError();
  }
  throw new Error(translateRemoteError(r.status, "keys/bootstrap failed", text, "account key setup not found"));
}

export async function getAccountKeys(ctx: RemoteContext, signal?: AbortSignal): Promise<AccountKeysDTO | null> {
  const r=await ctx.fetch(`${ctx.baseUrl}/v1/keys/account`,{headers:{...ctx.auth,"x-rbox-genesis-capability":"1"}},{op:"fetching account keys",signal});
  if(r.status===404)return null;if(!r.ok)throw new Error(translateRemoteError(r.status,"keys/account failed",undefined,"account keys not found"));return await r.json() as AccountKeysDTO;
}

const keys=(value:object,expected:string[])=>{const actual=Object.keys(value);return actual.length===expected.length&&actual.every((k)=>expected.includes(k));};
const plain=(value:unknown):value is JsonObject=>typeof value==="object"&&value!==null&&!Array.isArray(value);
function parsePresence(value:unknown):GenesisPresence{if(!plain(value)||!keys(value,["rosters","keyStates","devices","workspaces","workspaceKeys","e2eePairingTokens"]))throw new Error("invalid genesis presence");for(const n of Object.values(value))if(typeof n!=="number"||!Number.isSafeInteger(n)||n<0)throw new Error("invalid genesis presence count");return value as unknown as GenesisPresence;}
function legacyGenesisResponse(status:number,body:JsonObject):boolean{
  if(status===404)return keys(body,["error"])&&body.error==="not_found";
  if(status<200||status>=300||!keys(body,["recoveryWrap","recoveryWrapId","rosters","keyStates","devices"]))return false;
  return(body.recoveryWrap===null||typeof body.recoveryWrap==="string")&&(body.recoveryWrapId===null||typeof body.recoveryWrapId==="string")
    &&Array.isArray(body.rosters)&&Array.isArray(body.keyStates)&&Array.isArray(body.devices);
}

export async function getGenesisObservation(ctx:RemoteContext):Promise<GenesisAccountObservation>{
  const r=await ctx.fetch(`${ctx.baseUrl}/v1/keys/account`,{headers:{...ctx.auth,"x-rbox-genesis-capability":"1"}},{op:"fetching account keys"});
  if(r.status!==404&&!r.ok)throw new Error(translateRemoteError(r.status,"keys/account failed",undefined,"account keys not found"));
  const body=await r.json() as unknown;if(plain(body)&&!Object.hasOwn(body,"genesisPresenceVersion")&&legacyGenesisResponse(r.status,body))throw new LegacyGenesisServiceError();if(!plain(body)||body.genesisPresenceVersion!==1)throw new Error("unsupported or malformed genesis presence response");const present=parsePresence(body.present);
  if(r.status===404){if(!keys(body,["error","genesisPresenceVersion","present"])||body.error!=="not_found")throw new Error("malformed absent genesis observation");return{genesisPresenceVersion:1,claim:null,present};}
  const required=["genesisPresenceVersion","recoveryWrap","recoveryWrapId","claimCreatedAt","genesisDeviceId","rosters","keyStates","devices","present","repairTombstone"];
  if(!keys(body,required)||!Array.isArray(body.rosters)||!Array.isArray(body.keyStates)||!Array.isArray(body.devices)||body.rosters.length!==present.rosters||body.keyStates.length!==present.keyStates||body.devices.length!==present.devices)throw new Error("malformed genesis account observation");
  const tomb=body.repairTombstone;if(tomb!==null&&(!plain(tomb)||!keys(tomb,["version","repairId","repairedAt"])||tomb.version!==1||typeof tomb.repairId!=="string"||!/^gra_[0-9a-f]{32}$/.test(tomb.repairId)||typeof tomb.repairedAt!=="number"||!Number.isSafeInteger(tomb.repairedAt)||tomb.repairedAt<=0))throw new Error("malformed genesis repair tombstone");
  const claim=body as unknown as AccountKeysDTO;return{genesisPresenceVersion:1,claim,present,repairTombstone:tomb as GenesisAccountObservation extends {repairTombstone:infer T}?T:never};
}

export async function putDeviceKeys(ctx: RemoteContext, body: unknown): Promise<void> {
  const r = await ctx.postJson("/v1/keys/device", body, { op: "publishing device keys" });
  if (!r.ok) throw new Error(translateRemoteError(r.status, "keys/device failed", await r.text(), "account keys not found"));
}

/** Atomic device-keys + roster admission (C5). 409 → caller refetches + retries. */
export async function admitDevice(ctx: RemoteContext, body: unknown, signal?: AbortSignal): Promise<{ ok: boolean; conflict?: boolean }> {
  const r = await ctx.postJson("/v1/keys/admit", body, { op: "admitting this device", signal });
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
