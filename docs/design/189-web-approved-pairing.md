# 189 — Web-approved pairing: auto-fulfilled key delivery

Status: DRAFT v3 — rewritten after round 1 (3 parallel codex reviewers, all
CHANGES-REQUIRED). v3 resolves every round-1 finding; rulings are pinned inline
with the finding id (A#/B#/C#). Ready for review round 2.

Related: 47 (device-code approval), 184 (one-command pairing), 180 (atomic
genesis), 187 (recovery destinations), 12 (device roster), 191 (epoch rotation —
FILED SEPARATELY, deferred; see §12.1). 190 (passkey escrow) is DECOUPLED (§9).

UX law (founder): the less the user manually types or copy/pastes, the better;
automatic binding > acknowledge-a-match > typing. Zero typed codes.

GOAL (founder, keep central): make onboarding not a hassle. Everything here
serves the common case — second machine, one existing machine online, keys
arrive automatically. Post-compromise recovery (epoch rotation) is explicitly
NOT this design's job (§12.1).

## 1. Problem

Web-UI device approval authorizes a new machine (device token) but cannot
enroll it for encryption — the web never holds key material. The new machine
stalls at "paste a pairing token or type your 24-word phrase"
(`DEVICE_CODE_ENROLL_STEP`, src/cli/auth-cmd.ts:72), which reads as a broken
promise. Roughest onboarding edge (2026-07-22 beta audit; founder 2026-07-23).

## 2. Constraint and the accepted threat delta (founder-ruled)

Non-negotiable: server and web never see key material.

Today's pairing token is SPLIT-SECRET (buildPairing, src/engine/e2ee/session.ts:442;
tokenSecret travels user->user, never through the server), so even a fully
malicious operator cannot extract keys. 189 relays an asymmetric wrap through
the server, so it is weaker against a fully-malicious operator than pairing.
It stays zero-knowledge against an honest-but-curious operator and, with §5's
guardrails, against web-session compromise.

FOUNDER RULING (Q1, 2026-07-23): a device that receives the MK can decrypt data
it already had — but a legitimately-synced device already has that data in
plaintext on disk, so MK retention grants nothing beyond device exposure.
`rbox device revoke` reliably severs FUTURE data-plane access (revoked token
401s, and download grants can only be minted by a live device — verified:
apps/api/src/auth/authenticate.ts rejects revoked=1; grant minting requires
auth), so a retained MK cannot fetch NEW ciphertext. Therefore forward-secrecy
re-key (epoch rotation) is NOT a prerequisite for 189. Accepted boundary,
stated in user-facing copy: "revoke stops future access; a key already
delivered to a machine cannot be un-delivered." Epoch rotation is design 191.

## 3. The mechanism (round-1 crux resolved)

The fulfilling daemon is a LIVE ADMIN in the roster. Unlike pairing (where the
admin is absent at redemption and must pre-sign a grant bound to a token-derived
admission key), the daemon here produces the COMPLETE signed admission itself:

1. New CLI, at `login` start, generates its sig+enc keypairs and submits the
   enc pubkey (SPKI) + a sig pubkey with `device/start`.
2. CLI opens the approval URL it already opens, with `fp = base64url(sha256(
   canonical(encPubKey||sigPubKey)))` in the URL FRAGMENT (never sent to the
   server). Fragment carriage rides the #412 redirect_url fix (§8) — the same
   round-trip 189 depends on.
3. Approval page: fresh re-auth (§5.3), then AUTOMATICALLY verifies the
   server-returned pubkeys hash to the fragment `fp` (no user typing). On a
   match the user taps Approve; the page obtains a server-issued, session-authed
   APPROVAL TOKEN binding {requestId, encPubKeyHash, sigPubKeyHash} and the
   server records the approval as authenticated.
4. Server queues a single-use, TTL-bound key_delivery row bound to those exact
   pubkey hashes, and nudges the account's online daemons (§6).
5. A daemon fetches the request, RE-VERIFIES the approval token was
   server-authed and the pubkeys match the approval binding (defeats a server
   that substitutes a pubkey AFTER an honest approval — A#3; a malicious server
   would have to forge the session-authed approval token, which is the §2
   operator-trust delta, stated). It then:
   - wraps MK to the new device's enc pubkey via rsaDeviceWrap
     (src/engine/e2ee/keys.ts:93 — confirmed it accepts an arbitrary foreign
     SPKI target), under a NEW context "rbox/mk-wrap/web-pair/v1" (domain
     separation, never reusing pairing/self-wrap contexts);
   - builds a full SignedRoster admitting the new device's exact sig+enc pubkeys
     and selfWrapHash, signed by the daemon as an active admin
     (buildAdmissionRoster path, session.ts:498-511) — the daemon signs BOTH the
     admission grant and delta because it is present and authoritative;
   - posts {mkWrap, signedRoster, accountEpoch} as opaque ciphertext+roster.
6. New CLI polls, receives it, unwraps MK with its enc private key, VERIFIES the
   roster is signed by an active admin AND admits its own exact pubkeys AND is at
   the current epoch, then persists via the existing enrollment path
   (e2ee-client.ts admission persistence). No token secret, no admission signing
   on the new-device side — the daemon did it.

This closes A#2/C#1 (admission authority present) and A#3 (the approval token +
roster-admits-my-exact-key check bind the pubkey end-to-end; a post-approval
substitution fails the new device's verification and cannot forge the
session-authed approval token without operator-level compromise).

## 4. Flow

```
new CLI                    browser (user)             API worker            enrolled daemon (admin)
gen sig+enc keypairs
device/start +encPub+sigPub ---------------------------> pending (pubkeys stored)
opens URL#fp=H(pubkeys) --> re-auth; AUTO-verify
                           server pubkeys == fp;
                           tap Approve -> approval
                           token{req,pubHashes} ------> approved + delivery QUEUED
                                                        (bound to pubkey hashes)
poll: keysPending                                       -- DO nudge --------> fetch req; re-verify
                                                                              approval+pubkeys;
                                                                              wrap MK->encPub;
                                                                              sign roster admitting
                                                                              this device
                                                        <-- blob+roster ----- post (CAS win)
poll: keysReady{blob,roster} <-- relay
unwrap MK; verify roster admits my exact keys @epoch; persist; ack -> admitted
```

Fallbacks when no daemon comes online in TTL: pairing token -> phrase. (190's
passkey rung is decoupled, §9.) One state line, never a mechanism menu.

## 5. Consent & threat model

Guardrails:
1. **Automatic pubkey binding** (fragment) — no typed codes. Manual navigation
   (no fragment) grants DEVICE-AUTH ONLY and MUST NOT deliver keys (Q3 ruling,
   unanimous A#5/B#9/C#7). The server refuses to queue a delivery for an
   approval that lacks a fragment-verified binding.
2. **Consent is explicit and separate** (B#9): a delivery is queued ONLY when
   the approval carries the new `keyConsent=true` + a fragment binding. Absent
   consent == today's device-auth (an OLD web page, which never sends consent,
   can never trigger delivery). The approve copy inverts today's
   "does not unlock your files" (+page.svelte:101-108) — deliberate.
3. **Fresh re-auth** (A#4): the approval token is minted only after a
   server-verified Clerk step-up with a strict max age; a cached bearer alone
   (api.ts:264) is rejected. Server binds the approval to the re-authed session.
4. **Notification** (A#10 adjacent): extend the existing new-device email
   outbox (apps/api/src/auth/mint.ts:176-190) with granted-keys wording + device
   fingerprint. No in-CLI/bar account-event feed is built here (deferred).
5. **Single-use + TTL + caps** (A#8/B#6): every transition (approve, poll,
   fetch, fulfill, consume) carries `expires_at > now`; expiry is monotonic and
   scrubs ciphertext. Separate per-account and per-approver delivery caps +
   duplicate-target suppression so botnet-seeded starts can't lock out real
   pairing.
6. **Full-strength fingerprint** (A#6): bind on sha256 of the canonical pubkeys
   (>=128-bit), never a display abbreviation.
7. **Approval-page XSS** (A#10): text-only rendering, no {@html}/innerHTML,
   strict CSP on the approval surface, regression test. Step-up stays
   server-enforced.
8. **Kill switch** (§12.2): per-account disable + per-daemon refuse.

Attack table (round-2 reviewers: extend): stolen session + attacker device
(re-auth + notification + revoke); malicious server post-approval substitution
(approval-token re-verify + roster-admits-my-key); replay/dup (single-use CAS,
loser scrubs); wrap-context confusion (new domain-separated context); pickup
crash (§7.3).

## 6. Server surface (apps/api) — new work

- `device_auth` gains nullable `enc_pub_key`, `sig_pub_key`, captured-at
  (schema has none today — apps/api/migrations/0004_auth.sql:17). **`status` is
  NOT extended** (B#8: account-link counts pending/approved —
  account-link.ts:344, 0014_account_linking.sql:77). Key-delivery is a SEPARATE
  table + state, never a new device_auth status value.
- `key_delivery` table {account, targetDeviceId, encPubKeyHash, sigPubKeyHash,
  approvalTokenHash, state `queued|fulfilled|delivered|expired`, wrap_blob,
  roster_blob, accountEpoch, created_at, expires_at}. Fulfill = conditional
  `UPDATE...RETURNING WHERE state='queued' AND expires_at>?` (exemplar
  pairing.ts:155). Pickup = `queued->` no; a distinct `fulfilled->delivered`
  CAS on client ACK so a dropped response doesn't lose the only blob (C#6, §7.3).
- Endpoints (B#5, all bounded/authed/rate-limited): device/start (+pubkeys),
  device/approve (+keyConsent, requires step-up, returns nothing secret),
  device/poll (adds a SEPARATE `keyDelivery: pending|ready{blob,roster}` field —
  legacy `status`/token semantics UNCHANGED so old CLIs are unaffected: B#2/C#4),
  a page endpoint returning the server-bound pubkeys for fragment compare, a
  daemon fetch-request endpoint, a daemon submit-blob endpoint, a client ack
  endpoint.
- Nudge (B#4): a worker-internal authed route enumerates the account's
  (workspace_id, project_id) rows and broadcasts {type:"key-delivery",
  requestId} into each DO via ws-fanout.broadcast (ws-fanout.ts:20), dispatched
  under waitUntil. Old daemons ignore unknown frames (verified,
  daemon.ts:3111-3138). Daemons with no bound workspace can't be nudged — poll
  fallback covers them (bounded delay).
- TTL sweep (B#7): a scheduled key_delivery sweep (worker.ts:200); scrub on
  every terminal transition; account purge deletes key_delivery
  (account-delete.ts:375). Migration `0032_key_delivery.sql` (append-only;
  re-check the number after rebase — migrations/README.md).

## 7. Daemon / CLI surface — new work

7.1 CLI login: generate keypairs BEFORE device/start (moved from enrollment,
e2ee-client.ts:438). Stage them in a NEW attempt-scoped journal keyed by
sha256(deviceCode) — NOT genesis paths (C#3: genesis staging is account-scoped
and account id is unknown at login start; reusing device.json trips the genesis
classifier, genesis-enrollment.ts:124). Journal has expiry, pubkey fingerprints,
ownership, and terminal states {abandoned, fulfilled}; supports concurrent login
attempts (each its own deviceCode key) so login B can't clobber login A's
material. Abandoned attempts are TTL-swept and never poison a real enrollment.

7.2 CLI poll: a finite state machine approved -> keysPending -> keysReady ->
admitted, with post-approval polling (the old loop returns on `approved` and
stops — auth-cmd.ts:977; the new field keeps it polling for keyDelivery),
deadlines, cancellation, fallback to pairing/phrase, and one state-line render.

7.3 Pickup crash-safety (C#6): retrieval is idempotent — the server keeps the
blob in `fulfilled` and only advances to `delivered` on the client ACK after the
new device has durably persisted keys + verified the roster. A crash between
keysReady and persist re-fetches the same blob; scrub happens on ACK or TTL.

7.4 Daemon fulfillment: a SEPARATE bounded flight independent of the sync mutex
(C#5: the daemon serializes through one pump + workspace mutex, daemon.ts:357;
fulfillment must not queue behind sync nor block on it). Verify: approval-token
server-auth, pubkey binding, current epoch/key-state hash, active source-device
identity, TTL; timeout + retry budget + stop-drain. "Freshness" = server-checked
approval-token age + current epoch, NOT a client foreground signal (Q4 ruling:
any authenticated live daemon may fulfill — C#8/B#12). Pull-only daemons may
fulfill ONLY with an explicit key-release opt-in, separate from the pull-only
push suppression (Q5 ruling — C#9/B#12: default-on §12.2 must not silently flip
this).

## 8. Dependency on the #412 redirect fix

189's fragment + the fresh-re-auth bounce both cross the unauthenticated ->
Clerk -> back round-trip that PR #412 repairs (root route now consumes a
validated redirect_url). 189 carries `fp` as part of the `/cli-login` query and
relies on #412 preservation — no parallel stash. The CLI must encodeURIComponent
the `fp` value (base64url can contain `-`/`_`, URL-safe, but the guard still
applies). #412 is a HARD PREREQUISITE and must merge first.

## 9. 190 is decoupled (was: shared ladder)

Round 1 unanimously found 190 (browser unwraps RK) violates "web never sees key
material" (A#1/B#1/C#2). 189 no longer claims a shared aligned ladder and does
NOT depend on 190. 190 returns to its own review for a native/opaque handoff on
its own timeline; the fallback after "no daemon online" is pairing token ->
phrase until 190 is redesigned and aligned separately.

## 10. Verified anchors (round-1 corrected)

- Admission needs AdmissionGrant+grantSig+admissionSig+PoP (roster.ts:158,
  session.ts:476) — the daemon-as-admin produces all of it (§3).
- rsaDeviceWrap takes a foreign SPKI (keys.ts:93) — reuse confirmed.
- Split-secret pairing wrap (session.ts:442); NOT a pubkey-targeted primitive.
- device-code carries no pubkey today (device-code.ts:50; 0004_auth.sql:17).
- ws is per-workspace DO (src/cli/remote/api.ts:181; routes/sync.ts:30); nudge =
  fan-out into the account's DOs (B#4).
- `rbox device revoke` is access-only, epoch rotation unbuilt (devices.ts:16-21);
  `rbox key revoke` is API keys (key-cmd.ts:119) — copy/command CORRECTED
  throughout (A#9/B#11).
- Reusable: single-use CAS + caps (pairing.ts:91,155), device-code claim CAS
  (device-code.ts:111), ignore-by-default ws dispatch (daemon.ts:3111), email
  outbox (mint.ts:176).
- Stale anchors from v2 (auth-cmd :66->:72; daemon barrel path; migrations repo
  path) all corrected here.

## 11. Rollout / client skew (B#10)

Deploy API first (accepts old + new shapes; pubkeys and keyConsent optional).
Then CLI (old CLI: no pubkeys -> no delivery queued -> today's flow; new CLI vs
old API -> capability-negotiated, degrades to today). Then web (old page: no
consent -> device-auth only). No client ships before the API that understands it.

## 12. Rulings on §11 open questions

12.1 **Q1 — epoch rotation: NOT a prerequisite** (founder, §2). Ship 189 with
honest "can't un-deliver a key" copy; `rbox device revoke` severs future access.
Epoch rotation = design 191 (backs `device revoke` product-wide, its own doc).

12.2 **Q2 — default-on**: with Q1 resolved, default-on is acceptable WITH
guardrails 1-7 all mandatory + kill switch. Bake condition (named): one full
fleet cycle + one external-user web-pairing observed clean end-to-end before the
default flips on for external accounts. Pull-only key-release stays opt-in
regardless (Q5).

12.3 **Q3 — manual acknowledge**: fragment REQUIRED for key delivery; manual =
device-auth only (unanimous).

12.4 **Q4 — foreground**: not required; any authenticated live daemon may
fulfill, server-verified freshness (unanimous).

12.5 **Q5 — pull-only**: may fulfill only with explicit key-release opt-in
(unanimous).

## 13. Out of scope

- Passkey/PRF escrow — design 190 (decoupled).
- Epoch rotation — design 191.
- In-CLI/bar account-event feed (email only).
- Changes to pairing-token or phrase flows.
