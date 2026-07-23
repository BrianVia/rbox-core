# 189 — Web-approved pairing: auto-fulfilled key delivery

Status: ALIGNED (core protocol) — v7. Across two parallel rounds + three serial
gates the crypto/consent/trust model, admin-roster path, chain verification, and
revoke fence are VERIFIED. The only residual across the last two gates is one
theme — crash-recovery idempotency of the daemon<->CLI handoff — now specified
as a hard requirement pinned to this codebase's existing crash-safe-reuse
discipline (genesis staging, pairing deviceKeys-across-409). Per that discipline,
crash-recovery is VERIFIED IN IMPLEMENTATION with boundary crash-injection tests
(§14), not by enumerating interleavings in prose. Ready to implement.

Related: 47, 184, 180, 12 (roster), 187, 191 (epoch rotation — deferred, §12.1),
190 (passkey escrow — DECOUPLED, §9), #412 (Clerk redirect fix — MERGED; §8).

UX law: automatic binding > acknowledge-a-match > typing; zero typed codes.
GOAL: onboarding is not a hassle. Common case = second machine, one machine
online, keys arrive automatically. Post-compromise re-key is NOT this design.

## 1. Problem

Web device approval authorizes a new machine but cannot enroll it for encryption
(the web never holds key material), so it stalls at "paste a pairing token or
type your 24 words" (DEVICE_CODE_ENROLL_STEP, src/cli/auth-cmd.ts:72). Roughest
onboarding edge (beta audit 2026-07-22; founder 2026-07-23).

## 2. Constraint and the accepted deltas (founder-ruled, facts corrected r2)

Non-negotiable: server and web never see key material.

189 relays an asymmetric MK wrap through the server. It is weaker than the
split-secret pairing token (session.ts:442) against a FULLY MALICIOUS operator,
who could authorize an attacker's keys behind an honest approval (round-2 A#2):
the recipient's exact-key check protects the legitimate CLI but an attacker can
present matching attacker keys. This is the ACCEPTED operator-trust delta —
§3 no longer claims to "defeat" a malicious server; it defeats an
honest-but-curious server that tries to substitute a key AFTER approval (the
fragment + chain checks), and web-session compromise (guardrails §5).

FOUNDER RULING (Q1): a device that receives the MK can decrypt data it already
had; a synced device already holds that plaintext, so MK retention grants
nothing beyond device exposure. CORRECTION (round-2 A#4/C#4, founder-accepted
2026-07-23): revoke is NOT an instant data-plane cutoff — download grants bypass
bearer auth, carry no device binding, and stay valid ~5 min
(apps/api/src/grants.ts:22; worker.ts:311; documented by
test/blob-batch-auth-grant.test.ts:101). So a revoked device holding a
pre-minted grant can fetch newly-uploaded ciphertext for up to that window.
ACCEPTED. User-facing copy MUST say: "Revoke blocks new access; a machine that
already received your key keeps what it has, and any in-flight download grant
expires within ~5 minutes." Forward-secrecy re-key = design 191, NOT a
prerequisite.

## 3. Mechanism (round-2 corrected to the real primitives)

The fulfilling daemon is a LIVE ADMIN. It admits the new device with the
ADMIN-signed roster path — NOT the self-admission path (round-2 all: §3 v3
wrongly cited buildAdmissionRoster/redeemPairing, which need the new device's
private key + a token-derived admission key the daemon lacks).

1. New CLI at `login` start generates sig+enc keypairs, submits both public keys
   with `device/start`.
2. CLI opens the approval URL with `fp = base64url(sha256(JCS({encPubKeySpki,
   sigPubKey})))` — JCS over a structured object, with exact Ed25519(32B) and
   RSA-SPKI validation before hashing (round-2 A#7). `fp` rides in the URL
   FRAGMENT (never sent to the server). The cli-login loader MUST preserve
   `location.hash` through its redirect (round-2 A#5/C#2: today +page.ts:23
   rebuilds with only ?code= and drops the hash — FIX REQUIRED, §8).
3. Approval page: fresh Clerk step-up (server-verified JWT, strict max age —
   round-2 A#6/B#2: today api.ts:264 sends only the cached bearer and
   device-code.ts:147 only updates status; a NEW step-up path is required),
   then AUTOMATICALLY verifies the server-returned pubkeys hash to `fp`. On a
   match + explicit keyConsent, the user taps Approve; the server records an
   authenticated approval and issues a delivery bound to those exact pubkey
   hashes. Approval + delivery-queue are ONE atomic D1 batch (round-2 B#3) so an
   approved device never exists without its delivery and vice-versa.
4. Server nudges the account's online daemons (§6).
5. Fulfilling daemon fetches the request, verifies approval-authed + pubkey
   binding + current epoch + active source-device, then:
   - fetches the current head roster + verifies the chain it already trusts;
   - wraps MK to the new device's enc pubkey via rsaDeviceWrap (keys.ts:93,
     foreign SPKI confirmed) ONCE, under the PERSISTED device context
     "rbox/mk-wrap/device/v1" — the daemon holds the device's PUBLIC key, so it
     produces the exact wrap the new device will store; there is no separate
     transport context and NO client re-wrap (serial BLOCKER-1: RSA wrapping is
     randomized, so a client re-wrap could never match the roster's committed
     mkWrapHash, and assertMkWrapAuthorized would reject it, session.ts:270-275).
     Only the target device can unwrap it (bound to its pubkey + account/epoch);
   - `buildAdminRoster(prevBody, [...active, newEntry], daemonDeviceId,
     daemonSignKey)` (roster.ts:124) with newEntry.mkWrapHash = hash OF THAT
     wrap — NO admission proof needed (the daemon is active in prev, so
     verifyTransition's admin-signature branch validates it, roster.ts:266-272);
   - PUBLISHES the new roster + device row to the server atomically at
     fulfillment via the existing monotone append (keys.ts:398-426), which 409s
     on a stale parent. The daemon owns re-fetch-head/rebase/re-sign on 409
     (it holds the signing key; the client cannot). Publish is CRASH-SAFE
     IDEMPOTENT (serial2 MAJOR-2 + serial3 MAJOR-1: device_keys.device_id is a PK
     keys.ts:415-422, and rsaDeviceWrap is RANDOMIZED asym.ts:84, so a restart
     that re-wraps produces different bytes that would fail an exact-match
     reconcile): BEFORE publishing, the daemon STAGES {wrap, signed-roster} in
     its attempt journal keyed by requestId (§7.4) and reuses those exact bytes
     across restart/retry — the SAME crash-safe-reuse discipline pairing uses for
     deviceKeys across 409 (session.ts deviceKeys param) and genesis uses for
     staged material. On reconcile, if the target device+roster row already
     exists, the daemon ADOPTS the committed wrap (reads it back and delivers
     THAT, keys.ts:381 pattern) rather than requiring its own bytes to match —
     so recovery never depends on reproducing randomized ciphertext. It re-signs
     only when the row is genuinely absent. By pickup the admin-signed roster is
     the PUBLISHED head (serial MAJOR-4: head-race closed);
   - posts {mkWrapDevice, publishedRosterVersion, accountEpoch}.
6. New CLI polls, receives it, and:
   - fetches + verifies the FULL roster chain (verifyRosterChain) up to the
     published head, binding it through the account key-state/MK trust path
     (round-2 C#3/A#2: a lone signed roster is NOT self-proving — the device must
     confirm the DELIVERING daemon was a genuinely active admin via the chain,
     else a server could supply a bogus roster signed by a key it controls);
   - confirms the published roster admits its OWN exact pubkeys at the current
     epoch and that mkWrapDevice hashes to the roster's mkWrapHash;
   - unwraps MK with its enc private key and stores mkWrapDevice AS-IS
     (openOwnMasterKey accepts it directly — device context, session.ts:578);
   - persists device.json via the existing keystore;
   - ACKs the server (§7.3).

This resolves the round-2 BLOCKERs (admin-roster primitive, chain-verified
authority) AND the serial BLOCKER-1/MAJOR-4: the daemon commits and delivers ONE
device-context wrap and publishes the roster itself, so hash commitment and head
ordering both hold without the client ever signing or re-wrapping.

## 4. Flow

```
new CLI                     browser                    API worker            daemon (admin)
gen sig+enc keys
device/start +pubkeys ------------------------------> pending (pubkeys)
open URL#fp=JCShash --------> step-up; AUTO-verify
                             server pubkeys==fp;
                             keyConsent+Approve ------> [atomic] approved
                                                        + delivery QUEUED
poll: keyDelivery=pending                              -- nudge -----------> verify approval+
                                                                             pubkeys+epoch;
                                                                             fetch+verify chain;
                                                                             wrap MK (device ctx);
                                                                             buildAdminRoster w/ that
                                                                             wrap's hash; PUBLISH
                                                                             roster (monotone, 409->
                                                                             reconcile)
                                                        <-- blob+ver ------- post
poll: keyDelivery=ready{blob,rosterVer} <-- relay
verify chain->admin authority; published roster admits my keys;
unwrap MK; store wrap AS-IS; persist; ACK -> delivered
```

Fallback when no daemon in TTL: pairing token -> phrase (190 decoupled, §9).
Legacy `status`/token semantics UNCHANGED; `claimed` responses still carry
keyDelivery pending|ready so the poll continues after the auth claim
(round-2 C#6). One state line.

## 5. Consent & threat model

1. Automatic fragment binding; manual navigation (no fragment) = device-auth
   ONLY, never key delivery (Q3, unanimous). Server refuses to queue delivery
   without a fragment-verified binding + keyConsent.
2. Explicit separate consent: delivery queued only on keyConsent=true + binding;
   an OLD web page (no consent field) can never trigger delivery (B#9).
3. Fresh Clerk step-up, server-verified, strict max age; cached bearer rejected
   (A#4/A#6/B#2). Approval bound to the re-authed session.
4. Notification: extend the new-device email outbox (mint.ts:176) with
   granted-keys wording + fingerprint.
5. Single-use + TTL + caps + REVOKE FENCE: EVERY transition (approve, fetch,
   fulfill, poll, ACK, sweep) guards `expires_at > now` AND the target device is
   non-revoked; expired/delivered rows never revive (round-2 A#8/B#5; serial
   MAJOR-3). `rbox device revoke` cancels+scrubs the target's undelivered
   key_delivery rows in the SAME transaction as the revoke, so "revoke blocks new
   access" is true for the delivery path (devices.ts revoke must gain this).
   Concrete caps §6.
6. Full-strength fingerprint: JCS + validated key encodings, sha256 (A#7).
7. Approval-page XSS: text-only, no {@html}/innerHTML, a ROUTE-SPECIFIC strict
   CSP for the approval page (round-2 B#10: the global _headers policy allows
   unsafe-inline/eval for Clerk; the approval route needs its own tighter
   boundary), regression test.
8. Kill switch: per-account disable + per-daemon key-release opt-out.

## 6. Server surface (apps/api)

- `device_auth` gains nullable `enc_pub_key`, `sig_pub_key`, captured-at. `status`
  NOT extended (B#8 — account-link counts pending/approved, account-link.ts:344,
  0014_account_linking.sql:77).
- Target-ID stability (round-2 B#9; serial MAJOR-2 crash-safety): `device/start`
  proposes an id but poll can RE-MINT on a uniqueness collision
  (device-code.ts:117-142). The delivery binds to the request identity
  (sha256(device_code)); mint + actual-deviceId recording + delivery retarget are
  ONE atomic D1 batch at claim (a crash after mint but before retarget must not
  leave the delivery bound to the discarded proposed id). Fulfillment reads the
  retargeted id keyed by requestId; if retarget is absent the request is not yet
  fulfillable (durable reconcile by requestId, not the proposed id).
- `key_delivery` {requestId=sha256(device_code) PK, account, targetDeviceId
  (retargeted at claim), encPubKeyHash, sigPubKeyHash, approvalTokenHash, state
  `queued|fulfilled|delivered|expired`, wrap_blob, roster_blob, accountEpoch,
  created_at, expires_at}. Fulfill: `UPDATE...RETURNING WHERE state='queued' AND
  expires_at>?` (pairing.ts:155). Pickup keeps the blob in `fulfilled`; a
  distinct CAS `fulfilled->delivered` fires on the client ACK — ACK requires
  `p.deviceId=targetDeviceId AND expires_at>now`, and a retry after a lost
  response returns idempotent already-delivered (round-2 B#4/C#6). Scrub blobs on
  every terminal transition.
- Caps (round-2 B#6, concrete): per-account active-delivery cap = 5 (mirror
  pairing.ts:17) via atomic INSERT...SELECT...WHERE count<cap (pairing.ts:91);
  per-approver throttle; duplicate-target uniqueness (one live delivery per
  (account,encPubKeyHash)); delivered/expired rows excluded from the count. New
  rate-limit registry entries (namespaced, wrangler.jsonc:176 style) for the
  approve + fetch + submit + ack routes.
- Endpoints (bounded/authed/rate-limited): device/start (+pubkeys), device/
  approve (+keyConsent, step-up-gated), device/poll (SEPARATE keyDelivery field;
  legacy status/token unchanged), page pubkey-echo (for fragment compare),
  daemon fetch-request, daemon submit-blob, client ack.
- Nudge (B#4): worker-internal authed route enumerates the account's
  (workspace_id, project_id) rows and broadcasts {type:"key-delivery",requestId}
  into each DO via ws-fanout.broadcast (ws-fanout.ts:20) under waitUntil; old
  daemons ignore unknown frames (daemon/daemon.ts:3111). No bound workspace ->
  poll fallback.
- Revoke fence (serial MAJOR-3): revokeDevice cancels+scrubs the target's
  undelivered key_delivery rows atomically with the revoke; fetch/fulfill/pickup/
  ACK all re-check `devices.revoked=0` for the target.
- Lifecycle (round-2 B#8): a NEW scheduled key_delivery sweep (add to
  worker.ts's scheduled handler alongside sweepNotifications — NOT reusing it);
  account purge deletes key_delivery (add to account-delete.ts). Migration
  **0034_key_delivery.sql** (round-2 B#7 BLOCKER: 0032 is taken by
  account_op_latency; append-only, re-check after rebase — migrations/README.md).

## 7. Daemon / CLI surface

7.1 CLI keypairs generated at login start (not enrollment — pairing gen is at
e2ee-client.ts:438), staged in a NEW attempt journal keyed by sha256(device_code)
with expiry, pubkey fingerprints, ownership, terminal {abandoned,fulfilled}.
NOT genesis paths (C#3-r1: genesis staging is account-scoped and the account id
is unknown at login start; reusing device.json trips the genesis classifier).
Concurrent logins keyed separately; abandoned attempts TTL-swept, never poison a
real enrollment.

7.2 Poll FSM: approved -> keyDelivery pending -> ready -> admitted, continuing
to poll AFTER the auth claim (round-2 C#6: the current loop returns on approved,
auth-cmd.ts:1003-1017, and post-claim polls only return `claimed`; the new field
must be carried on `claimed` too), with deadlines, cancellation, and fallback to
pairing/phrase, rendered as one state line. TOKEN RECOVERY (serial2 MAJOR-3 + serial3 MAJOR-2):
today a crash after the claim commit but before the HTTP response strands the
CLI without its once-returned bearer (device-code.ts:95 returns only `claimed`;
mint.ts:145-162 stores only token_hash). 189 requires an ATOMIC claim+mint+
retarget D1 batch, and the minted bearer is ESCROWED ENCRYPTED-AT-REST keyed by
requestId=sha256(device_code) with the device-code TTL. An authenticated re-poll
of the same device_code returns the escrowed token (concurrent polls get the
SAME token — idempotent, no second mint); it is scrubbed on the CLI's ACK or at
TTL. Outside the window the user re-runs login (today's behavior). This is a
device-code hardening 189 requires; verified by crash-injection tests (§14).

7.3 Pickup crash-safety: idempotent — blob stays in `fulfilled` until the client
ACK confirms durable persist + roster verify; a crash re-fetches the same blob;
scrub on ACK or TTL (round-2 B#4/C#6 conditions).

7.4 Daemon fulfillment is a SEPARATE bounded flight independent of the sync pump
+ workspace mutex (daemon/daemon.ts:357) — must not queue behind or block sync.
"Live/fresh" = the authenticated fetch arrived now + approval-token age + current
server epoch; explicitly NOT last_seen_at (throttled up to 10 min,
authenticate.ts:61) nor WS presence (round-2 C#5/B#12). Pull-only daemons fulfill
ONLY with a separately persisted+transmitted `keyReleaseOptIn` (pull-only today
only suppresses pushes, daemon.ts:1124; default-on §12.2 must not flip this).

## 8. #412 dependency (partly done, one gap)

#412 (MERGED, production) makes the root route consume a validated redirect_url,
so `/cli-login?code=…` survives the Clerk bounce. REMAINING GAP (round-2
A#5/C#2): the cli-login loader (+page.ts:23) rebuilds the redirect with only
`?code=` and DROPS `location.hash`, where `fp` lives. This design's web change
MUST preserve the fragment (the loader runs client-side, ssr=false, and can read
location.hash) — or carry `fp` as a validated query param with the same
no-server-secret handling. Prerequisite, tracked here.

## 9. 190 decoupled

Round 1 (unanimous) found 190 (browser unwraps RK) violates "web never sees key
material". 189 does not depend on 190; fallback after "no daemon online" is
pairing token -> phrase until 190 is redesigned + aligned on its own timeline.

## 10. Verified anchors (rounds 1-2)

- Admin path: buildAdminRoster (roster.ts:124; :123 is its comment), verified via
  the prevSigner-active branch (roster.ts:266-272) — no admission proof.
- Roster monotone publish + 409-on-stale-parent (keys.ts:398-426) — daemon owns
  rebase/re-sign on 409.
- rsaDeviceWrap foreign SPKI (keys.ts:93); wrapHash hashes that exact blob;
  openOwnMasterKey requires the device context (session.ts:578) -> the daemon
  produces the device-context wrap directly and the client stores it AS-IS
  (no re-wrap). assertMkWrapAuthorized checks the delivered blob hash
  (session.ts:270-275).
- Idempotent roster publish reconcile pattern: e2ee-client.ts:404-408.
- device-code has no pubkey today (device-code.ts:50-72; 0004_auth.sql:17);
  poll can re-mint the id (device-code.ts:117-142).
- Grants bypass bearer auth, ~5 min (GRANT_TTL_MS grants.ts:22), no device
  binding (worker.ts:311); revoked-download evidence test/worker.test.ts:172 —
  §2 correction.
- ws per-workspace DO (src/cli/remote/api.ts:181; routes/sync.ts:30); nudge =
  fan-out into the account's DOs.
- `rbox device revoke` access-only (devices.ts:16-21); `rbox key revoke` = API
  keys (key-cmd.ts:119) — copy/command corrected.
- Reusable: caps/CAS (pairing.ts:91,155), device-code claim CAS
  (device-code.ts:111), ignore-by-default ws dispatch (daemon/daemon.ts:3111),
  email outbox (mint.ts:176).
- Stale v3 anchors corrected: approval return is auth-cmd.ts:1003-1017 (not 977);
  worker.ts scheduled sweep is notifications; e2ee-client.ts:438 is pairing gen;
  api.ts:264 is the cached bearer (which §5.3 now rejects).

## 11. Rollout / skew

API first (pubkeys + keyConsent optional; old shapes still accepted). Then CLI
(old CLI: no pubkeys -> no delivery -> today's flow). Then web (old page: no
consent -> device-auth only). No client before the API that understands it.

## 12. Rulings

12.1 Q1: epoch rotation NOT a prerequisite (founder). Honest revoke copy (§2).
Rotation = design 191.
12.2 Q2: default-on acceptable with guardrails 1-7 mandatory + kill switch; bake
= one fleet cycle + one clean external-user web-pairing. Pull-only key-release
stays opt-in regardless.
12.3 Q3: fragment required for keys; manual = device-auth only.
12.4 Q4: any authenticated live daemon may fulfill; freshness = approval-token
age + current epoch, server-verified.
12.5 Q5: pull-only fulfills only with explicit key-release opt-in.

## 14. Crash-recovery acceptance (implementation gate)

The daemon<->CLI handoff crash-safety is VERIFIED IN IMPLEMENTATION, mirroring
how genesis staging is proven (a boundary crash-test seam, genesis-durable.ts
onBoundary). Mandatory crash-injection tests, killing at each boundary and
resuming:
- daemon: after stage-attempt / after publish-commit-before-response / after
  blob-post — resume must reuse staged bytes or adopt the committed row, never
  double-insert (PK) and never deliver a wrap whose hash != the roster commit.
- server: after claim+mint+retarget batch but before response — re-poll recovers
  the escrowed token; concurrent polls converge on one token; no second mint.
- CLI: after keysReady before persist / after persist before ACK — re-fetch is
  idempotent; the blob survives until ACK; enrollment completes exactly once.
- revoke racing an in-flight delivery — the fence cancels undelivered rows and
  every transition rechecks revoked=0 (no MK delivered to a revoked target).
These are acceptance criteria for the implementation PR, not further design
rounds.

## 13. Out of scope

Passkey escrow (190); epoch rotation (191); in-CLI account-event feed (email
only); changes to pairing-token or phrase flows.
