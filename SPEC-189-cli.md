# SPEC 189 · Unit 2 — CLI login FSM + attempt-staging journal

Implement the NEW-MACHINE CLI half of design 189. READ the aligned doc
docs/design/189-web-approved-pairing.md (§3 steps 1-2 & 6, §7.1, §7.2, §8, §14)
and WIRE-189.md (the exact endpoint/field shapes produced by Unit 1 — bind to
THOSE names). Do NOT touch apps/api, apps/web, or the daemon.

## Objective

At `rbox login` start, generate the device's sig+enc keypairs, submit the
pubkeys with device/start, carry a fingerprint fragment on the opened approval
URL, and drive a finite-state poll loop that — after web approval — receives the
relayed {mkWrapDevice, publishedRosterVersion}, verifies the full roster chain
and that the published roster admits its own exact pubkeys at the current epoch,
unwraps MK, stores the wrap AS-IS, persists device.json, and ACKs. Falls back to
pairing-token -> phrase when no daemon fulfills within TTL.

## Files / areas (verify anchors)

- `src/cli/auth-cmd.ts` — runDeviceCodeLogin poll loop (~:977-1023 today returns
  on `approved`): extend into the FSM approved -> keyDelivery pending -> ready ->
  admitted; the approval-URL open site (~:1028+) appends `#fp=<JCS hash>`;
  keypair generation moved to login start.
- NEW `src/cli/genesis-... or login-attempt journal` — attempt-staging keyed by
  sha256(device_code): stores the generated sig+enc keypairs with expiry, pubkey
  fingerprints, ownership, terminal states {abandoned,fulfilled}. NOT genesis
  paths (genesis staging is account-scoped; account id unknown at login start;
  reusing device.json trips the genesis classifier). Support concurrent login
  attempts (each its own device_code key); TTL-sweep abandoned attempts so they
  never poison a real enrollment.
- `src/cli/e2ee-client.ts` — a new enrollViaWebDelivery(...) mirroring
  enrollViaPairing (:416-450) MINUS the token secret: it does NOT generate keys
  or self-wrap (the daemon produced the device-context wrap); it VERIFIES the
  fetched roster chain (verifyRosterChain), confirms the published roster admits
  its own exact pubkeys @epoch and mkWrapDevice hashes to the roster mkWrapHash,
  unwraps MK with the staged enc private key, stores mkWrapDevice AS-IS
  (openOwnMasterKey accepts device context), persists via the existing keystore.
- `src/engine/e2ee/*` — REUSE verifyRosterChain, rsaDeviceUnwrap/openOwnMasterKey,
  the keystore serialize path. Do not add new crypto primitives.

## Hard constraints

1. Keypairs generated at login START (not enrollment); staged crash-safely and
   REUSED across restart/retry (the same deviceKeys-reuse discipline pairing uses
   across 409). A crash between login and enrollment must not strand a half
   device nor poison a later real enrollment.
2. `fp = base64url(sha256(JCS({encPubKeySpki, sigPubKey})))` with exact
   Ed25519(32B) + RSA-SPKI validation before hashing; carried in the URL FRAGMENT
   (never a query param the server sees).
3. Legacy device-code semantics preserved: the FSM must still complete an
   ordinary (no-key-delivery) device-code login exactly as today when the poll
   returns no keyDelivery; `claimed` responses carry keyDelivery pending|ready so
   the loop continues after the auth claim.
4. The new device NEVER signs a roster and NEVER re-wraps MK — it verifies the
   daemon-published roster + stores the delivered wrap as-is.
5. Fallback ladder when TTL elapses with no delivery: pairing token -> phrase,
   rendered as ONE state line (never a mechanism menu). 190's passkey rung is
   decoupled — do not reference it.
6. Token recovery: if the bearer response was lost mid-claim, an authed re-poll
   (keyed by requestId=sha256(device_code)) recovers the credential per WIRE-189.
7. All prompt output through the Ink prompt facade (src/cli/prompt.ts) — this
   rides on the just-shipped TUI; one state line.

## Acceptance criteria

- `bun run typecheck` clean; `bun run guards` clean.
- New unit tests: the FSM transitions (approved->pending->ready->admitted +
  legacy no-delivery path + fallback on TTL), attempt-journal crash-safety
  (staged keys reused across a simulated restart; concurrent attempts isolated;
  abandoned swept), enrollViaWebDelivery verification (rejects a roster that
  doesn't admit its own keys / wrong epoch / mkWrap-hash mismatch / a chain
  whose signer wasn't an active admin), and the token-recovery re-poll.
- A boundary crash-injection test per §14 (kill after keysReady before persist /
  after persist before ACK — re-fetch idempotent, enrollment completes once).

Do NOT commit; leave the tree dirty for review here.
