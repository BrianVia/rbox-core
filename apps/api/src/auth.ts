/**
 * Self-hosted device-token auth (M4). Per-device opaque tokens, stored only as
 * sha256 hashes in D1, validated per request (immediate revocation). Issued via
 * a CLI device-authorization flow: bootstrap (secret) or device-to-device
 * approval. The token is minted on the FIRST poll after approval and returned
 * exactly once (one-time claim) — never stored in plaintext, never re-returned.
 *
 * This module is a barrel: the auth surface lives in `./auth/*` (split along its
 * natural seams — token verification, minting, pairing, bootstrap, device-code
 * login, device management, and the web dashboard projections). Importers keep
 * importing from `./auth.js`; nothing here changes behavior.
 */

// Shared primitives + error matchers.
export { randomHex, isUniqueViolation, isOverCapAbort } from "./auth/shared.js";

// Bearer-token verification middleware → Principal.
export { authenticate } from "./auth/authenticate.js";

// Device credential minting (durable CLI/device tokens + short-lived web sessions).
export { AccountGoneError, DeviceLimitError, checkDeviceCap, deviceCapFor, mintDevice, prepareMintDevice, mintDeviceWithNotification, createWebSession, type MintNotifyOpts } from "./auth/mint.js";

// Pairing tokens (M10): low-friction "connect a new machine".
export { createPairToken, redeemPairToken } from "./auth/pairing.js";

// Tenant bootstrap (secret-gated first account/owner/device).
export { bootstrap } from "./auth/bootstrap.js";

// CLI device-authorization login flow (start / poll / approve).
export { startDeviceAuth, pollDeviceAuth, approveDeviceAuth, lookupDeviceAuth } from "./auth/device-code.js";

// CLI device management (list / revoke).
export { listDevices, revokeDevice } from "./auth/devices.js";

// Web dashboard surface (design 22 §2): account-scoped device & workspace projections.
export { accountDevices, accountWorkspaces } from "./auth/account-surface.js";
