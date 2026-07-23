# 190 — Passkey-wrapped key escrow

Status: DRAFT — founder problem statement + sketch (2026-07-23). Thinner
than 189 by intent: it is the second rung of the shared key-arrival
ladder (189 §9) and further from implementation. Full adversarial loop
required; the codex round must have 189 visible (shared seam).

## 1. Problem

If no enrolled machine is online (189's rung fails) — or none exists at
all — key arrival falls back to the 24-word phrase. For the "lost every
machine" case the phrase is the ONLY way in, and less-technical users are
the least likely to have it durably saved. Mainstream E2EE products solve
this with hardware-backed escrow; rbox's version should be the passkey
the user already has for web login.

## 2. Mechanism sketch

- At enrollment time (any machine already holding keys, with a browser):
  derive a stable secret from the user's passkey via the WebAuthn PRF
  extension, use it as a KEK to wrap the recovery key (RK), and store
  ONLY the resulting ciphertext blob server-side. The server never sees
  the PRF output or the RK; the passkey's private key lives in the
  authenticator (platform keystore / security key / iCloud-synced).
- At recovery time on a new machine: `rbox login` (or the 188 home
  screen) opens the browser; the web app authenticates, invokes the same
  passkey with PRF, unwraps the RK CLIENT-SIDE in the browser, and hands
  it to the CLI over the localhost loopback callback (OAuth-CLI pattern,
  one-time code, never through the server). CLI proceeds exactly as
  `rbox key recover` does from a typed phrase.
- The CLI never needs WebAuthn itself; the browser is a transient
  compute surface, not a key-holding device (RK is wiped from browser
  memory after handoff — same hygiene rules as the CLI's phrase paths).

## 3. Security posture (for the review to attack)

- Server holds ciphertext only; unwrap requires the physical/platform
  authenticator. Account takeover alone (password/session) is not
  sufficient — the passkey ceremony with PRF is.
- The blob is an ADDITIONAL wrap of the same RK — the phrase keeps
  working; nothing existing is weakened. Escrow is opt-in and revocable
  (delete the blob; `rbox key rotate` invalidates it).
- Known hard edges for review: PRF availability across authenticators
  and browsers (feature-detect; enroll only when PRF works, honest copy
  otherwise); passkey loss = escrow loss (phrase remains the floor);
  synced-passkey trust (iCloud/Google custody of the authenticator —
  disclose in copy?); loopback handoff hardening (bind the one-time code
  to the login attempt, TTL, single use).

## 4. UX composition (binding, from 189 §9)

- Escrow enrollment is offered ONCE, as a checkbox row in the existing
  187 destination multi-select ("Passkey (this account's passkey)") when
  PRF support is detected — NOT as a separate flow or extra screen.
- Recovery is rung 2 of the single key-arrival ladder; the user sees one
  state line, never a mechanism menu. If both 189 and 190 are available,
  189 wins (no browser round-trip); 190 engages only when no machine is
  reachable.
- Never present passkey escrow as replacing the phrase; the phrase is
  still the floor ("if you lose every machine AND your passkey").

## 5. Out of scope

- Replacing pairing, the phrase, or Keychain (all remain).
- Multi-passkey escrow policy, org/team accounts.
- Any server-visible key material (never).
