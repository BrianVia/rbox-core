import { eq, type RouteCtx } from "./shared.js";
import { createApiKey, listApiKeys, revokeApiKey } from "../auth.js";
import { API_KEY_CREATE_MAX_BYTES, validateApiKeyBody } from "../auth/api-keys.js";
import {
  admitDevice,
  appendKeyState,
  appendRoster,
  bootstrapAccountKeys,
  getAccountKeys,
  getWorkspaceKeys,
  putDeviceKeys,
  putWorkspaceKey,
  KEY_ADMIT_MAX_BYTES,
  KEY_BOOTSTRAP_MAX_BYTES,
  KEY_DEVICE_MAX_BYTES,
  KEY_ROSTER_MAX_BYTES,
  KEY_STATE_MAX_BYTES,
  KEY_WORKSPACE_MAX_BYTES,
  validateKeyAdmitBody,
  validateKeyBootstrapBody,
  validateKeyDeviceBody,
  validateKeyRosterBody,
  validateKeyStateBody,
  validateWorkspaceKeyBody,
} from "../keys.js";
import type { Principal } from "../authz.js";
import { cappedJson } from "../util.js";
import type { JsonValue } from "../../../../src/json.js";

async function parsed<T>(req: Request, maxBytes: number, validate: (value: JsonValue) => T | null): Promise<T | Response> {
  const result = await cappedJson(req, { maxBytes }, validate);
  return result.ok ? result.value : result.response;
}

/** E2EE opaque key storage routes. Parsing is bounded before domain semantics. */
export async function keysRoutes({ req, env, seg }: RouteCtx, p: Principal): Promise<Response | null> {
  if (seg[0] === "v1" && seg[1] === "keys") {
    if (req.method === "POST" && eq(seg, ["v1", "keys", "api"])) {
      const body = await parsed(req, API_KEY_CREATE_MAX_BYTES, validateApiKeyBody);
      return body instanceof Response ? body : createApiKey(env, p, body);
    }
    if (req.method === "GET" && eq(seg, ["v1", "keys", "api"])) return listApiKeys(env, p);
    if (req.method === "POST" && seg.length === 5 && seg[2] === "api" && seg[4] === "revoke") return revokeApiKey(env, p, seg[3]!);
    if (req.method === "POST" && eq(seg, ["v1", "keys", "bootstrap"])) {
      const body = await parsed(req, KEY_BOOTSTRAP_MAX_BYTES, validateKeyBootstrapBody);
      return body instanceof Response ? body : bootstrapAccountKeys(env, p, body, req.headers.get("x-rbox-genesis-capability"));
    }
    if (req.method === "GET" && eq(seg, ["v1", "keys", "account"])) return getAccountKeys(env, p);
    if (req.method === "POST" && eq(seg, ["v1", "keys", "device"])) {
      const body = await parsed(req, KEY_DEVICE_MAX_BYTES, validateKeyDeviceBody);
      return body instanceof Response ? body : putDeviceKeys(env, p, body);
    }
    if (req.method === "POST" && eq(seg, ["v1", "keys", "roster"])) {
      const body = await parsed(req, KEY_ROSTER_MAX_BYTES, validateKeyRosterBody);
      return body instanceof Response ? body : appendRoster(env, p, body);
    }
    if (req.method === "POST" && eq(seg, ["v1", "keys", "admit"])) {
      const body = await parsed(req, KEY_ADMIT_MAX_BYTES, validateKeyAdmitBody);
      return body instanceof Response ? body : admitDevice(env, p, body);
    }
    if (req.method === "POST" && eq(seg, ["v1", "keys", "keystate"])) {
      const body = await parsed(req, KEY_STATE_MAX_BYTES, validateKeyStateBody);
      return body instanceof Response ? body : appendKeyState(env, p, body);
    }
    if (req.method === "POST" && eq(seg, ["v1", "keys", "workspace"])) {
      const body = await parsed(req, KEY_WORKSPACE_MAX_BYTES, validateWorkspaceKeyBody);
      return body instanceof Response ? body : putWorkspaceKey(env, p, body);
    }
    if (req.method === "GET" && seg.length === 4 && seg[2] === "workspace") return getWorkspaceKeys(env, p, seg[3]!);
  }
  return null;
}
