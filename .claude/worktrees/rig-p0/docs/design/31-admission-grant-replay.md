# §31 — Admission-grant `notAfter` bricks multi-device accounts

**Status:** DRAFT v2 — codex security review CONFIRMED the core fix ("BLOCKER: None for the
narrow verifyRosterChain change… removing the replay-time notAfter check is the right fix").
The NEEDS-WORK was adjacent hardening the fix makes reachable; v2 folds in MAJOR 1 (epoch
signer) + MAJOR 2 (scrub mkWrap) + the MINORs, and defers MAJOR 3 (admit↔redeem link) as a
documented fast-follow. Next: codex re-review of the implementation.

## The bug (P0, dogfood-confirmed 2026-06-30)

Adding a second device to an account makes the account **unusable ~10 minutes later**.
Every `rbox push`/`pull`/`sync` calls `refreshAccount()` →
`verifyAccount(rosters, …, now)` → `verifyRosterChain`, which **replays the roster
history from genesis** and, for the roster version created by the pairing, re-checks:

```
roster.ts:287   if (grant.notAfter < opts.now) throw new Error("admission grant expired");
```

The pairing grant's `notAfter = pair_time + 10min` (`auth-cmd.ts:131`). So 10 minutes
after pairing, *every* verification throws `admission grant expired` — permanently. The
account is bricked for all sync. Observed: a 55-min-old paired account failed in 1s.

## Root cause

`notAfter` is a **liveness** bound ("use this grant before T") but it is enforced on
**historical replay** against the verifier's *current* clock. There is no trusted
timestamp on a roster version (the server's `created_at` is untrusted), so a replaying
client cannot tell "this admission is being applied now" (check `notAfter`) from "this
admission happened in the trusted past" (don't). The design (12-full-e2ee §V4-1) made
admission **offline-verifiable, "never a server mutation"**, pushing *all* enforcement —
including this liveness bound — onto every client's genesis replay. That's the flaw.

## What `notAfter` actually guards — and what already covers it

`notAfter` (grant) bounds the window to *use* a grant to admit a device. But:

1. **Single-use `grantId`** (random 128-bit, "unseen in roster ancestry") is enforced
   offline by every client (`roster.ts:288`). A grant admits **exactly one** device,
   ever. This is the primary anti-abuse and is unaffected by this change.
2. **A *useful* admission requires the master key (MK).** MK reaches the new device only
   via the pairing token's `mkWrap`, returned **only** by a redeem that is single-use AND
   within TTL: `UPDATE pairing_tokens SET consumed_at=? WHERE consumed_at IS NULL AND
   expires_at > ? RETURNING mk_wrap` (`auth.ts:206`, `PAIR_TTL_MS = 10min`). After the
   window, no `mkWrap` → no MK → an admitted device **cannot decrypt any workspace data**.
   The server enforces this freshness with its real clock — it is the actual liveness gate.

So the practical freshness window is already enforced **server-side** by the pairing-token
TTL (the MK delivery), and reuse is prevented by the single-use `grantId`. The grant's
`notAfter`, re-checked on client replay, adds marginal security over those two — at the
cost of bricking every multi-device account.

## Fix

**Remove the `notAfter` check from `verifyRosterChain` replay** (`roster.ts:287`). Keep
everything else (grantSig by an active admin, admissionSig proving `tokenSecret`
possession, exactly-one-device delta, single-use `grantId`, monotone version). Admission
freshness remains enforced where it can be against a trusted clock: the **pairing-token
TTL** (server, MK delivery). `VerifyOptions.now` stays (key-state/epoch checks may use it);
only the grant-`notAfter` comparison is dropped.

Net: a stale or leaked grant can no longer be *used* to obtain MK (token expired), can
admit at most one device (single-use), and replay of the legitimately-admitted history no
longer self-destructs.

## Adjacent hardening folded in (codex round 1)

- **MAJOR 1 — epoch signer authorization (`epoch.ts`).** The no-MK rogue-admin residual was
  amplified to a *strong DoS*: `signerRosterFor()` authorized an epoch-`e` key-state against
  the roster `e` itself pins, so a just-admitted device could sign the rotation that pins the
  roster containing itself → rotate the account to attacker-chosen MK and force clients to
  reject prior-epoch heads. (The §31 un-brick is what makes this persist.) **Fix:** authorize
  the epoch-`e` signer against **`states[e-1].rosterVersion`** (the previous epoch's roster) —
  which is what the function's own doc comment already said. A rotation must be signed by a
  device that held authority *before* it.
- **MAJOR 2 — scrub at-rest MK material (`auth.ts`).** The pairing-token TTL is an *API*
  freshness gate, not cryptographic expiry: the DB **retained** `mk_wrap`/`admission_grant`
  after redeem, so a later `tokenSecret` leak + DB access could recover MK. **Fix:** null both
  columns on successful redeem (the doc no longer claims "no mkWrap exists after TTL"). Expired-
  row cleanup is a noted follow-up.

## Residual risk (state it plainly for review)

A leaked **grant + `tokenSecret`** used *within* the 10-min token window could still admit
a device — unchanged from today (that window is the token TTL, which we keep). Used *after*
the window, the admitted device gets **no MK** (can't read any plaintext, ever), but is a
roster `role:"admin"` principal (v1: every active device is admin). With MAJOR 1 fixed it
can no longer self-authorize an **epoch rotation** (the strong DoS), but as an accepted
admin it can still sign **arbitrary roster rewrites** (revoke devices, admit more, mutate
entries) — a **DoS-only** residual (no read), recoverable via the recovery phrase, and
requiring a full pairing-token-material compromise (`tokenSecret`) to even reach.

This residual is **not newly introduced** by dropping `notAfter` (today it's blocked only on
client replay, and only until the brick). The proper closure is **MAJOR 3 (deferred
fast-follow §31.1): link `/v1/keys/admit` to an in-window consumed pairing token** — record
`grantId`/`consumed_at`/redeemed-device at `/pair/redeem`, and have `/admit` require the
roster signer match the redeemed device and the grant come from a still-in-window consumed
token. That is server-side *defense-in-depth* (not admission authority) and avoids late
admission entirely. Deferred because it adds schema + redeem/admit changes and the residual
is DoS-only behind a serious compromise; tracked for §31.1.

## Alternative considered (rejected)

**Pin-anchored `notAfter`:** check `notAfter` only for versions above the client's trusted
pin (treat ≤pin as trusted history). Rejected: a device that is **offline past the 10-min
window** when a sibling pairs would, on return, see the new admission as "above its pin and
expired" → reject the legitimate device forever. Same brick, narrower trigger. The
pairing-token TTL already provides the only soundly-clock-anchored freshness gate.

## Test plan

- Unit (engine, bun): `verifyRosterChain` accepts a chain whose admission grant's
  `notAfter` is in the PAST (the brick repro) — must verify clean now; single-use `grantId`
  replay/dupe still rejected; admin/admission sig tampering still rejected.
- Integration: re-pair flat-meadow, wait past 10min, `rbox push`/`pull` succeed across both
  hosts.
- Regression: existing e2ee roster/admission tests stay green.
