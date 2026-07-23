# 189 — Web-approved pairing: auto-fulfilled key delivery

Status: DRAFT v2 — recon-corrected (2026-07-23); ready for the adversarial
review loop. v1's "entirely existing machinery" premise was wrong on four
counts (see §10 anchors); v2 states exactly what exists and what is new.

Related: design 47 (device-code browser approval), 184 (one-command
pairing), 180 (atomic genesis), 187 (recovery destinations), 190 (passkey
escrow — rung 2 of the shared ladder, §9), design 22 (epoch rotation —
UNBUILT, see §11).

UX law (founder, 2026-07-23): the less the user manually types or
copy/pastes, the better; automatic binding > acknowledge-a-match >
typing. This design contains ZERO typed codes.

## 1. Problem

Approving a new machine from the web UI authorizes it (device token) but
cannot enroll it for encryption — the web never holds key material. The
new machine then stalls at "paste a pairing token from another machine or
type your 24-word phrase" (`DEVICE_CODE_ENROLL_STEP`, src/cli/auth-cmd.ts:66),
which reads as a broken promise: the user just proved account ownership
in the browser and is asked to prove it again with a different machine in
hand. Roughest remaining onboarding edge (2026-07-22 beta audit; founder
hit it 2026-07-23).

## 2. Constraints and honest threat-model deltas

Unchanged, non-negotiable: the server and web UI never see key material.

Today's pairing token is SPLIT-SECRET: the MK is wrapped to a key derived
from a token secret that travels user-to-user and never touches the server
(buildPairing, src/engine/e2ee/session.ts:442-465). Consequence: even a
FULLY MALICIOUS operator cannot obtain keys from the pairing flow.

189 relays an asymmetric wrap through the server (MK wrapped to the new
device's public key). That preserves zero-knowledge against an
honest-but-curious operator and against WEB SESSION COMPROMISE (with the
guardrails below), but a fully malicious operator who controls both the
API and the web app could substitute keys behind an approval. The doc
says this plainly; reviewers must rule on accepting the delta. Framing:
the phrase and pairing-token paths retain the stronger property and
remain available; 189 is a convenience channel whose trust ceiling is
"operator is not actively malicious during your approval," which is
already the trust level of the web login session itself.

## 3. Proposal

At `rbox login` start, the CLI generates the device's enrollment keypairs
(today generated only at enrollment — this moves generation earlier) and
submits the enc public key with the device-code start request. The CLI
opens the approval URL itself (existing behavior) with the pubkey
FINGERPRINT in the URL FRAGMENT — fragments never reach the server, so
the approval page can verify the server-supplied pubkey against the
CLI-supplied fragment AUTOMATICALLY; the user just taps Approve (with a
fresh re-auth). Approval queues a single-use, TTL-bound key-delivery
request bound to that pubkey. The server nudges the account's online
daemons by broadcasting a new frame into each of the account's
workspace DOs (daemons already hold those sockets; unknown frames are
ignored by old daemons — verified). A fulfilling daemon wraps the MK to
the bound pubkey using the existing asymmetric device-wrap primitive
under a NEW domain-separated context, posts the ciphertext, and the
login poll loop (gaining keysPending/keysReady states) picks it up,
unwraps locally, and completes enrollment through the existing
self-wrap + admission path.

## 4. Flow

```
new machine CLI            browser (user)             API worker           enrolled daemon
gen keypairs
login: device/start ----------------------------------> pending row
  + encPubKey                                           (pubkey stored)
opens URL#fp=XXXX -------> page verifies #fp ==
                           server pubkey (AUTOMATIC)
                           user taps Approve
                           (fresh re-auth)  ----------> approved +
                                                        delivery QUEUED
poll: keysPending                                       -- DO broadcast --> verify request
                                                                            wrap MK->pubkey
                                                        <-- HTTPS blob ---- post (CAS win)
poll: keysReady <---------- ciphertext relay
unwrap locally -> self-wrap -> enrolled (existing path)
```

Fallback rungs when no daemon comes online within the TTL: passkey
escrow (190) -> pairing token -> phrase, presented as ONE state line (§9).

Manual-navigation fallback (user typed the user-code into the web UI, no
fragment present): the page displays the fingerprint and the user
ACKNOWLEDGES it matches the new machine's terminal — a button, not typing.

## 5. Consent & threat model

Guardrails (numbered for review):
1. **Automatic pubkey binding** via URL fragment (primary) or
   acknowledge-a-match (manual fallback). No typed codes anywhere.
   The fragment is generated by the CLI from its LOCAL keypair; a
   substituted server pubkey fails the page check visibly.
2. **Consent wording**: the approve button explicitly grants key
   delivery ("Approve and send this machine my encryption keys"),
   replacing today's copy which explicitly disclaims key delivery
   (apps/web/src/routes/cli-login/+page.svelte:101-108 — copy inversion,
   must be deliberate).
3. **Fresh re-auth** at approval (today the page approves on any live
   Clerk session — +page.svelte:55 — no step-up exists; NEW work).
4. **Notification**: extend the existing new-device email outbox
   (mintDeviceWithNotification, apps/api/src/auth/mint.ts:176-190;
   notify.ts) with granted-keys wording and the device fingerprint.
   An in-CLI/bar account-event surface does NOT exist today and is NOT
   built here (deferred; see §11).
5. **Single-use + TTL + caps**: mirror pairing semantics — 10-min TTL,
   atomic consume via conditional UPDATE...RETURNING
   (apps/api/src/auth/pairing.ts:155-159), active-request cap via
   INSERT...SELECT...WHERE count<cap (pairing.ts:91-97), existing device
   cap (device_limit_reached, device-code.ts:108-109).
6. **Kill switch**: per-account config to disable auto-fulfillment;
   daemon-side setting to refuse fulfillment (default on both: enabled —
   founder default-on rule; named bake condition in §11).

Attack table (reviewers: attack this):
- Stolen web session, attacker's own machine: attacker starts login on
  THEIR machine -> victim's session approves -> keys flow. Mitigations:
  fresh re-auth (3) blocks cookie-only theft; notification (4) +
  device cap + revoke give detection/response. Residual risk accepted?
  -> review ruling required.
- Malicious server substitutes pubkey behind honest approval: fragment
  check (1) fails -> page refuses. Malicious server AND malicious page:
  out of scope per §2 (operator-trust delta, stated).
- Replay/dup fulfillment: single-use CAS (5); two daemons race -> one
  winner, loser discards plaintext wrap material immediately.
- Wrap-context confusion: the daemon wrap MUST use a new purpose string
  ("rbox/mk-wrap/web-pair/v1"), never reusing pairing or self-wrap
  contexts (domain separation).

## 6. Server surface (apps/api) — NEW work, precisely

- `device_auth` gains nullable `enc_pub_key` + captured-at columns
  (schema today has no pubkey field — migrations/0004_auth.sql:17-26);
  populated by device/start when the CLI supplies it (old CLIs: absent ->
  flow degrades to today's behavior).
- device/approve gains the consent flag; approval with consent inserts a
  key_delivery row {account, targetDeviceId, targetPubKey, state
  queued|fulfilled|expired, wrapBlob NULL, timestamps}. Single
  fulfillment: conditional UPDATE...RETURNING (exemplar:
  device-code.ts:111-115). Blob scrubbed on consume + TTL sweep
  (exemplar: pairing.ts:163-166).
- device/poll response gains keysPending/keysReady (+blob) — additive;
  old CLIs ignore unknown fields.
- Nudge: on queue insert, broadcast {type:"key-delivery", requestId}
  into each of the account's workspace-project DOs via existing
  ws-fanout broadcast (apps/api/src/ws-fanout.ts:20-43). Old daemons
  ignore unknown frames (verified: daemon.ts:3111-3138 falls through to
  a liveness beat). Daemons without any bound workspace can't be nudged
  — acceptable: fulfillment also piggybacks on the daemon's next poll
  cycle (belt and suspenders, bounded delay).
- One D1 migration (append-only numbering rules).

## 7. Daemon / CLI surface — NEW work, precisely

- CLI login: generate sig/enc keypairs BEFORE device/start (moved from
  enrollment time — e2ee-client.ts:438 today); persist as staged device
  material with crash-safe semantics (a crash between login and
  enrollment must not strand a half-device; reuse the genesis staging
  discipline). Fragment = short hash of enc pubkey appended to the
  approval URL the CLI opens (openInBrowser path, auth-cmd.ts:1028+).
  Poll loop consumes keysReady -> unwrap -> existing self-wrap/admission
  enrollment (session.ts:476-525 shape, minus token secret).
- Daemon: on nudge (or poll), fetch queued request, verify account +
  freshness + pubkey binding, wrap MK via the EXISTING asymmetric wrap
  (rsaDeviceWrap, src/engine/e2ee/asym.ts; used today for device
  self-wrap at session.ts:493) under the new web-pair context, POST
  blob, emit log line. Never blocks sync; jittered retry; loser of the
  CAS discards material.
- `rbox pair` and all existing paths unchanged.

## 8. Failure modes (review checklist)

- Two daemons fulfill concurrently -> CAS single-winner (§6).
- Daemon crash mid-wrap -> request stays queued until TTL; retry safe.
- New machine dies before pickup -> blob expires; ciphertext only.
- Approval without consent -> device authorized, no delivery (today's
  behavior preserved).
- Pull-only daemons: hold the MK; fulfillment is not a push — proposal:
  they MAY fulfill. Review.
- Client skew: old daemon (unknown frame -> ignored, verified), old CLI
  (no pubkey at start -> no delivery queued -> today's flow), old web
  (no fragment handling -> server rejects consent approvals from pages
  that don't echo the binding check? — open, §11).
- Keypair staged but login abandoned -> staged material TTL'd/cleaned on
  next login (must not poison a later real enrollment).

## 9. Composition with 190 and 188 (unchanged from v1)

Single key-arrival ladder; one state line; 189 is rung 1; 190 rung 2;
token/phrase the floor. Codex rounds for either doc run with BOTH docs
visible (parallel-design seam rule).

## 10. Verified anchors (recon 2026-07-23)

What v1 claimed vs what the code says:
- "Reuse the pairing wrap primitive": WRONG — pairing wrap is
  split-secret symmetric (session.ts:442-465); the pubkey-targeted
  primitive is rsaDeviceWrap (asym.ts), used for self-wrap only; the
  daemon-to-foreign-pubkey wrap is NEW (with new context).
- "Pubkey bound at approval": device-code flow carries NO pubkey today
  (device-code.ts:50-158; migrations/0004_auth.sql:17-26) — keypair
  generation moves to login start (NEW).
- "Existing account ws channel": WRONG — sockets are per-workspace DO
  (remote/api.ts:184-186; routes/sync.ts:30); account nudge = broadcast
  into the account's DOs (NEW, but over existing sockets/fanout).
- "rbox key rotate": DOES NOT EXIST (main-dispatch.ts:493-506); revoke
  exists but epoch/MK rotation is unbuilt design-22 debt
  (devices.ts:18-20; engine/e2ee/epoch.ts). Remediation copy uses
  `rbox key revoke` and §11 carries the rotation question.
- Reusable verbatim: single-use CAS + cap patterns (pairing.ts:91-97,
  155-166; device-code.ts:111-115), 10-min TTL semantics, ignore-by-
  default ws dispatch (daemon.ts:3111-3138), new-device email outbox
  (mint.ts:176-190).

## 11. Open questions for the review loop

1. Is `rbox key revoke` (access-revocation without MK re-key) honest
   enough remediation for a mistaken/malicious grant, or is epoch
   rotation (design 22) a hard PREREQUISITE for shipping 189?
2. Default-on vs staged for auto-fulfillment (founder default-on rule vs
   key-release stakes). Proposed: ON with guardrails 1-5 mandatory; bake
   condition = one fleet cycle + one external-user web-pairing observed
   clean.
3. Manual-fallback strength: is acknowledge-a-match sufficient, or
   should consent approvals REQUIRE the fragment path (manual entry gets
   device-auth only, like today)?
4. Should fulfillment require the daemon to be FOREGROUND-verified
   (recently active) or is any live daemon acceptable?
5. Pull-only daemons fulfilling (§8).

## 12. Out of scope

- Passkey/PRF escrow — design 190.
- Browser as key-holding device.
- Epoch rotation implementation (unless review rules it prerequisite).
- In-CLI/bar account-event feed (notification stays email for now).
- Changes to pairing-token or phrase flows.
