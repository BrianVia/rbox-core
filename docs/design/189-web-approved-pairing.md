# 189 — Web-approved pairing: auto-fulfilled key delivery

Status: DRAFT — founder problem statement + first proposal (2026-07-23).
Needs the full adversarial review loop before any implementation; the crux
is the consent model (§5), not the plumbing.

Related: design 47 (device-code browser approval), 184 (one-command
pairing), 180 (atomic genesis), 187 (recovery destinations), 188 (home
screen — consumes this, separate design).

## 1. Problem

Approving a new machine from the web UI authorizes it (device token) but
cannot enroll it for encryption — the web never holds key material. The
new machine then stalls at "paste a pairing token from another machine or
type your 24-word phrase", which reads as a broken promise: the user just
proved account ownership in the browser and is asked to prove it again,
with a different machine in hand. This is the roughest remaining
onboarding edge (beta-tester friction, 2026-07-22 audit; founder hit it
again 2026-07-23 on the desktop).

## 2. Constraint (unchanged, non-negotiable)

The server and web UI never see key material. Any design where a web
session alone suffices to produce a decrypting machine is out of scope —
that is the zero-knowledge line ("private even from us" is shipped copy).
What CAN change: an existing enrolled machine may release keys
automatically, with the web approval acting as the user's consent signal.

## 3. Proposal in one paragraph

When the user approves a new device in the web UI, the approval carries an
explicit "send this machine my encryption keys" consent. The server
queues a single-use, short-TTL key-delivery request bound to the approved
device's enrollment public key. Any enrolled, online daemon on the
account receives the nudge over its existing server WebSocket, performs
the SAME master-key wrap that `rbox pair` performs today — targeted at
the bound public key — and posts the resulting ciphertext blob over
authenticated HTTPS. The new machine's `rbox login` poll loop (already
polling for device-code approval) gains one more state and picks the blob
up, unwraps locally, and completes enrollment exactly as if a pairing
token had been redeemed. The server relays only ciphertext.

## 4. Flow

```
new machine                web UI                    server            enrolled daemon
rbox login ── device code ──────────────────────────▶ pending
   │            user approves + consents             device approved
   │            (sees fingerprint)                   key request QUEUED
   │                                                  (pubkey-bound,
   │                                                   single-use, TTL)
   │ poll: approved,                                  ── ws nudge ────▶ verify request
   │ keys pending…                                                     wrap MK → pubkey
   │                                                  ◀── HTTPS blob ── post wrap (CAS)
   │ poll: keys-ready ◀── ciphertext relay
   ▼ unwrap locally, enroll (same path as pairing redemption)
```

- Transport is entirely existing machinery: daemon↔server WS for the
  wakeup, HTTPS for blob post/fetch, the login poll loop for pickup.
  No daemon-to-daemon channel exists or is introduced.
- If no daemon is online within the TTL, login falls back to today's
  options (pairing token / phrase / Keychain) with honest copy: "none of
  your machines are reachable right now."

## 5. Consent & threat model (the crux)

Threat: web session compromise upgrades from "annoying" to "attacker
enrolls a decrypting device."

Proposed guardrails (each needs review):
1. **Explicit consent wording** on the approval page — approving is
   labeled as granting keys, not just sign-in ("Allow this machine to
   receive your encryption keys?"), separate from plain device auth.
2. **Fingerprint binding**: the new machine's CLI displays a short
   fingerprint of its enrollment public key; the web approval page shows
   the same fingerprint; the fulfilling daemon wraps ONLY to the pubkey
   bound at approval time (no later substitution — the request is
   immutable once queued).
3. **Recent re-auth**: the approval page requires a fresh Clerk
   re-authentication (not a week-old session cookie).
4. **Fleet notification**: every enrolled device surfaces "machine X was
   granted keys via web approval at T — if this wasn't you: rbox key
   rotate" through status/bar surfaces.
5. **Single-use + TTL** (mirror pairing-token semantics, 10 min) +
   existing device cap + rate limit on queued requests.
6. **Kill switch**: config/env to disable auto-fulfillment per account or
   per daemon (pull-only daemons: see open questions).

Open question for review: default-on vs staged. Founder default-on rule
applies to new behavior, but key-release consent is plausibly a "named
bake condition" case — proposal: ship ON with guardrails 1–5 mandatory
and the kill switch present, and name the bake condition as one full
fleet cycle + one external-user pairing observed clean.

## 6. Server surface (apps/api)

- Device-approval record gains: enrollment pubkey + fingerprint captured
  at code redemption; consent flag from the approval UI.
- New resource: key-delivery request {account, targetDeviceId,
  targetPubKey, state: queued|fulfilled|expired, createdAt, wrapBlob?}.
  Single fulfillment via CAS; blob is opaque ciphertext; expired requests
  and blobs are deleted (TTL sweep).
- WS: one new frame type nudging enrolled daemons; poll endpoint change:
  device-code poll response gains keysReady/keysPending states.
- D1: one migration (append-only numbering rules apply).

## 7. Daemon / CLI surface

- Daemon: handle the nudge; verify account + request freshness + pubkey
  binding; reuse the pairing wrap primitive (engine/e2ee buildPairing
  path); post blob; emit a status event for guardrail 4. Never blocks
  sync; fulfillment is best-effort with jittered retry.
- New machine CLI: login poll consumes keysReady, unwraps, then runs the
  existing post-pairing enrollment path (device.json/mk.key writes are
  the already-hardened genesis/pairing primitives). On TTL expiry, print
  the fallback options.
- `rbox pair` stays; this is additive.

## 8. Failure modes to design for (review checklist)

- Two daemons fulfill concurrently → CAS single-winner; loser discards.
- Daemon crashes mid-wrap → request stays queued until TTL; retry safe
  (wrap is deterministic-per-attempt and idempotent server-side by CAS).
- New machine dies before pickup → blob expires with TTL; nothing durable
  leaked (ciphertext only).
- Approval granted but consent declined → device authorized, no key
  request queued (today's behavior).
- Pull-only daemons: may they fulfill? (They hold the MK; proposal: yes —
  fulfillment is not a push. Review.)
- Client skew: old daemons ignore the unknown ws frame (must verify frame
  handling is ignore-by-default); old CLIs never see keysReady (poll
  response additive).

## 9. Composition with 190 (passkey escrow) and 188 (home screen)

189 and 190 are separate designs with separate threat models, but they
MUST present as one user story. The contract: `rbox login` runs a single
key-arrival ladder and the user sees ONE state line, never a menu of
recovery mechanisms —

1. an enrolled machine is online → keys arrive automatically (189);
2. none online, passkey escrow exists → "unlock with your passkey" (190);
3. neither → today's pairing token / phrase / Keychain options.

The ladder lives in the login/setup flow (and later the 188 home screen
renders its state); designs 189 and 190 each implement one rung and share
the "keys pending → keys ready" poll states. Per the parallel-design
rule, the codex review round for either doc must have BOTH docs visible
(shared seam: the ladder and the poll-state contract).

## 10. Out of scope

- The passkey/PRF escrow mechanism itself — design 190.
- Browser as a key-holding device.
- Any change to pairing-token or phrase flows.
