# 161 — Reset parse admission: machine-scaled budget + state-shaped multiplier

Status: v2 — folded review r1 (verdict CHANGES-REQUIRED; all 5 accepted).
SCOPE NARROWED TO BUDGET SCALING ONLY per r1 f1: a state-shaped multiplier
would violate design 138's arbitrary-JSON fail-closed contract (JSON.parse
runs before any shape proof; a corrupt state file CAN be a flood corpus).
The 52x multiplier stays. Budget scaling + cgroup capping + env-matrix
tests implemented in the same-day fix PR (#345).
Origin: founder field-hit 2026-07-19 (fresh Mac, v1.7.4).

## Field evidence

Founder's Mac (96 GB RAM): daemon start → ws error → reset classification →
`ResetMemoryAdmissionError`: "needs 3,079,476,036 bytes of parse headroom,
but only ~3.0e9 available" — crash-looped, daemon down, sync dead. Numbers:
state.json 59,220,693 B × `RESET_PARSE_EXPANSION_MULTIPLIER` (26 measured ×
2 safety = 52) = 3.079e9 required; available = `DEFAULT_RESET_PARSE_BUDGET_BYTES`
(4 GiB) − RSS (~1.2 GB). Effective ceiling ≈ 55 MB of state on a 96 GB
machine. Both paying customers run macOS with comparable workspaces — any
state > ~55 MB during a reset with a warm daemon reproduces this.
Unblock used: `RBOX_RESET_PARSE_BUDGET_BYTES` env override (daemon-instance
scoped — not durable).

## Mechanism (src/cli/reset-io.ts)

1. **Machine-scaled default budget.** Replace the constant default with
   `defaultResetParseBudgetBytes()`:
   `max(4 GiB, min(floor(os.totalmem() / 4), 32 GiB))`.
   - 8 GB machine → 4 GiB floor (today's behavior, unchanged).
   - 96 GB Mac → 24 GiB → effective ceiling ~440 MB of state (near the
     separate hard `RESET_MATERIALIZED_BYTE_LIMIT` of 512 MiB, which stays).
   - `RBOX_RESET_PARSE_BUDGET_BYTES` still overrides absolutely (unchanged
     semantics, still validated as a positive safe integer).
   - `os.totalmem()` is a constant-time syscall — no perf concern; compute
     per admission call (no caching state).
2. **[DROPPED — r1 f1 CRITICAL]** ~~Recalibrated multiplier for state-shaped JSON.~~
   Design 138 round 8 ruled the bound must cover arbitrary admitted bytes;
   nothing proves shape before JSON.parse allocates. Future path (separate
   design): a bounded-memory structural pre-parser proving the complete
   input is state-grammar within fixed memory, plus a measured multiplier
   FAMILY (r1 f4: multiple minimal schema-valid allocation families, max
   pinned) and a genuinely memory-limited benchmark harness.
   Original text preserved for context: The pinned
   `reset-memory-benchmark.test.ts` flood sweep measures adversarial
   mixed-container corpora (peak ~25.6×). Reset states are a known grammar:
   large flat arrays of file-entry objects with string/number fields. ADD a
   state-shaped corpus to the pinned benchmark (generated entries mirroring
   real manifest rows, ≥64 MB) and measure its true expansion. Introduce
   `RESET_PARSE_STATE_MULTIPLIER = ceil(measured) × 2` used for the
   admission of state files, KEEPING the 52× flood multiplier pinned in the
   benchmark as the adversarial reference. If the measured state-shape
   expansion is NOT materially below 26×, keep 52× and say so in the
   benchmark comment — the budget scaling alone already fixes the field
   case.
   - Fail-closed property preserved: admission still refuses when the
     (state-calibrated) worst case cannot fit; the benchmark pins the
     number so parser drift in future Bun versions fails CI, exactly as
     today.
3. **Teachable error.** `ResetMemoryAdmissionError` message gains one
   sentence: `set RBOX_RESET_PARSE_BUDGET_BYTES to raise the budget if this
   machine has memory to spare.`

## Non-goals
- No change to `RESET_MATERIALIZED_BYTE_LIMIT` (512 MiB absolute cap) or
  `RESET_STREAM_BYTE_LIMIT`.
- No change to when reset classification triggers (the ws-error → reset
  trigger on the founder's Mac is a SEPARATE investigation item).
- No consent/journal/quarantine semantics changes — admission math only.

## Tests
- Unit: budget derivation across totalmem values (8 GB floor, 32 GB, 96 GB,
  1 TB cap); env override precedence; error message includes the hint.
- Benchmark: new state-shaped corpus pinned alongside the flood corpus;
  fails CI if either measured multiplier drifts above its pin.
- Regression: admission with fileSize 59,220,693 + RSS 1.2e9 + totalmem
  96 GB PASSES; same with totalmem 8 GB still FAILS (fail-closed floor
  intact).

## r1 rulings (all 5 accepted)
f1 CRITICAL: multiplier work dropped (above). f2 HIGH: budget capped by the
Linux cgroup hard limit (v2 memory.max, v1 limit_in_bytes, unlimited
sentinels excluded); a known limit below the 4 GiB floor WINS (clean refusal
beats OOM-kill); read failures fall back to host-total scaling; documented
as a policy budget, not an allocatability proof. f3 HIGH: numbers corrected —
threshold RSS is 1,215,491,260 at the 4 GiB floor; tests pin both sides of
the exact boundary plus the field RSS (1.3 GB). f4 MED: the memory-limited
allocatability harness is recorded as the prerequisite for ANY future
multiplier change, not for budget scaling. f5 LOW: env-override matrix
pinned — valid values absolute and unclamped in BOTH directions;
absent/invalid fall back to the machine-scaled default.
