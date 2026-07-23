# SPEC 189 · Unit 1 — apps/api server surface (the wire contract)

Implement the SERVER half of design 189 (docs/design/189-web-approved-pairing.md
— READ §2, §3, §5, §6, §11, §12, §14 in full; this spec is the build order, the
doc is the authority on intent). This unit defines the wire shapes the CLI,
daemon, and web units import next, so correctness of the request/response schemas
and the D1 state machine is the priority. Do NOT implement the daemon, CLI, or
web here.

## Objective

Add web-approved key delivery to the device-code flow: capture the new device's
pubkeys at start, gate approval behind a fresh Clerk step-up + explicit key
consent + fragment-verified pubkey binding, queue a single-use TTL-bound
`key_delivery` request, nudge the account's online daemons, relay a daemon-posted
ciphertext blob + published roster version to the polling CLI, and fence the
whole thing on device revocation. Server relays only ciphertext; it never sees
key material.

## Files / areas (verify each anchor before editing — they may have drifted)

- `apps/api/migrations/0033_key_delivery.sql` (NEW — 0032 is taken; append-only,
  re-check number if you rebase — apps/api/migrations/README.md).
- `apps/api/src/auth/device-code.ts` — start (+enc_pub_key,+sig_pub_key), approve
  (+keyConsent, step-up gate, atomic approve+queue), poll (+keyDelivery field;
  legacy status/token UNCHANGED), the mint/claim/retarget path (atomic + token
  escrow).
- `apps/api/src/auth/mint.ts` — token escrow keyed by requestId (encrypted at
  rest; recover on authed re-poll within TTL).
- `apps/api/src/auth/devices.ts` — revokeDevice: cancel+scrub the target's
  undelivered key_delivery rows in the SAME transaction; export a helper the
  delivery transitions call to recheck revoked=0.
- NEW `apps/api/src/auth/key-delivery.ts` — the key_delivery table accessors:
  queue, daemon-fetch-request, daemon-submit-blob, client-poll/ack, TTL sweep.
  All transitions guard `expires_at > now` AND target `devices.revoked = 0`.
- `apps/api/src/routes/auth.ts` (+ routes/shared.ts if needed) — wire the new
  endpoints: page pubkey-echo (for fragment compare), daemon fetch-request,
  daemon submit-blob, client ack. Bounded, authed, rate-limited.
- `apps/api/src/ws-fanout.ts` + a worker-internal nudge: on queue insert,
  enumerate the account's (workspace_id, project_id) rows and broadcast
  `{type:"key-delivery", requestId}` into each DO via ws-fanout.broadcast under
  waitUntil. Old daemons ignore unknown frames — do not change the frame
  dispatcher.
- `apps/api/src/worker.ts` — add a scheduled key_delivery TTL sweep alongside the
  existing sweeps (do NOT reuse sweepNotifications).
- `apps/api/src/account-delete.ts` — delete key_delivery rows in the purge path.
- `apps/api/wrangler.jsonc` — new rate-limit namespaces for approve/fetch/submit/
  ack (mirror the existing device-code limiter style).

## Hard constraints (from the aligned design — do not deviate)

1. `device_auth.status` is NOT extended (account-link counts pending/approved —
   account-link.ts, 0014_account_linking.sql). key_delivery is a SEPARATE table
   with its own state `queued|fulfilled|delivered|expired`.
2. Delivery is queued ONLY when approval carries keyConsent=true AND a
   fragment-verified pubkey binding AND a fresh Clerk step-up (strict max age;
   reject a cached-bearer-only approval). Absent any → device-auth only (today's
   behavior); an OLD web page without keyConsent can never trigger delivery.
3. requestId = sha256(device_code). key_delivery binds encPubKeyHash,
   sigPubKeyHash, approvalTokenHash, targetDeviceId (RETARGETED to the actually
   minted deviceId — mint can re-mint on a uniqueness collision), accountEpoch.
4. Atomicity: (approve + queue) is ONE D1 batch; (claim + mint + retarget +
   token-escrow) is ONE D1 batch. A crash after commit but before HTTP response
   must be recoverable by an authed re-poll keyed by requestId (idempotent: same
   token, no second mint; concurrent polls converge).
5. Single fulfillment: `UPDATE ... RETURNING WHERE state='queued' AND
   expires_at>? AND <target not revoked>` (mirror pairing.ts single-use). Blob
   stays in `fulfilled`; `fulfilled->delivered` CAS fires ONLY on the client ACK,
   which requires `p.deviceId = targetDeviceId AND expires_at>now`; a lost-ACK
   re-ACK returns idempotent already-delivered. Scrub blob on delivered/expired.
6. Caps: per-account active-delivery cap = 5 via atomic INSERT...SELECT...WHERE
   count<cap (pairing.ts pattern); one live delivery per (account,encPubKeyHash)
   (duplicate-target uniqueness); delivered/expired excluded from the count.
7. TTL = 10 min (mirror pairing PAIR_TTL_MS). Every transition guards expiry;
   expired/delivered never revive.
8. The server stores/relays ONLY opaque ciphertext (wrap_blob) + roster metadata
   (published roster version); it never parses or holds key material.
9. Migration is append-only; the config-time guard in apps/api/vitest.config.ts
   fails on a number collision — 0033 must be free after any rebase.

## Out of scope (other units)

Daemon fulfillment, CLI login FSM/staging, web approval page. Do NOT touch
src/cli/** or apps/web/**. Provide the wire shapes those units will import
(document them in a short WIRE-189.md the other units will read).

## Acceptance criteria (must go green)

- `cd apps/api && bun run typecheck` (or repo `bun run typecheck`) clean.
- `bun run test:api` passes, INCLUDING new tests you add for: approve gates
  (no consent → no delivery; old-shape approve → device-auth only; stale step-up
  rejected), the queue/fulfill/deliver/ack CAS single-use + idempotent re-ACK,
  the crash-recovery re-poll (claim+mint+escrow recoverable by requestId; no
  double mint; concurrent polls converge), the revoke fence (revoke cancels
  undelivered rows; a revoked target can't fetch/fulfill/deliver), cap +
  duplicate-target enforcement, and TTL expiry on every transition.
- `bun run guards` clean.
- Migration applies cleanly against a fresh DB in the test harness.

Write WIRE-189.md documenting the exact request/response JSON for every new
endpoint + the poll keyDelivery field — the CLI/daemon/web units build against it.
Do NOT commit; leave the tree dirty for review here.
