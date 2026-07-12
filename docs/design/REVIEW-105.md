# REVIEW-105 — adversarial review ledger for design 105 (WS change notification)

Reviewer: `codex exec` (gpt-5.6-sol) in read-only mode. Attack surface:
correctness creep (anything that makes WS load-bearing), auth/abuse surface,
hibernation cost math, reconnect-storm behavior, missed/duplicate/reordered
notification semantics, battery claims without numbers, gate falsifiability,
and re-proposal of already-shipped work. Cap: 4 rounds. Target:
`VERDICT: ALIGNED`.

Note: the channel already SHIPS (client since M1 `d87e29d9`, server fanout
since design 59 `c43ace26`); this is a retroactive design + hardening, so
"already implemented" is expected and not a finding on its own — the question
is whether the design's invariants, gaps closed, and gates are sound.

## Round 1 — VERDICT: REVISE (15 findings; 7 ACCEPT + 5 NON-ISSUE + 3 gate defects; 10 must-fix)

Raw output: scratchpad/review-105-r1.txt. Disposition:

1. **6h revocation bound false as designed (commit-wake-only check; idle
   workspace never runs it).** ACCEPTED, reframed rather than alarm-ified:
   §3.2/§3.4 now bound **information delivery, not connection existence** —
   `broadcast` checks age BEFORE each send and closes instead of sending, so
   no frame is ever delivered past the cap; an idle workspace's lingering
   over-age socket receives nothing (auto-pongs only). Alarm rejected
   deliberately (the DO alarm is owned by the design-96 fold; a second
   consumer buys no security). Non-goals updated to match.
2. **G2 not falsifiable ("agreed ceiling", "negligible").** ACCEPTED. G2 now
   ships proposed numbers (added idle-wakeups ≤1/s, added CPU ≤0.5% of one
   core, host aggregate, ≥3 paired 10-min powermetrics samples at the real
   workspace count); founder may re-set before the run (§10). All
   pre-measurement "negligible" claims removed.
3. **Backstop cost model understated (`/latest` = Worker + authenticate 2×D1
   + authz 1×D1 + throttled last_seen + grant mint, not "a DO read, no
   D1").** ACCEPTED. §4 now carries the full request-path cost model
   (~3–4 D1 queries/poll, ~40–50 D1 queries/workspace/hour, fleet aggregate
   formula, re-model trigger at 100× today's fleet).
4. **Timer phasing/jitter asserted not specified; keepalive is NOT jittered;
   workspace count not bounded.** ACCEPTED. §4: backstop first tick
   `uniform(0, interval)`, per-tick ±25% re-sampled; keepalive honestly
   described (unjittered `setInterval`, phase set by connect time, alignment
   harmless — pings are wake-free auto-responses); W workspaces ⇒ W sockets
   / 3W timers, no cap, G2 evaluated at host aggregate with real W.
5. **G1 underspecified (independent p50 sums are not a bound; no clock-skew
   treatment).** ACCEPTED. G1 rewritten: per-event correlation by commit
   sequence, median of the per-event RESIDUAL (e2e−push−pull) ≤ 1s over ≥20
   events, NTP offset measured before/after (<250ms drift-stable) and
   subtracted.
6. **Skip-self unsafe under duplicated device identity (guaranteed-no-op
   claim false).** ACCEPTED. §3.3: skip is now conditional on
   `deviceId === self AND persisted lastSyncedSequence ≥ frame.sequence` —
   the second conjunct makes the skipped pull a no-op by definition and
   closes cloned-credential/dup-daemon divergence.
7. **Deploy-storm mitigation lacked a capacity argument; DO is not the choke
   point.** ACCEPTED. §5: capacity argument added (spread ⇒ ~S/3
   handshakes/s; shared choke is Worker+auth D1 at ~3 queries/handshake;
   validity envelope S ≈ 1,000 sockets), startup backstop alignment killed by
   the initial phase draw, and a NEW storm gate G5 (≥100 clients, ≥10
   workspaces, simultaneous force-close; p95 reconnect ≤10s, no auth 5xx).
8. WS not load-bearing — NON-ISSUE (confirmed trigger inventory; 409 recovery
   calls `pull()` internally, noted).
9. Missing/dup/reordered frames safe (head-seeking pull) — NON-ISSUE.
10. No read-your-notify race (CAS precedes broadcast; `latest` reads the same
    authoritative head) — NON-ISSUE.
11. Valid-token capability analysis correct, but "≤ polling" must be scoped
    to a currently-valid token — ACCEPTED as a scoping clarification (§3.2).
12. Auto-response mechanism correct; don't conflate protocol pings —
    ACCEPTED as wording (§3.4 now scopes the claim to the app-level
    mechanism).
13. **G3 "byte-identical" overclaims.** ACCEPTED. Renamed
    trigger-equivalence with exact observables (no `/connect`, no
    timer-driven `/latest`, pre-notify trigger set).
14. **G4 lacked a fixture.** ACCEPTED. G4 now specifies the fault-injection
    fixture (drop/dup/reorder/delay/kill sequences) and the exact convergence
    observables (head seq, persisted base, tree bytes, conflict set); frame
    observation for non-authority assertions explicitly allowed.
15. **Constants lacked rationale; "60s ≈ 2× ping" wrong.** ACCEPTED. 60s
    restated as 2 ping intervals + 10s grace with one-shot re-arm-per-frame
    semantics (exact detection bound); 5m = safety-scan idle-cap symmetry;
    6h = session-length vs revocation-window policy trade; 0–3s derived from
    the §5 capacity envelope.

## Round 2 — VERDICT: REVISE (r1 items 1–4, 6, 8, 10 confirmed resolved; 5 new must-fix)

Raw output: scratchpad/review-105-r2.txt. Disposition:

1. **G1 quantities/eligibility undefined (backstop-discovered commits,
   multi-sequence pulls, superseded sequences; median hides the tail).**
   ACCEPTED. G1 now: explicitly a p50 FAST-PATH gate; `push_i`/`pull_i`
   defined as durations, `e2e_i` as an offset-corrected timestamp interval;
   commits spaced > one pull apart; eligibility = notify-triggered pulls
   only (§6 token), newest sequence on a multi-apply; >20% ineligible ⇒ run
   fails. NEW G1b: bounded recovery — every event (incl. ineligible) visible
   within backstop×1.25 + pull + 30s, zero exceptions.
2. **G5 "≤ N/3 per second" mathematically invalid for uniform randomization;
   no failure model.** ACCEPTED. G5 split into (a) healthy server: p95 ≤ 5s,
   max fixed 1s bucket ≤ N/3 + 4·√(N/3) first attempts (binomial envelope;
   fails no-spread, passes healthy variance), zero auth 5xx; (b) one failed
   first attempt (2s simulated outage): p95 ≤ 10s, zero abandoned; sustained
   outage explicitly out of the gate (backoff + backstop govern).
3. **Over-age close drops the triggering frame without an explicit recovery
   contract; pong deadline lacked an initial arm.** ACCEPTED. §3.4 adds the
   explicit lifecycle contract (close observed → reconnect → mandatory
   catch-up pull picks up the dropped commit; close unobserved → pong
   deadline/backstop ladder). §4 pong deadline now armed on `open` (dead
   before the first pong is caught by the same bound).
4. **G4 convergence not deadline-bounded (esp. all-frames-dropped).**
   ACCEPTED. G4 fixture runs with a test-configured backstop (2s) and every
   fault case — including ALL frames dropped — must converge within 3
   backstop intervals of the last injected commit.
5. **`connectedAt` attachment migration/validity unspecified.** ACCEPTED.
   §3.4: missing/malformed/non-numeric/future-dated `connectedAt` is treated
   as over-age (close, don't send); pre-deploy `{deviceId}`-only attachments
   are closed on first post-deploy broadcast (one-time churn) — the cap
   guarantee is unconditional.

Also noted (no change required): skip-self post-push persistence race is
benign (wrong direction only — an unnecessary pull), test it in
implementation.

## Round 3 — VERDICT: REVISE (all 5 r2 fixes confirmed; 2 must-fix + 2 NITs)

Raw output: scratchpad/review-105-r3.txt. Disposition:

1. **G5(b) failure model internally impossible (a fixed 2s outage cannot
   reject exactly one attempt per client under a 0–3s spread).** ACCEPTED.
   Rewritten as a PER-CLIENT fault: the rig rejects exactly the first
   reconnect handshake of each client, then accepts; nominal completion
   ≈ ≤5.5s (spread + failed handshake + ~1s±25% backoff + retry); p95
   recalculated to ≤ 8s.
2. **G1b deadline start timestamp undefined; degenerate with backstop=0.**
   ACCEPTED. Start = the writer's commit-success timestamp (200 `{sequence}`
   observed; writer clock, same NTP correction as e2e), end = receiver
   file-visible; the run must use a positive backstop or is invalid for G1b.
3. NIT: **G5(a) σ mislabeled (binomial σ = √(2N/9), not √(N/3)).** FIXED:
   envelope restated as max bucket ≤ ⌈N/3 + 4.5σ⌉ with σ = √(2N/9)
   (N=100 → ≤55, threshold rounded up).
4. NIT: **G4 deadline attribution (env slowness vs convergence failure).**
   FIXED: fixture records per-phase durations (backstop-fire, pull wall,
   apply wall); fixture trees sized so pull+apply ≪ one backstop interval.

## Round 4 — VERDICT: ALIGNED (must-fix list empty)

Raw output: scratchpad/review-105-r4.txt. All four round-3 items verified in
the text; the corrected G5(a) envelope math confirmed (N=100: σ = √(200/9) ≈
4.714, ⌈100/3 + 4.5σ⌉ = 55); no new internal contradictions. Settled
decisions carried through all rounds: notify-only channel (never
data/correctness), polling as the correctness floor, hibernation API with
check-at-delivery lifetime cap (no alarm), information-delivery (not
connection-existence) revocation bound, median fast-path gate with G1b
owning the tail, implementation sequenced after designs 84 + 102-enforce.
