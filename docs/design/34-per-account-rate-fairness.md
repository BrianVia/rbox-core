# §34 — Per-account rate-limit fairness + backpressure

**Status:** DRAFT v2 — **codex round-3 PASS** ("for a design-only, pre-implementation spec,
this is now sound"). Round-1 (NEEDS-WORK) found 1 BLOCKER (overclaiming "token-bucket
fairness") + 3 MAJORs (thundering-herd on a fixed window / unbounded retry; old-client
bricking on enforced 429; commit-bucket abuse hole); round-2 (NEEDS-WORK) found 2 MAJORs
(AIMD overloading the fail-fast `poolMap`; the capability gate overclaiming enforcement).
v2 folds them all in: the mechanism is described honestly as an **approximate per-colo
throttle** (not a fairness *guarantee*) with stated overshoot; blob 429s get **jittered
job-level retry, only-429 = throttle vs 5xx/network = bounded-then-surfaced**, with a
progress ceiling; AIMD lives in a **separate adaptive pool** so the fail-fast primitive is
untouched; enforcement is a **client-capability compatibility valve** with a later
default-enforce / `upgrade_required` path; the commit bucket is **account-keyed +
spam-capped**. Design only, no implementation. Goal (scoped honestly): one heavy *legit*
account can't trip global Cloudflare limits or starve others **at the app layer**, and a
legit large push *slows down* (throttle), never *fails* (reject); a determined
header-stripping DoS stays the WAF's job. Next gate: implementation diff.

## Problem (empirically confirmed, this session 2026-06-30)

During a zero-knowledge `grep` (a storm of rapid blob `GET /v1/blobs/:sha`) we hit
**Cloudflare WAF / rate throttling — HTTP 403s** on the blob hot path, resolved only by
inserting client-side delays. That is the canary. The structural cause:

- A single `rbox push` fans out up to **64 concurrent R2 PUTs**
  (`uploadConcurrency()` default `64`, `src/cli/sync.ts:69`; debited through
  `poolMap(missing, uploadConcurrency(), …)`, `src/cli/sync.ts:118`).
- Pull/download fans out the **same 64** (`dlConc … ?? 64`, `src/engine/apply.ts:80`;
  `poolMap(rest, dlConc, …)`, `src/engine/apply.ts:81`).
- At ~100 users that is **thousands of concurrent ops** against one Worker + R2 bucket.
- There is **no per-account fairness anywhere today.** Every authed request funnels through
  `route()` (`apps/api/src/worker.ts:108`) after `authenticate()`
  (`apps/api/src/worker.ts:185`) and dispatches straight to `blobPut`/`blobGet`/`blobsCheck`
  (`apps/api/src/worker.ts:238,245,246`) or the commit DO (`worker.ts:270`) with **no
  budget check**. The only limiter in the path is Cloudflare's infra WAF — which is global
  and per-IP, sees no `accountId`, and is exactly what tripped.

So one account's burst is indistinguishable, at the infra layer, from a platform-wide DoS,
and its 403s land on *everyone* sharing the colo.

## Root cause

Two distinct limiters are conflated, and one of them is missing:

1. **Cloudflare infra rate limiting (WAF / rate-limiting rules)** runs *before* the Worker.
   It is keyed by IP/path/colo and **cannot see `Principal.accountId`** (the Principal only
   exists after `authenticate()`, `apps/api/src/worker.ts:185`). It is a blunt volumetric
   backstop. It can throttle a flood; it **cannot do fairness** between accounts. This is
   what we tripped, and it returns an opaque 403 the client can't interpret.

2. **App-level per-account budget** — the layer that *could* be fair (it has `accountId` and
   `plan`) **does not exist.** Nothing debits a per-account bucket; nothing returns a
   structured, retryable backpressure signal.

And the client can't cooperate even if we asked it to: `RboxApi` throws a **generic `Error`
on any non-2xx** blob op (`blob PUT failed: ${res.status}` `src/cli/remote.ts:95`; GET
`:101`; single-PUT `:119`) — it does **not** honor `429`/`Retry-After`. The commit path
special-cases `409`/`422` (`src/cli/remote.ts:249,253`) but not `429`. So a 429 today would
just hard-fail the push. The concurrency `64` is a hard-coded constant, never negotiated
down.

## Division of labor (tune BOTH layers)

| | Cloudflare WAF / rate rules (infra) | App-level per-account budget (new) |
|---|---|---|
| Runs | Before the Worker, per-IP/colo | In the Worker, after `authenticate()` |
| Sees `accountId`? | **No** | **Yes** (`p.accountId`, `p.role`, plan) |
| Job | Volumetric/abuse backstop vs anonymous floods | **Fairness** between accounts; smooth the 64-fan-out |
| Failure of one heavy account | Opaque 403 to *everyone* in colo | Structured 429 to *that account only* |
| Tune to | **Raise** thresholds for authenticated (bearer-present) traffic so legit bursts stop tripping it | **Add** plan-aware burst+sustained budgets that bite *before* the WAF |

The contract: **our app-level limit must trip before the WAF does**, so a heavy account
gets a clean, account-scoped, retryable `429 + Retry-After` instead of a colo-wide opaque
`403`. The WAF stays as the dumb backstop for unauthenticated / pathological volume and is
**tuned up** for authenticated traffic so it stops false-tripping on legitimate first-syncs.

## Design

### 1. Where to enforce — layered, single chokepoint

(All `apps/api/*` line anchors are as-of-this-draft; the implementation diff should re-pin any
that shift.) Attach the per-account check **in the Worker, immediately after `authenticate()`**
(`apps/api/src/worker.ts:185`), *before* route dispatch. Every authed surface — blob
PUT/GET/check, multipart parts, commit, keys — already passes this exact point with
`p.accountId` and `p.role` in hand. One chokepoint, no per-handler duplication.

Debit **by operation class**, because the fan-out is asymmetric:

- **Blob hot path** (`PUT/GET/POST /v1/blobs/*`, multipart parts) — the 64-wide fan-out, the
  thing that tripped the WAF. **This is the primary metered surface**; 1 token per op.
- **Commit** (`POST …/manifests` → the DO, `worker.ts:270`) — naturally **serialized** by
  the per-workspace `WorkspaceSync` DO and **low frequency** (one per push, not 64-wide).
  Give it a **separate, generous bucket** so a legitimate §30 large push (one commit, up to
  `MAX_REFS_PER_COMMIT`) is **never** throttled at the commit step. Debit it ~0 against the
  blob bucket.
- **Keys / account reads** — light; share a small generic bucket or ride the blob bucket at
  weight 1. Not a fairness threat.

### 2. Throttle model — burst + sustained windows, plan-aware (NOT a fairness guarantee)

Be precise about what this is (codex r1 BLOCKER): the native binding is a **fixed-window
counter**, not a leaky/token bucket, and it is **per-colo + fail-open**. So this is an
**approximate local throttle that smooths the fan-out**, not a global fairness *guarantee*.
It buys us exactly the thing we need — our app-level limit trips *before* the WAF, so a heavy
account self-throttles into a clean account-scoped 429 instead of a colo-wide 403 — and we
state its limits rather than dress it up as more.

Two windows per account approximate a burst+sustained shape:

- **Burst** — a short window (e.g. 1–2 s) sized to **admit one full 64-wide fan-out** so a
  healthy push at the negotiated width passes without a 429 (steady-state must not self-trip).
- **Sustained** — a long window (e.g. 60 s) setting the **long-run ceiling**, so a daemon
  hammering push/pull forever converges toward a fair share.

**Accepted overshoot / window-edge behavior (stated, not hidden):** a fixed window lets an
account fire up to ~2× its nominal rate across a window boundary (end of window N + start of
N+1), and the per-colo counter means a K-colo account gets up to ~K× budget. Both are
**acceptable** — the goal is to keep any single account an order of magnitude under the infra
ceiling, not to enforce an exact quota. The byte quota (the thing that must be exact) is owned
elsewhere by the cap-guard / `grantEntitlementWithQuota` (`apps/api/src/billing.ts:39`).

Both windows' limits derive from the account's **plan** (`apps/api/src/plans.ts:17` —
`free`/`solo`/`pro`/`team`): `free` tightest, `pro`/`team` loosest. (Exact numbers are an open
question for the founder — see below.)

**Plan must be known at request time without a *separate* per-request D1 read.** Today plan
lives only in `accounts.plan` and costs its own D1 round-trip (`account()`,
`apps/api/src/billing.ts:10`). `authenticate()` already runs one indexed join over
`devices`+`account_memberships` (`apps/api/src/auth.ts:56`) and returns the `Principal`.
**Fold `accounts.plan` into that SELECT** — same query, **one additional join + column** on
`accounts` (NOT literally zero-cost, as codex r1 noted, but it replaces a whole second D1
round-trip with one extra joined column on a query that already runs on every authed request).
Plan then rides on the `Principal` like `role`/`kind` (`apps/api/src/authz.ts:5-16`) and the
rate check reads `p.plan` with no extra I/O.

### 3. Where the bucket state lives — native CF binding (chosen), NOT a DO

Evaluated three stores. The decision is load-bearing, so state the tradeoffs:

- **KV — rejected.** Eventually consistent, ~1 write/key/sec, cached stale reads. §22
  explicitly bars KV for authoritative sync state (`docs/design/22-server-throughput.md:29`).
  A hot per-account counter on KV is both wrong (stale) and too slow.
- **D1 row per account — rejected.** A single counter row would **serialize every one of
  that account's 64 concurrent requests through one D1 write** — turning the rate limiter
  into a *worse* bottleneck than the contention it's meant to relieve.
- **Per-account Durable Object rate-limiter — rejected for the hot path.** A single DO per
  account gives an exact, globally-consistent, burst+sustained, plan-aware bucket — but it
  reintroduces the two failure modes we are trying to kill: (a) the DO is **single-threaded**,
  so all 64 of an account's concurrent blob ops **serialize through one object**; (b) the DO
  lives in **one colo**, so a globally-distributed account round-trips **every blob op
  cross-colo to that object** — brutal latency on exactly the 64-wide fan-out. §22 already
  says "**Do not route every blob PUT through a DO**"
  (`docs/design/22-server-throughput.md:27`). It would also add a hop that *contends* with
  the commit sequencer DO (see §5). Adds a SPOF per account.
- **Cloudflare native rate-limiting binding — CHOSEN.** `env.<LIMITER>.limit({ key })` runs
  **in-colo, in-runtime, sub-millisecond, zero extra hop**, and **fails open** (a limiter
  error lets the request through — it cannot become an API-wide SPOF). It is part of the
  Worker runtime, so it can't itself be the bottleneck. Limitations and how we handle them:
  - *Single fixed window, not a dual-rate bucket.* → Declare **two bindings** (burst:
    short window/high limit; sustained: long window/lower limit) and require **both** to
    pass. That is the cheap, stateless approximation of a burst+sustained token bucket.
  - *Limit is static per binding, not per-request dynamic.* The binding's `{limit, period}`
    is **declared in `wrangler` config and cannot be tuned at runtime** from `accounts.plan`
    or any DB value. → Pre-declare a small **matrix** of bindings (plan × {burst, sustained})
    and **select which binding to `.limit()` by `p.plan`** in code. This is the ONLY way the
    design is plan-aware: a fixed set of statically-declared tiers, chosen per request — not a
    continuously-tunable per-account limit. Changing a tier's numbers is a config deploy. A
    bespoke per-account number would require the rejected DO/state-store path.
  - *Per-colo, not global.* → **Acceptable and actually correct here**: the contention we
    are protecting (R2 throughput, subrequest pressure, the WAF) is *itself per-colo*, and a
    single client's 64-wide fan-out originates from ~one colo. Per-colo fairness maps onto
    where the starvation actually happens. An account spanning K colos getting Kx budget is a
    non-problem (see Residual risk).

  Key it by `p.accountId`. New bindings only — env today has just D1/R2/DO
  (`apps/api/src/env.ts:27,43,53`), no KV, no limiter; this adds the limiter binding(s).

The DO option stays **documented-and-rejected**, not built. If a future abuse tier needs an
exact global cap, a *narrow* per-account DO engaged **only** for accounts the native binding
repeatedly trips (not the hot path) is the escalation — explicitly out of scope for v1.

### 4. Backpressure protocol — 429 + Retry-After + advertised concurrency

**Server side.** When either window is exhausted, return **`429`** with:
- **`Retry-After`** (seconds), derived from the tripped window — the client's base wait, which
  it **jitters** (see below) so 64 simultaneously-429'd jobs don't wake in lockstep.
- **`x-rbox-max-concurrency`** advertised on **every** response (not just 429s) — the
  server's current suggested fan-out width for this account/plan, so an updated client
  **converges on a sustainable width without having to hit a 429 first.**

Throttle, don't reject: a 429 means "slow down and retry," never "your push failed."

**Client side (the real work — `src/cli/remote.ts` + `poolMap`).** Four changes — and note
the retry on 429 is deliberately **NOT** the bounded `MAX_ATTEMPTS=5` conflict retry
(`src/cli/sync.ts:30`); a 429 is *not* an error condition:

1. **Honor 429 in blob ops with jittered, job-level retry — and ONLY 429** (codex r1 MAJOR —
   a fixed window + bounded retry can fail a legit first sync). `putBlobFile`/`getBlob`/
   `blobsCheck` currently throw a generic `Error` on any non-2xx (`src/cli/remote.ts:95,101,
   119`). The retry classification must be explicit (codex r2 MINOR — else a real outage looks
   like 30 min of "throttling"):
   - **`429` only ⇒ throttle, not error.** The individual job sleeps `Retry-After × (0.5 +
     random)` (jitter breaks the thundering herd — not all 64 jobs re-trip the window edge
     together) and **retries the same blob, not counted against any error budget**. A blob
     transfer is idempotent/resumable ("a partial run just resumes next time" —
     `src/engine/pool.ts:7`). A push throttled to 1 op/sec is *slow*, not *failed*.
   - **`5xx` / network / no-response ⇒ real error**, gets the existing *bounded*
     exp-backoff-with-jitter (`defaultBackoff`, `src/cli/sync.ts:34`) and then **surfaces** —
     never silently retried forever. This is the operator/user signal an outage needs.
   - **Liveness ceiling on the 429 path:** retrying *is* unbounded in count but bounded by
     **progress** — track per-blob completions (and, for multipart, bytes/parts advanced,
     `apps/api/src/blobs.ts:221`); if the whole transfer makes **zero progress for a hard cap**
     (e.g. 30 min) despite only-429s, abort with a distinct "throttled, not converging" error.
     So a stuck transfer still terminates; a merely-slow one completes.
   - **Commit 429** sleeps + retries **inside the remote call** (`commit()`, `src/cli/
     remote.ts:241`), the same only-429 way — it must **NOT** be folded into the bounded
     `MAX_ATTEMPTS=5` parent-conflict loop (`src/cli/sync.ts:30,308`), which is for 409s. 429
     is orthogonal to conflict/422 retries and must not consume their budget (codex r2 MINOR).
2. **Make 64 a ceiling, not a constant — AIMD via a NEW adaptive pool, not `poolMap`** (codex
   r2 MAJOR). `poolMap` is deliberately a simple fail-fast fixed-width primitive
   (`src/engine/pool.ts:11-16`) shared by encrypt/upload/download/apply; do **not** overload
   it (that would change semantics for every caller). Instead add a **separate adaptive
   variant** used only by the rate-aware blob upload/download phases, with precise semantics:
   - A **shared mutable target width** `T` (init from `x-rbox-max-concurrency`, capped 64).
   - Workers **park** (await a small tick) when in-flight ≥ `T`, then re-check — they **do not
     exit** (exiting would prevent additive recovery), so width can grow back.
   - A `429` lowers `T` ×0.5 (floor 4); N consecutive non-429 successes raise `T` +2 (ceil 64).
   - **A real (non-429) error still fails-fast**, exactly like `poolMap` today — only 429s are
     absorbed; nothing weakens the fail-fast contract for genuine failures.
   - Existing fixed-concurrency `poolMap` callers are **untouched**.
3. **Effective rate also falls out of (1) for free:** even at width 64, jobs blocked on
   `Retry-After` hold workers parked, so in-flight count drops toward the sustainable rate.
   AIMD (2) just makes that convergence faster and explicit.
4. **No protocol break for the daemon:** the daemon already tolerates retries; `T` is internal
   to a single push/pull invocation.

### 5. Interaction with §30 receipts push + the per-workspace DO

Two hard constraints:

- **The rate-limiter must not contend with the commit sequencer.** It lives **in the Worker,
  before the DO forward** (`apps/api/src/worker.ts:263-283`), and uses the **in-colo native
  binding** — zero hop, no shared lock, nothing touching `WorkspaceSync`'s synchronous
  `transactionSync` head-advance (`apps/api/src/workspace-sync.ts:333`). It is **never**
  inside the DO and **never** shares the commit txn. The commit bucket (§1) is separate and
  generous precisely so metering never serializes against the sequencer.
- **The "generous commit bucket" is still account-keyed and spam-capped** (codex r1 MAJOR — a
  generous bucket is an abuse hole otherwise). "Generous" means *sized for one commit per
  push, not unlimited*: it is keyed by `p.accountId` like the blob bucket and capped (e.g.
  ~N commits / 10 s) so an attacker can't fire thousands of tiny commits or manifest-spam to
  hammer the DO + the D1 commit mirror (`apps/api/src/workspace-sync.ts:370`). Legit pushes
  commit far below this; the cap only bites pathological commit loops. The byte/ref ceilings
  on a single commit are still owned by §30 (`MAX_REFS_PER_COMMIT`, `MAX_REQUEST_BODY`).
- **A legit §30 large push must throttle, never reject.** §30 lifts the ref cap to
  `MAX_REFS_PER_COMMIT` (50k) for a single commit; the cold push that precedes it uploads
  ~12k blobs in 64-wide fan-out (`docs/design/30-large-ref-commit-accounting.md:9`). With
  client-side 429-honoring + AIMD, that push **slows to a sustainable width and completes**,
  rather than failing. The burst bucket is sized to admit a full fan-out so steady-state
  upload doesn't self-trip; the sustained bucket only bites if the account hammers for a long
  time. The commit itself (one DO call, not a fan-out) rides the generous commit bucket and
  is effectively never throttled. The §30 receipts PUT path (`usesReceipts`,
  `apps/api/src/blobs.ts:12,105`) is metered identically to legacy PUT — the limiter is
  protocol-agnostic, debiting the R2 op, not the accounting.

## Residual risk (stated plainly)

- **Per-colo budget = Kx for a K-colo account.** A single client's 64-fan-out is ~1 colo, so
  this is theoretical; and per-colo is where contention actually lives, so it's the *right*
  granularity, not a leak. A globally-distributed *abuser* could get Nx — bounded by the WAF
  backstop and acceptable for v1 (the threat model is *accidental* starvation by a heavy
  legit user, not a determined DoS, which the WAF owns).
- **Native binding fails open.** Under a limiter outage there's briefly no fairness — but the
  API stays *up* (no SPOF) and the WAF still caps volume. Correct availability tradeoff.
- **Account B is only *partially* protected (be honest — codex r1 MAJOR).** The per-account
  limiter protects B from A consuming the *app-level* Worker/R2 *request* budget, and only if
  the app limit trips before the infra limit (hence "tune the WAF up so we trip first"). It
  does **not** protect B from: shared *upstream* failures (R2/D1 saturation B also depends on),
  the fail-open window above, or Cloudflare's own global/WAF behavior. Those remain the
  platform's job. The claim is "A can't *starve* B at the app layer," not "B is isolated from
  all shared-fate." For v1's threat model (accidental starvation by a heavy *legit* user) this
  is the right scope; a determined DoS is the WAF's problem, not this layer's.
- **Plan cached on Principal can be stale** until token re-auth / cache TTL. After an
  *upgrade* the account briefly keeps the lower budget (annoying, safe); after a *downgrade*
  it briefly keeps the higher budget (minor, TTL-bounded abuse window). Not a correctness
  issue.
- **Old clients hard-fail on 429** (they throw, `src/cli/remote.ts:95`). Mitigated by
  rollout order (below): ship the 429-honoring client first; enforce server-side second.
- **AIMD oscillation.** Bounded by floor (4) / ceiling (64) / ×0.5 decrease / +2 increase and
  Retry-After-driven waits; converges, doesn't thrash.
- **The limiter does not bound R2 *cost*, only request *rate*.** Storage quota is still owned
  by the cap-guard / `grantEntitlementWithQuota` (`apps/api/src/billing.ts:39`). This is a
  rate/fairness layer, orthogonal to byte quota — intentionally.

## Test + rollout plan

**Unit.**
- *Engine (bun):* `poolMap`/remote honor a `429` — sleep `Retry-After`, retry, succeed on the
  retry (in-memory remote returns `429`+`Retry-After` then `200`); AIMD width halves on 429
  and additively recovers; only-429 retries do NOT count against any error budget, while a
  non-429 5xx/network error fails-fast and surfaces; **commit 429 retries inside the remote
  call and does NOT consume the bounded `MAX_ATTEMPTS` parent-conflict budget** (assert a run
  with many 429s but zero 409s never raises "too many conflicts").
- *Server (vitest, workerd):* binding **selection by plan** — a `free` account trips sooner
  than `pro` for the same op rate; burst vs sustained windows trip independently; a 429
  carries both `Retry-After` and `x-rbox-max-concurrency`; the **commit bucket** is generous
  enough that a 50k-ref §30 commit is never throttled.

**Large-push survival (the codex r1 MAJOR — prove it completes).**
- Push a **12k-blob cold workload under the FREE and SOLO budgets** (the tightest tiers) with
  enforcement on; assert it **completes** (never returns a terminal error to the user), that
  429s are absorbed by jittered job-level retry + AIMD, and capture the completion-time
  degradation vs unthrottled. This is the test that would catch a thundering-herd livelock or
  a bounded-retry give-up.

**Empirical (the real measurement).**
- Replay two concurrent pushes (the savvy-core 4287-blob and conductor 11,942-blob
  workloads) from **two different accounts**; assert account B's blob-GET/PUT p50 is
  unaffected while account A self-throttles via AIMD — i.e. **app-level fairness holds**.
- Reproduce **this session's failure**: the zero-knowledge `grep` GET storm. Assert it now
  degrades to **429 + client backoff** and *completes*, with **zero WAF 403s** (the canary we
  tripped). Capture before/after via the `startOp`/`emit` telemetry
  (`apps/api/src/metrics.ts:74`) — add a `rate_limited` outcome label and a would-have-429
  counter for the observe-only phase.

**Rollout order (must be staged — old clients hard-fail on 429, and telemetry alone does NOT
protect old binaries — codex r1 MAJOR).**
1. Ship the **client** 429/`Retry-After`/AIMD + `x-rbox-max-concurrency` read, AND have it
   send a **capability header** (e.g. `x-rbox-client: rbox/<ver>` or an explicit
   `x-rbox-accepts: 429-backpressure`) on every request — no server behavior change yet.
2. Deploy server limiter in **observe-only**: emit a would-have-429 metric (`startOp`/`emit`,
   `apps/api/src/metrics.ts:74`, new `rate_limited` outcome), **don't enforce**. Tune the
   **WAF threshold up** for authenticated traffic in parallel.
3. **Enforce only for capability-flagged clients — as a COMPATIBILITY VALVE, not the permanent
   enforcement boundary** (codex r2 MAJOR). The 429 is gated on the capability header: a
   request *without* it is never 429'd by the app layer (it falls back to the WAF backstop
   only), so an un-updated `rbox` binary can never be bricked. Be honest about the cost: while
   the gate is open, app-level fairness is **opt-in and trivially bypassed by omitting the
   header**, so during rollout a non-capable (or spoofing) client is throttled only by the
   **WAF**, not this layer. That is acceptable *as a rollout phase*, not as the end state.
4. **Close the valve once adoption is high:** flip to **default-enforce**, and handle the
   straggler explicitly rather than silently — a non-capable client on a sync route gets a
   structured **`upgrade_required`** response (or is throttled at a conservative floor with a
   one-time upgrade hint), the same shape `rbox upgrade` already consumes (`/version`,
   `apps/api/src/worker.ts:127`). The capability header then identifies *old* clients to nudge,
   not a way to dodge limits. This keeps the v1 *threat-model goal* — **no heavy _legit_
   account starves others at the app layer** — honest: a determined client that strips the
   header is a DoS actor, which is the **WAF's** job (§ division of labor), not this layer's.

## Open questions for the founder

1. **Exact per-plan budgets** — concrete burst (ops/sec) + sustained (ops/min) for
   `free`/`solo`/`pro`/`team`. (Starting proposal: free ≈ 16 burst / 600 sustained-per-min;
   solo ≈ 48 / 3k; pro/team ≈ 96 / 12k — sized so pro absorbs a full 64-fan-out with headroom
   and free still completes a first sync, just slower.)
2. **429 + Retry-After (client adapts)** vs **silent throttle** (server delays the response)
   vs **hard reject**. Recommendation: **429 + Retry-After**.
3. **Native CF binding vs custom per-account DO.** Recommendation: **native binding**
   (in-colo, no hop, no SPOF, §22-consistent); DO documented-and-rejected.
4. **Negotiate client concurrency** via `x-rbox-max-concurrency` + AIMD, vs **only react to
   429**. Recommendation: **advertise + AIMD** (converges before the first 429).
5. **v1 enforce vs observe-only**, and whether to **block/refuse pre-429 clients** at
   enforcement time (they hard-fail today). Recommendation: observe-only first, gate
   enforcement on client adoption.
6. **Separate generous commit bucket** so §30 large pushes never trip at the commit step —
   confirm (recommended yes).
