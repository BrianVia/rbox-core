/** Exact compatibility wire for the legacy auth commands.
 *
 * These helpers intentionally return raw Responses. Retry policy, response
 * interpretation, and user-facing errors belong to the command workflows.
 */
import { fetchWithDeadline } from "./resilient.js";

function postJson(url: string, body: unknown, token?: string): Promise<Response> {
  return fetchWithDeadline(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

export function startDeviceAuth(
  remoteUrl: string,
  body: { label: string; encPubKey?: string; sigPubKey?: string },
): Promise<Response> {
  return postJson(`${remoteUrl}/v1/auth/device/start`, body);
}

export function pollDeviceAuth(remoteUrl: string, deviceCode: string): Promise<Response> {
  return postJson(`${remoteUrl}/v1/auth/device/poll`, { deviceCode });
}

export function bootstrapDeviceAuth(
  remoteUrl: string,
  body: { secret: string; label: string; plan?: string },
): Promise<Response> {
  return postJson(`${remoteUrl}/v1/auth/device/bootstrap`, body);
}

export function acknowledgeKeyDeliveryAuth(
  remoteUrl: string,
  requestId: string,
  token: string,
): Promise<Response> {
  return postJson(`${remoteUrl}/v1/auth/key-delivery/ack`, { requestId }, token);
}

export function approveDeviceAuth(remoteUrl: string, userCode: string, token: string): Promise<Response> {
  return postJson(`${remoteUrl}/v1/auth/device/approve`, { userCode }, token);
}

export function listDevicesAuth(remoteUrl: string, token: string): Promise<Response> {
  return fetchWithDeadline(`${remoteUrl}/v1/auth/devices`, { headers: { authorization: `Bearer ${token}` } });
}

export function createPairAuth(
  remoteUrl: string,
  body: { tokenId: string; mkWrap: string; admissionGrant: string },
  token: string,
): Promise<Response> {
  return postJson(`${remoteUrl}/v1/auth/pair/create`, body, token);
}

export function revokeDeviceAuth(remoteUrl: string, deviceId: string, token: string): Promise<Response> {
  return postJson(`${remoteUrl}/v1/auth/devices/${deviceId}/revoke`, {}, token);
}
