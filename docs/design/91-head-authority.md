# 91 — Head authority: un-regressable DO sequencer + benign-fork auto-recovery

Status: Design draft 2026-07-09, from the Mac↔FM commit-fork incident. Full-stack
(server DO sequencer + client fork-recovery). Non-breaking: the DO's external
contract (commit/latest/commits endpoints) is unchanged; existing clients keep
working; the client change is per-client and independent. Gated: the failing
regression test (evict DO + stale mirror → assert no head regression) must go
red before and green after.
Origin: 2026-07-09 a per-workspace DO sequencer handed out sequence 475 to two
devices ~6 min apart; the losing device (its pinned 475 orphaned) halted for
13.5h. Diagnosed by two independent codex passes that converged.
Method lineage: design 12 (verifiable commit chain), design 20 (device identity),
the Cloudflare DO durability model.

## 1. Incident and evidence

- 23:54:44 device MAC commits, server returns `published sequence 475`; MAC pins
  `{commitSeq:475, hash:mac475}`.
- 23:54:44.755 MAC's next verify: `head rolled back below the pinned sequence` —
  the head MAC observes is now < 475.
- 00:00:37 device FM commits and ALSO gets `published sequence 475` — a DIFFERENT
  commit at 475 (fork/equivocation); 00:11:32 FM publishes 476; server head then
  advances cleanly to 565 via FM. MAC stays halted forever (476.parent ≠ mac475).
- Real content divergence: **3 files** (`apps/web/.../api-keys-section.{svelte,test.ts,ts}`).

So the DO handed out the same sequence twice and the head observably regressed
within 1s of MAC's accepted commit. Recovery required manually deleting the client
pin file `~/.rbox/e2ee/<acct>/ws/<ws>.pin.json` and a foreground re-baseline pull.

## 2. Root cause (both codex passes converged)

The per-workspace DO (`apps/api/src/workspace-sync.ts`, addressed
`idFromName("${ws}/${proj}")` → one instance per workspace) is a correct
sequencer in steady state: the head check+advance is a synchronous
`transactionSync` with no await inside (`parent !== head → 409`), and `/latest`,
`/commits`, `seq:<n>` all read DO storage (NOT D1). One persistent DO **cannot**
double-issue a sequence.

The fork requires the DO's authoritative `head` to become **absent/regressed**,
after which two mechanisms combine:
1. **Best-effort D1 mirror.** The `commits` table is written AFTER the ack, best
   effort, failures swallowed (`INSERT OR IGNORE` in a try/catch that only logs,
   ~L331–338), and is explicitly labeled "not authoritative."
2. **Reseed-from-mirror (the amplifier).** `doBootstrap` (~L122–136): when
   `kv.get("head") === undefined`, it reseeds `head` from the mirror
   (`SELECT sequence … ORDER BY sequence DESC LIMIT 1`). If the DO's head is ever
   absent AND the mirror lags/missed the last commit, the head **regresses** →
   the next writer's parentSeq matches the stale head → an already-used sequence
   is re-issued → FORK.

The reseed does NOT overwrite a present head (guarded by `head === undefined`), so
it is the amplifier, not the trigger. The **trigger** — what made head absent for
an active workspace — is not in repo code and could not be pinned from
CLI/API access (no prod deploy in the window; no DO migration change; no
dev/prod namespace split affecting the fleet — dev builds hit prod
`api.rbox.to`; account-delete/purge ruled out). It is a Cloudflare-internal DO
storage event. **This design makes the fix trigger-independent:** the head
becomes un-regressable regardless of what empties storage.

## 3. Design — the head is a monotone, DO-authoritative, un-regressable pointer

### 3.1 Invariants
- **I1 — DO storage is the head authority in steady state.** All sequencing and
  all `/latest`//`commits`/`seq:<n>` reads use DO storage only. The best-effort
  body mirror is NEVER read for the head. The one exception is the §3.3
  synchronous D1 head row: a monotone, raise-only recovery anchor consulted ONLY
  at cold-start when the DO head is absent, and it can never LOWER the head
  (bounded by the watermark). It is a durability backstop, not a steady-state read.
- **I2 — the head never regresses.** A durable monotone `headWatermark` (the
  highest sequence ever acked) gates every advance; a new head must be strictly
  greater. The watermark is never lowered, never pruned, never reseeded from D1.
- **I3 — the head carries its hash.** Head is `{sequence, commitHash}`, so the DO
  detects same-sequence equivocation server-side and rejects a second commit at
  an already-acked sequence with a different hash.
- **I4 — fail closed, never guess.** If the DO's head is absent but the workspace
  demonstrably has prior commits (mirror rows or a non-zero watermark), the DO
  returns `repair_required` for writes AND reads rather than reseeding a guessed
  head. A refusing workspace is loud and recoverable; a silently-regressed head
  forks.
- **I5 — bodies are separable from the head.** Immutable commit BODIES
  (`seq:<n>`) may be pruned/archived and reconstructed on demand from D1/R2 (safe:
  an old body never changes). Reconstructing a body must NEVER set or lower the
  head pointer.

### 3.2 Sequencer (transactionSync) — the change
Inside the existing synchronous transaction:
```
head = storage.get("head")            // {sequence, commitHash} | undefined
watermark = storage.get("headWatermark") ?? head?.sequence ?? 0
if (head === undefined) → see §3.3 (repair vs genesis)
if (parent !== head.sequence) return conflict(head.sequence)   // 409 (unchanged)
if (cb.seq !== watermark + 1) return conflict(head.sequence)   // watermark gate (I2)
// I3 equivocation: a retommit at an existing sequence with a different hash is refused
next = { sequence: head.sequence + 1, commitHash: commit.commitHash }
storage.put("head", next)
storage.put("headWatermark", next.sequence)   // monotone; never decreases
storage.put(`seq:${next.sequence}`, storedCommit)
```
All in one `transactionSync`, no await inside (unchanged discipline). The output
gate ensures the ack is not delivered before these writes are durable (no
`allowUnconfirmed`).

### 3.3 A second synchronous head authority in D1 (closes the total-loss gap)
DO storage is durable, but "fail closed if head is absent" only works if SOME
durable record proves the workspace was acked. If DO storage AND the best-effort
body mirror were BOTH absent (a catastrophic simultaneous loss, or loss before
the first body mirror landed), bootstrap couldn't distinguish acked-from-new and
would wrongly allow genesis (codex GAP). Close it with a distinct **authoritative
head row** in D1 — NOT the best-effort body mirror — upserted SYNCHRONOUSLY
(awaited) inside the commit path, monotone (`ON CONFLICT … WHERE excluded.sequence
> sequence`), tiny (ws, proj, sequence, commitHash, watermark). It is a second
durable authority the reseed may consult to RAISE (never lower) the head. Because
it is awaited before ack (output gate), it can never lag an acked commit. Only a
true simultaneous loss of DO storage AND this row (a platform catastrophe) falls
through to §3.4's fail-closed; documented as out of scope for silent recovery.

### 3.4 Bootstrap / cold start (§I4) — the core fix
`ensureBootstrap` stays request-scoped single-flight (it needs `ws/proj` from the
request to consult D1 — it CANNOT move to the constructor; keep the existing
single-flight `bootstrapPromise`). The fail-closed logic goes inside it:
- **Numeric-head migration (codex GAP):** existing DO storage holds `head` as a
  bare `number`. On load, if `head` is numeric, convert to `{sequence, commitHash}`
  by reading `seq:<head>` for the hash (or the §3.3 head row); seed
  `headWatermark = sequence`. Existing workspaces migrate transparently, no
  behavior change.
- `head` present → use it. (Steady state.)
- `head` absent AND `headWatermark` absent AND §3.3 head row absent AND body
  mirror empty → genuinely new workspace → genesis (0). Normal.
- `head` absent BUT any of (`headWatermark`, §3.3 head row, body-mirror rows,
  `pruneFloor`, retained `seq:*`) present → **authoritative head was lost**. Do
  NOT reseed a guessed head. Serve `repair_required` for writes AND reads. Log
  `bootstrap_head_missing` / `head_missing_with_d1_rows`.

### 3.5 Explicit repair path (migration + genuine loss)
A single authenticated admin/repair entrypoint that reconstructs the head to a
state that is CONSISTENT with the watermark: `head` is set to
`{sequence: max(reconstructedSeq, watermark), commitHash: <hash at that seq>}`,
reading the hash for the watermark sequence from the §3.3 head row or `seq:<n>`.
**Repair must never leave `head.sequence < headWatermark`** (codex WRONG-fix): if
the hash for the watermark sequence cannot be resolved, repair REFUSES rather than
producing a `head < watermark` state that deadlocks the sequencer gates
(`cb.seq === watermark+1` ∧ `parent === head.sequence` would be mutually
impossible). This preserves the original reseed's legitimate purpose (pre-DO
migration, genuine loss) behind an explicit gate, never firing silently.

### 3.5 D1 mirror — off the correctness path
The mirror stays best-effort and advisory, but:
- It is written via an **alarm/outbox** (durable retry), not a swallowed post-ack
  `await`, so operators who read it (versions/analytics) get eventual consistency
  they can trust.
- NOTHING correctness-gating (head, sequencing, cold-start authority) ever reads
  it. Only §3.4's explicit repair may, and only to raise (never lower) the head.

### 3.6 Telemetry (so the next occurrence is loud, not a 13.5h mystery)
Emit on: `bootstrap_head_missing`, `head_missing_with_d1_rows`,
`same_sequence_different_hash` (I3 rejection), `repair_required_served`,
`repair_invoked`. These turn a silent regress into an alert.

## 4. Client — `rbox recover` now; automatic recovery deferred to 91b
The server fix (§3) PREVENTS the fork. The client side is recovery-after-the-fact
(defense-in-depth), and codex correctly flagged that *automatic* benign-fork
detection is underspecified with today's pin: the pin stores only
`{commitSeq, commitHash}` (+ roster/key-state), not the pinned commit's parent
hash, and `commitsSince(pinnedSeq)` omits the server's commit AT the pinned seq —
so the client cannot prove common-ancestry for a same-sequence fork from the pin
alone. That needs a richer recovery data model, so it is split out:

**Ships in 91 (small, safe, immediately useful):** a `rbox recover` command — an
explicit, user-invoked re-baseline that does exactly what unstuck the Mac by hand:
reset the local pin, foreground re-verify the server chain from genesis/ancestor,
reconcile local files via the existing design-50 keep-both, re-push local diffs.
It is user-triggered (no automatic relaxation of anti-rollback), so it needs no
new trust reasoning — it is the manual pin-surgery recovery, made a supported
one-liner instead of `rm`-ing a keystore file.

**Deferred to 91b (`docs/design/`, follow-up):** *automatic* benign-self-fork
detection at `verifiedHead` (auto-rebaseline a valid roster-signed divergent chain
from a common ancestor; still HALT on true rollback / non-roster sig / invalid
chain). Requires a concrete recoverability data model: retain the pinned commit's
parentHash locally (extend `HeadPin`), and a server-assisted ancestor fetch
(`commitsSince(pinnedSeq − 1)` when retained) to verify the server suffix against
locally-retained orphan metadata. Designed separately so it does not gate the
urgent server fix.

## 5. Non-goals
- Changing the linear-chain model to a DAG/CRDT (a bigger design; revisit only if
  multi-writer intensity outgrows §3's fixes).
- The dev/prod namespace footgun (separate follow-up: a client guard that refuses
  a prod workspace on a non-prod `RBOX_API`, and/or a server account-env assertion).
- Per-single-workspace write-throughput scaling (inherent to a linear head).

## 6. Compatibility (multi-user constraint — a coworker onboards soon)
- Server: the DO's external endpoints are unchanged; `repair_required` is a new
  distinct error a current client will surface as a sync failure (loud, not a
  fork) — acceptable and strictly safer than today. Existing workspaces: on first
  access under the new code, seed `headWatermark = head.sequence` (head is already
  authoritative in DO storage), a no-op-safe migration.
- Client: per-client, independent upgrade. Old clients keep halting on forks (safe,
  current behavior); new clients auto-recover. Read-before-write is preserved
  (this doesn't change the wire/manifest format).

## 7. Acceptance gates
1. **Regression test (blocks merge), the incident in a test:** seed a DO to 475,
   wipe its storage while the body mirror still says 474, assert `/latest` does
   NOT regress and a second parent-474 commit is REFUSED (`repair_required`), not
   accepted as a duplicate 475. (`@cloudflare/vitest-pool-workers` +
   `evictDurableObject`/purge, per the codex-sketched harness.)
2. **Equivocation (I3):** two commits at the same sequence with different hashes →
   the second is rejected server-side.
3. **Watermark monotonicity (I2):** no code path lowers `headWatermark`; a forced
   reseed attempt cannot drop the head.
4. **Numeric-head migration:** a workspace with a bare-`number` `head` (current
   format) loads, converts to `{sequence, commitHash}`, seeds `watermark`, and
   commits normally — no break, no regression.
5. **Repair state machine (§3.5):** (a) genuinely-new workspace → genesis; (b)
   head-absent-with-any-durable-evidence → `repair_required`; (c) repair with
   `watermark > reconstructedSeq` and no resolvable hash at the watermark →
   REFUSES (never produces `head < watermark`); (d) repair resolves the watermark
   hash → head set at/above watermark, commits resume.
6. **Total-loss boundary:** head absent but the §3.3 D1 head row present → head
   reconstructed (raised) from it, no regress; head row + DO storage both absent →
   `repair_required` (documented catastrophe path), never a silent genesis over
   an acked workspace.
7. **`rbox recover`:** on a forked/halted client, `rbox recover` re-baselines onto
   the server head, reconciles via keep-both, re-pushes local diffs, exits clean —
   with no keystore-file surgery. A true rollback / non-roster head still refuses.
8. **Compat:** existing-workspace migration is behavior-preserving; the DO's
   external endpoints unchanged; full `bun test` + `apps/api` vitest-pool-workers
   tests green; typecheck green.

## 8. Rollout
1. Server first (the un-regressable head + fail-closed bootstrap + watermark +
   {seq,hash} + telemetry + repair path) — deploy to dev-api, run the gate tests,
   then prod. It only makes the server safer; no client change required to benefit.
2. Client auto-recovery + `rbox recover` — ships in the next CLI release; each
   device benefits on upgrade.
3. Backfill: on first prod access per workspace, watermark seeds from the present
   head (safe). Monitor the §3.6 telemetry.

## 9. Risks
1. **Fail-closed false positives.** If a legitimate scenario leaves head absent
   with mirror rows (a real migration), workspaces serve `repair_required` until
   repaired. Mitigated by §3.4 being a simple authenticated one-shot and by the
   telemetry making it visible. Strictly better than a silent fork.
2. **Client auto-recovery over-accepting.** The recovery must verify roster
   signatures + common-ancestor descent rigorously; a bug could accept a history
   it shouldn't. Mitigated by the halt cases staying hard and by gate 5's
   adversarial cases (rollback + non-roster sig must still halt).
3. **The CF-internal trigger recurs before the fix ships.** Until deployed, a
   repeat is possible; the client `rbox recover` command (ship first, it's small)
   makes recovery a one-liner instead of pin surgery in the meantime.
