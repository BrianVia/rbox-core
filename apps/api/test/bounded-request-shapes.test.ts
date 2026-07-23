import { describe, expect, test } from "vitest";
import { BLOBS_CHECK_MAX_BYTES, validateBlobsCheckBody } from "../src/blobs.js";
import { validateWebSessionBody, WEB_SESSION_MAX_BYTES } from "../src/clerk.js";
import { DEVICE_BOOTSTRAP_MAX_BYTES, validateBootstrapBody } from "../src/auth/bootstrap.js";
import { DEVICE_APPROVE_MAX_BYTES, DEVICE_POLL_MAX_BYTES, DEVICE_START_MAX_BYTES, validateDeviceApproveBody, validateDevicePollBody, validateDeviceStartBody } from "../src/auth/device-code.js";
import { PAIR_CREATE_MAX_BYTES, PAIR_REDEEM_MAX_BYTES, validatePairCreateBody, validatePairRedeemBody } from "../src/auth/pairing.js";
import { LINK_CONFIRM_MAX_BYTES, LINK_REDEEM_MAX_BYTES, LINK_START_MAX_BYTES, validateLinkConfirmBody, validateLinkRedeemBody, validateLinkStartBody } from "../src/account-link.js";
import { API_KEY_CREATE_MAX_BYTES, validateApiKeyBody } from "../src/auth/api-keys.js";
import {
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
} from "../src/keys.js";
import { sanitizeWorkspaceName } from "../src/authz.js";
import { cappedJson, truncateCodePoints, utf8Bytes } from "../src/util.js";
import {
  KEY_DELIVERY_ACK_MAX_BYTES,
  KEY_DELIVERY_FETCH_MAX_BYTES,
  KEY_DELIVERY_SUBMIT_MAX_BYTES,
  KEY_DELIVERY_WRAP_MAX_BYTES,
  validateKeyDeliveryAckBody,
  validateKeyDeliveryFetchBody,
  validateKeyDeliverySubmitBody,
} from "../src/auth/key-delivery.js";

type Validator = (value: unknown) => unknown | null;
interface RouteCase {
  route: string;
  cap: number;
  valid: unknown;
  invalid: unknown;
  validate: Validator;
}

const sha = "a".repeat(64);
const jwtMax = `${"a".repeat(16_380)}.b.c`;
const jwtOver = `${"a".repeat(16_381)}.b.c`;
const opaqueMax = "😀".repeat(16_384); // exactly 65,536 UTF-8 bytes
const opaqueOver = `${opaqueMax}a`;
const device = { deviceId: opaqueMax, sigPubKey: opaqueMax, encPubKey: opaqueMax, mkWrap: opaqueMax };

const routes: RouteCase[] = [
  { route: "POST /v1/blobs/check", cap: BLOBS_CHECK_MAX_BYTES, valid: { shas: Array(250_000).fill(sha) }, invalid: { shas: Array(250_001).fill(sha) }, validate: validateBlobsCheckBody },
  { route: "POST /v1/web/session", cap: WEB_SESSION_MAX_BYTES, valid: { token: jwtMax }, invalid: { token: jwtOver }, validate: validateWebSessionBody },
  { route: "POST /v1/auth/device/start", cap: DEVICE_START_MAX_BYTES, valid: { label: "😀".repeat(150) }, invalid: { extra: true }, validate: validateDeviceStartBody },
  { route: "POST /v1/auth/device/poll", cap: DEVICE_POLL_MAX_BYTES, valid: { deviceCode: "a".repeat(64) }, invalid: { deviceCode: `${"a".repeat(64)}b` }, validate: validateDevicePollBody },
  { route: "POST /v1/auth/device/bootstrap", cap: DEVICE_BOOTSTRAP_MAX_BYTES, valid: { secret: "é".repeat(2048), label: "ok", accountName: "ok", plan: "pro" }, invalid: { secret: `${"é".repeat(2048)}a` }, validate: validateBootstrapBody },
  { route: "POST /v1/auth/device/approve", cap: DEVICE_APPROVE_MAX_BYTES, valid: { userCode: "ABCD-EFGH" }, invalid: { userCode: "ABCD-EFGH2" }, validate: validateDeviceApproveBody },
  { route: "POST /v1/auth/key-delivery/fetch", cap: KEY_DELIVERY_FETCH_MAX_BYTES, valid: { requestId: sha, keyReleaseOptIn: true }, invalid: { requestId: `${sha}a`, keyReleaseOptIn: true }, validate: validateKeyDeliveryFetchBody },
  { route: "POST /v1/auth/key-delivery/submit", cap: KEY_DELIVERY_SUBMIT_MAX_BYTES, valid: { requestId: sha, mkWrapDevice: "a".repeat(KEY_DELIVERY_WRAP_MAX_BYTES), publishedRosterVersion: Number.MAX_SAFE_INTEGER, accountEpoch: Number.MAX_SAFE_INTEGER }, invalid: { requestId: sha, mkWrapDevice: "a".repeat(KEY_DELIVERY_WRAP_MAX_BYTES + 1), publishedRosterVersion: 0, accountEpoch: 0 }, validate: validateKeyDeliverySubmitBody },
  { route: "POST /v1/auth/key-delivery/ack", cap: KEY_DELIVERY_ACK_MAX_BYTES, valid: { requestId: sha }, invalid: { requestId: `${sha}a` }, validate: validateKeyDeliveryAckBody },
  { route: "POST /v1/auth/pair/create", cap: PAIR_CREATE_MAX_BYTES, valid: { mkWrap: opaqueMax, admissionGrant: opaqueMax, tokenId: "x".repeat(64) }, invalid: { mkWrap: opaqueOver }, validate: validatePairCreateBody },
  { route: "POST /v1/auth/pair/redeem", cap: PAIR_REDEEM_MAX_BYTES, valid: { token: `rbox-pair_${"x".repeat(64)}`, label: "ok" }, invalid: { token: `rbox-pair_${"x".repeat(65)}` }, validate: validatePairRedeemBody },
  { route: "POST /v1/account/link/start", cap: LINK_START_MAX_BYTES, valid: { clerkToken: jwtMax }, invalid: { clerkToken: jwtOver }, validate: validateLinkStartBody },
  { route: "POST /v1/account/link/confirm", cap: LINK_CONFIRM_MAX_BYTES, valid: { clerkToken: jwtMax, pollKey: `plk_${"a".repeat(32)}` }, invalid: { clerkToken: jwtMax, pollKey: `plk_${"a".repeat(33)}` }, validate: validateLinkConfirmBody },
  { route: "POST /v1/account/link/redeem", cap: LINK_REDEEM_MAX_BYTES, valid: { code: `rbox-link_${"a".repeat(43)}` }, invalid: { code: `rbox-link_${"a".repeat(44)}` }, validate: validateLinkRedeemBody },
  { route: "POST /v1/keys/api", cap: API_KEY_CREATE_MAX_BYTES, valid: { tokenHash: sha, deviceId: "device_01", expiresAt: 1, displayPrefix: "😀".repeat(60), label: "ok", enrolled: true }, invalid: { tokenHash: sha, deviceId: "device_01", expiresAt: 1, displayPrefix: `${"😀".repeat(60)}a` }, validate: validateApiKeyBody },
  { route: "POST /v1/keys/bootstrap", cap: KEY_BOOTSTRAP_MAX_BYTES, valid: { recoveryWrap: opaqueMax, recoveryWrapId: opaqueMax, genesisRoster: opaqueMax, genesisKeyState: opaqueMax, device }, invalid: { recoveryWrap: opaqueOver, recoveryWrapId: "x", genesisRoster: "x", genesisKeyState: "x", device: { deviceId: "x", sigPubKey: "x", encPubKey: "x", mkWrap: "x" } }, validate: validateKeyBootstrapBody },
  { route: "POST /v1/keys/device", cap: KEY_DEVICE_MAX_BYTES, valid: device, invalid: { ...device, mkWrap: opaqueOver }, validate: validateKeyDeviceBody },
  { route: "POST /v1/keys/roster", cap: KEY_ROSTER_MAX_BYTES, valid: { version: Number.MAX_SAFE_INTEGER, signed: opaqueMax }, invalid: { version: Number.MAX_SAFE_INTEGER, signed: opaqueOver }, validate: validateKeyRosterBody },
  { route: "POST /v1/keys/admit", cap: KEY_ADMIT_MAX_BYTES, valid: { device, roster: { version: Number.MAX_SAFE_INTEGER, signed: opaqueMax } }, invalid: { device, roster: { version: Number.MAX_SAFE_INTEGER, signed: opaqueOver } }, validate: validateKeyAdmitBody },
  { route: "POST /v1/keys/keystate", cap: KEY_STATE_MAX_BYTES, valid: { accountEpoch: Number.MAX_SAFE_INTEGER, signed: opaqueMax }, invalid: { accountEpoch: Number.MAX_SAFE_INTEGER + 1, signed: opaqueMax }, validate: validateKeyStateBody },
  { route: "POST /v1/keys/workspace", cap: KEY_WORKSPACE_MAX_BYTES, valid: { workspaceId: opaqueMax, keyEpoch: Number.MAX_SAFE_INTEGER, kekWrap: opaqueMax }, invalid: { workspaceId: opaqueMax, keyEpoch: Number.MAX_SAFE_INTEGER, kekWrap: opaqueOver }, validate: validateWorkspaceKeyBody },
];

describe("Design 151 Unit 2 exact bounded JSON table", () => {
  test.each(routes)("$route accepts its legitimate field maximum and rejects beyond it", ({ validate, valid, invalid }) => {
    expect(validate(valid)).not.toBeNull();
    expect(validate(invalid)).toBeNull();
  });

  test.each(routes)("$route uses an inclusive raw body cap", async ({ cap, validate, valid }) => {
    const body = JSON.stringify(valid);
    const accepted = await cappedJson(new Request("https://api.rbox.to/test", { method: "POST", headers: { "content-length": String(cap) }, body }), { maxBytes: cap }, validate);
    expect(accepted.ok).toBe(true);
    const rejected = await cappedJson(new Request("https://api.rbox.to/test", { method: "POST", headers: { "content-length": String(cap + 1) }, body }), { maxBytes: cap }, validate);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.response.status).toBe(413);
  });
});

describe("display-field truncation and well-formedness", () => {
  test("label/accountName truncate at a UTF-8 boundary and never split astral code points", () => {
    const input = `${"a".repeat(598)}😀tail`;
    const start = validateDeviceStartBody({ label: input });
    const bootstrap = validateBootstrapBody({ secret: "s", accountName: input, label: input });
    const redeem = validatePairRedeemBody({ token: "x".repeat(16), label: input });
    expect(start?.label).toBe("a".repeat(598));
    expect(bootstrap?.label).toBe("a".repeat(598));
    expect(bootstrap?.accountName).toBe("a".repeat(598));
    expect(redeem?.label).toBe("a".repeat(598));
    expect(utf8Bytes(start!.label!)).toBeLessThanOrEqual(600);
  });

  test("downstream display sanitizers count code points, not UTF-16 units", () => {
    expect(truncateCodePoints("😀".repeat(201), 200)).toBe("😀".repeat(200));
    expect(sanitizeWorkspaceName("😀".repeat(81), 80)).toBe("😀".repeat(80));
  });

  test.each(["\\ud800", "\\udfff"])("escaped lone surrogate %s is rejected", (escaped) => {
    const label = (JSON.parse(`{"label":"${escaped}"}`) as { label: string }).label;
    expect(validateDeviceStartBody({ label })).toBeNull();
    expect(validateBootstrapBody({ secret: "s", accountName: label })).toBeNull();
    expect(validatePairRedeemBody({ token: "x".repeat(16), label })).toBeNull();
    expect(validateApiKeyBody({ tokenHash: sha, deviceId: "device_01", expiresAt: 1, displayPrefix: label })).toBeNull();
  });
});
