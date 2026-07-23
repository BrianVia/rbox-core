# SPEC 189 · Unit 3 — daemon fulfillment flight

Implement the FULFILLING-DAEMON half of design 189. READ the aligned doc
docs/design/189-web-approved-pairing.md (§3 step 5, §7.4, §14) and WIRE-189.md
(exact endpoint/field shapes from Unit 1 — bind to THOSE names). Do NOT touch
apps/api, apps/web, or the CLI login path.

## Objective

On a `{type:"key-delivery", requestId}` WS nudge (or the next poll cycle), an
enrolled admin daemon fetches the queued delivery, verifies it, wraps the MK to
the new device's enc pubkey under the persisted device context, builds an
admin-signed roster admitting that device, PUBLISHES the roster server-side
atomically, and posts the ciphertext blob + published roster version. Crash-safe
and idempotent; never blocks sync.

## Files / areas (verify anchors)

- `src/cli/daemon/daemon.ts` — the WS dispatcher (~:3111-3138) currently
  ignore-by-default: add handling for the new frame that ENQUEUES a fulfillment
  onto a SEPARATE bounded flight (NOT the sync pump/mutex ~:357 / :1533 — must
  not queue behind or block sync). Also drive fulfillment on the ordinary poll
  cycle for daemons with no bound-workspace socket.
- NEW `src/cli/daemon/key-delivery-fulfill.ts` — the fulfillment flight: fetch
  request, verify, wrap+build-roster+publish, post, with a per-flight timeout,
  retry budget, jittered backoff, and stop-drain on daemon shutdown.
- `src/engine/e2ee/*` — REUSE: rsaDeviceWrap (foreign SPKI) under
  deviceWrapCtx/"rbox/mk-wrap/device/v1"; buildAdminRoster (the daemon is an
  active admin, so no admission proof); wrapHash. Do NOT add crypto primitives or
  new wrap contexts.
- The daemon's own MK/roster access (however the daemon holds account key state
  today) — to sign as admin and read the current head roster.

## Hard constraints

1. Verify BEFORE wrapping: approval-token server-auth, pubkey binding matches the
   request, current account epoch, active source-device, TTL not expired, target
   device not revoked (WIRE-189 fetch response carries what's needed).
2. Wrap MK to the new device's enc pubkey ONCE under the PERSISTED device context
   (no transport context, no client re-wrap). Commit THAT wrap's hash as the
   roster entry's mkWrapHash.
3. CRASH-SAFE IDEMPOTENT publish: stage {wrap, signed-roster} keyed by requestId
   BEFORE publishing and reuse those exact bytes across restart/retry (RSA-OAEP
   is randomized — a re-wrap would produce non-matching bytes). Publish via the
   existing monotone roster append (409 on stale parent). On 409/retry: REFETCH;
   if the target device+roster row already exists, ADOPT the committed wrap (read
   it back and post THAT) rather than requiring own-bytes match; re-sign only if
   the row is genuinely absent.
4. "Live/fresh" = the authenticated fetch arrived now + approval-token age +
   current server epoch — NOT last_seen_at, NOT WS presence.
5. Pull-only daemons fulfill ONLY when a separately-persisted keyReleaseOptIn is
   set (pull-only today only suppresses pushes). Default follows the design's
   default-on rule for RW daemons; pull-only stays opt-in regardless.
6. NEVER blocks or is blocked by sync; fulfillment is a separate bounded flight.
7. Kill switch: a per-daemon setting to refuse fulfillment.

## Acceptance criteria

- `bun run typecheck` clean; `bun run guards` clean.
- New unit tests: verify-then-wrap gating (rejects expired / wrong-epoch /
  revoked-target / mismatched-pubkey requests before any wrap), the admin-roster
  build + publish happy path, the crash-safe-reuse (staged bytes reused across a
  simulated restart; ADOPT-committed-wrap on a post-publish crash — no double
  insert, PK respected), the 409 rebase/re-sign when the row is absent, pull-only
  gated by opt-in, and never-blocks-sync (fulfillment runs off the sync mutex).
- A boundary crash-injection test per §14 (kill after stage / after
  publish-commit-before-response / after blob-post; resume reuses or adopts,
  never double-inserts, never posts a wrap whose hash != roster commit).

Do NOT commit; leave the tree dirty for review here.
