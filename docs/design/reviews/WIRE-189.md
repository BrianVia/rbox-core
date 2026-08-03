# Design 189 · Unit 1 wire contract

This is the API-first contract for the later web, daemon, and CLI units. JSON
objects are exact unless a field is marked optional. All responses are
`application/json`. Existing device-code `status` values remain unchanged;
`keyDelivery` is a separate field and state machine.

## Public-key encoding and request identity

- `encPubKey` / `encPubKeySpki`: canonical, unpadded base64url of an RSA-OAEP
  SHA-256 3072-bit SPKI DER public key.
- `sigPubKey`: canonical, unpadded base64url of the raw 32-byte Ed25519 public
  key.
- `requestId`: lowercase hex `sha256(deviceCode)`.
- Fragment fingerprint:
  `base64url(sha256(JCS({encPubKeySpki: encPubKey, sigPubKey})))`.
  The member names above are literal and JCS sorts them in that order. The CLI
  places this value in `#fp=...`; the fragment is never sent automatically.

## Device start

`POST /v1/auth/device/start` is public and rate-limited.

Legacy request (unchanged):

```json
{"label":"optional device label"}
```

189 request; the two public-key fields must appear together:

```json
{
  "label": "optional device label",
  "encPubKey": "<base64url RSA-3072 SPKI>",
  "sigPubKey": "<base64url Ed25519 raw key>"
}
```

Success is unchanged:

```json
{
  "deviceCode": "<64 lowercase hex>",
  "userCode": "ABCD-EFGH",
  "interval": 5,
  "expiresIn": 600
}
```

Malformed encodings, a non-3072-bit RSA key, a non-65537 exponent, or only one
public key returns `400 {"error":"invalid_device_public_keys"}` or
`400 {"error":"bad_request_shape"}`.

## Approval-page public-key echo

The existing public lookup now conditionally echoes captured public keys:

`GET /v1/auth/device/lookup?code=ABCD-EFGH`

```json
{
  "label": "device label or null",
  "status": "pending",
  "encPubKeySpki": "<base64url RSA SPKI>",
  "sigPubKey": "<base64url Ed25519 key>"
}
```

The last two fields are absent for a legacy start. Expired or unknown codes
return `404 {"error":"not_found"}`.

The approval page may use the keys-only form:

`GET /v1/auth/device/pubkeys?code=ABCD-EFGH`

```json
{
  "encPubKeySpki": "<base64url RSA SPKI>",
  "sigPubKey": "<base64url Ed25519 key>"
}
```

It returns 404 for a legacy/no-key start. The page must recompute the fingerprint
and compare it to the URL fragment before presenting key consent.

## Device approval

`POST /v1/auth/device/approve` requires an rbox bearer. It is rate-limited per
approver identity.

The old request remains device-auth-only:

```json
{"userCode":"ABCD-EFGH"}
```

An explicit refusal is also device-auth-only:

```json
{"userCode":"ABCD-EFGH","keyConsent":false}
```

Both return the legacy success:

```json
{"ok":true}
```

Key delivery requires a short-lived rbox `web` bearer and this exact body:

```json
{
  "userCode": "ABCD-EFGH",
  "keyConsent": true,
  "pubkeyFingerprint": "<43-char base64url fragment fingerprint>",
  "clerkToken": "<fresh Clerk session JWT after reverification>"
}
```

The API verifies the Clerk signature, issuer, expiry, origin, subject-to-rbox
mapping, signed `iat`, and signed `fva`. The strict window is ten minutes:
second-factor age is used when present; Clerk's `-1` no-second-factor value
falls back to first-factor age. Time elapsed since JWT issue counts against the
window.

Successful approval and queue insertion are one transaction:

```json
{
  "ok": true,
  "keyDelivery": {
    "requestId": "<sha256(deviceCode)>",
    "status": "pending",
    "expiresAt": 1784830000000
  }
}
```

Important failures:

- stale/missing step-up: `403 {"error":"fresh_step_up_required"}`
- step-up belongs to a different rbox principal:
  `403 {"error":"step_up_principal_mismatch"}`
- fragment mismatch: `409 {"error":"pubkey_binding_mismatch"}`
- account has no E2EE epoch: `409 {"error":"key_delivery_unavailable"}`
- five live requests: `409 {"error":"key_delivery_cap"}`
- same account + encryption public key already live:
  `409 {"error":"duplicate_key_delivery"}`
- epoch changed during approval: `409 {"error":"key_delivery_epoch_changed"}`

Any missing/false consent takes the legacy device-auth-only path. A true consent
request with incomplete proof is a bad exact shape and returns 400; it never
silently queues.

When the account key-delivery kill switch is disabled, a fully valid true-consent
approval deliberately degrades to device authentication only:

```json
{"ok":true,"keyDelivery":null,"keyDeliveryDisabled":true}
```

No delivery row is created; the CLI continues through the existing pairing
fallback.

## Device poll extension and token recovery

`POST /v1/auth/device/poll` remains:

```json
{"deviceCode":"<64 lowercase hex>"}
```

The legacy `status`, `interval`, `token`, `deviceId`, and `accountId` meanings
remain. Every response for a found code additionally carries `keyDelivery`,
which is `null` when no delivery was requested.

Queued:

```json
{
  "status": "approved",
  "token": "<new device bearer>",
  "deviceId": "dev_...",
  "accountId": "acct_...",
  "keyDelivery": {
    "status": "pending",
    "requestId": "<sha256(deviceCode)>",
    "expiresAt": 1784830000000
  }
}
```

Ready:

```json
{
  "status": "claimed",
  "token": "<same escrow-recovered bearer, while TTL is live>",
  "deviceId": "dev_...",
  "accountId": "acct_...",
  "keyDelivery": {
    "status": "ready",
    "requestId": "<sha256(deviceCode)>",
    "expiresAt": 1784830000000,
    "mkWrapDevice": "<opaque ciphertext>",
    "publishedRosterVersion": 7,
    "accountEpoch": 0
  }
}
```

`claimed` re-polls within the original device-code TTL recover the exact same
bearer from AES-GCM encrypted server escrow. Concurrent claim polls converge on
that bearer and one device row. The escrow is deleted on ACK, revoke, account
deletion, or expiry.

Terminal delivery fields are:

```json
{"status":"delivered","requestId":"<id>","expiresAt":1784830000000}
```

or:

```json
{"status":"expired","requestId":"<id>","expiresAt":1784830000000}
```

The fulfilled ciphertext is returned identically on every poll until ACK.

## Daemon fetch

`POST /v1/auth/key-delivery/fetch` requires any live durable device bearer.
Web sessions and API keys are forbidden. It is rate-limited per daemon.

`keyReleaseOptIn` is mandatory and persisted as that daemon's release setting.
A read-write daemon transmits its default-on setting. A pull-only daemon MUST
transmit `false` unless its separately persisted local `keyReleaseOptIn` has
been explicitly enabled; default-on never changes pull-only behavior.

Nudged fetch:

```json
{"requestId":"<64 lowercase hex>","keyReleaseOptIn":true}
```

Pull fallback (oldest eligible request for the daemon's account):

```json
{"keyReleaseOptIn":true}
```

Opted-out/pull-only denial:

```json
{"request":null,"keyReleaseEnabled":false}
```

No eligible work:

```json
{"request":null}
```

Work:

```json
{
  "request": {
    "requestId": "<sha256(deviceCode)>",
    "targetDeviceId": "dev_...",
    "encPubKey": "<base64url RSA SPKI>",
    "sigPubKey": "<base64url Ed25519 key>",
    "encPubKeyHash": "<64 lowercase hex>",
    "sigPubKeyHash": "<64 lowercase hex>",
    "pubkeyFingerprint": "<43-char base64url>",
    "approvalTokenHash": "<64 lowercase hex>",
    "accountEpoch": 0,
    "approvedAt": 1784829400000,
    "expiresAt": 1784830000000
  }
}
```

Fetch is non-claiming. The daemon must verify/reconcile, publish the target
device row plus the new admin-signed roster through the existing key API, and
then submit. Requests with no minted/retargeted device, stale step-up, stale
account epoch, expired TTL, or revoked target are not returned.

## Daemon submit

`POST /v1/auth/key-delivery/submit` has the same daemon authorization and is
rate-limited per daemon.

```json
{
  "requestId": "<64 lowercase hex>",
  "mkWrapDevice": "<opaque device-context ciphertext, max 256 KiB UTF-8>",
  "publishedRosterVersion": 7,
  "accountEpoch": 0
}
```

The server never parses `mkWrapDevice`. The single `queued -> fulfilled` CAS
requires, inside the same statement:

- live TTL and fresh approval;
- current account epoch;
- active target and fulfilling devices;
- the submitted roster version is the current published head;
- the published `device_keys` row exactly matches the captured public keys and
  submitted opaque wrap.

First success:

```json
{"ok":true,"requestId":"<id>"}
```

An exact retry while still fulfilled is idempotent:

```json
{"ok":true,"requestId":"<id>","alreadyFulfilled":true}
```

A different second fulfillment returns
`409 {"error":"already_fulfilled"}`. Other conflicts return
`409 {"error":"publish_not_current"}`; expired requests return 410; an
out-of-account id returns 404.

## Client ACK

`POST /v1/auth/key-delivery/ack` requires the live durable bearer whose
`deviceId` is the request's exact `targetDeviceId`. It is rate-limited per target
device.

```json
{"requestId":"<64 lowercase hex>"}
```

The CLI sends ACK only after full roster-chain verification, exact own-key/wrap
binding, MK unwrap, and durable local persistence.

First ACK:

```json
{"ok":true,"alreadyDelivered":false}
```

Lost-response retry within TTL:

```json
{"ok":true,"alreadyDelivered":true}
```

ACK is the only `fulfilled -> delivered` transition. It atomically scrubs the
ciphertext/roster metadata and deletes token escrow. Not-ready is 409, expired
is 410, and a wrong/revoked target is 404.

## Notification-only nudge

After queue and again after claim/retarget, the worker best-effort broadcasts to
each account workspace:

```json
{"type":"key-delivery","requestId":"<64 lowercase hex>"}
```

The frame carries no key material. Old daemons ignore the unknown frame; all
correctness comes from the authenticated fetch/poll path.

## Lifecycle and controls

- Delivery TTL is ten minutes. Every nonterminal transition independently
  checks TTL, current epoch, fresh approval, and target revocation.
- Active cap is five per account. `delivered` and `expired` rows do not count.
- One live request is allowed per `(account, encPubKeyHash)`.
- Revoking a target atomically terminalizes and scrubs its queued/fulfilled
  delivery and deletes its token escrow.
- Account deletion does the same for the whole account.
- `account_key_delivery_prefs.enabled=0` is the per-account kill switch.
- `devices.key_release_enabled=0` is the per-daemon release opt-out. Every fetch
  persists the mandatory `keyReleaseOptIn`; pull-only sends false until its
  separate local opt-in is explicitly enabled.
- `RBOX_DEVICE_TOKEN_ESCROW_KEY` is the optional dedicated escrow root. During
  rollout, absence uses a domain-separated derivation from the required
  `RBOX_BOOTSTRAP_SECRET`.
- All four new mutating/pull routes can return 429 with
  `{"error":"rate_limited","retryAfterSeconds":60}`.
