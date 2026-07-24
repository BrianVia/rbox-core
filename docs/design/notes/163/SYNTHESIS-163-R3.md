# 163 r3 wave synthesis — orchestrator rulings (2026-07-19)

Three independent reviews: REVIEW-163-R3A.md (decoder/crash), REVIEW-163-R3B.md
(budgets/migration), REVIEW-163-R3C.md (holistic, Opus). All three:
CHANGES-REQUIRED, findings localized. Verified-good across the wave (do NOT
reopen): the 138-boundary crash table, M0–M7 authority predicate (no
dual-authority found), rollout 2.0-branch confinement, adapter inventory
direction, current-code citations.

Every finding ACCEPTED. Deduped fold work-list for v4, in priority order:

## C1 (BLOCKER-class) — durable retirement subprotocol [r3a-3 ≡ r3b-3]
Source-change retirement (changed 1.7.x JSON between 2.0 attempts) has no
crash protocol: every deletion order lands in a state the exhaustive table
rejects (artifact-behind halt, or reserved-path orphan halt). Add a monotone,
durable retirement state (tombstone or control revision) with complete
correlated rows for every crash/ENOSPC point across M2–M5, or an ordering
whose every crash image is already admitted. r3b's concrete M5 counterexample
(steps 1–5, REVIEW-163-R3B.md finding 3) must be walked in the doc.

## C2 — M6/M7 cleanup correlation [r3a-4 + r3b-4]
(a) The M6 Q-sibling gets an exact path/identity bound to the control, with
absent/exact/foreign dispositions and crash rows before/after its fsync and
rename (power-loss old/new included). (b) Partial M7 cleanup must be
representable: per-resource disposition revisions (or a correlated cleanup
prefix) so a durably-absent emergency resource never contradicts an
`available` witness, including the ENOSPC-during-cleanup halt record.

## C3 — decoder contract freeze [r3a-1 + r3c-2]
Freeze: the pull interface (decoder-owned fixed buffer, readInto semantics,
max chunk, length authentication, unknown-length 52× admission input); token
accounting (define exactly what counts; pick one and restate the 8,192 bound
so the 256-Z maximum document demonstrably fits — recompute r3c's cap
arithmetic and fix the caps if the max legal document doesn't fit); decoded-
key comparison for duplicates (escapes normalize before comparison); BOM,
unpaired-surrogate, and base64 comparison domain (decoded string, not raw
lexeme — state it); `decodeResetJournal` return union + typed error codes.

## C4 — journal-independent J0/W1/W2 inventory [r3a-2]
Define one bounded, no-follow, journal-field-independent namespace inventory
(exact directory set, entry bound, special-entry and overflow behavior) that
J0/W1/W2 classification runs on BEFORE any decode, so a malformed journal
yields one deterministic row. Close the exact-Q + valid-active-S0 + orphan-
candidate-WAL remainder explicitly.

## C5 — receipt/oracle port contract [r3b-1]
Give the apply-receipt oracle a full sub-contract of ApplyPlanPort: staged
projected expected/oracle/observed rows + filesystem-token tables in the plan
DB, bounded receiver-equivalence joins, streaming canonical receipt hash,
declared simultaneous cursor windows, and retry/indeterminate semantics after
Git consumed a prior proof. Cite src/engine/apply-receipt.ts peaks it
replaces.

## C6 — construction-peak budgets [r3b-2]
WireAllocationLedger admits PEAK live bytes during construction, not only
retained size: either reserve a tested per-phase construction overhead bound
(transient backing-store overlap included) or phase construction so overlap
provably cannot occur; CI calibration gate asserts on measured PEAK, not
retained heap. Justify (or replace) the flat 32 MiB workspace number.

## C7 — U0 terminal semantics [r3b-5]
One serialized owner-controlled current-token cell; an unconditional owner-
abort that consumes the internally-current token (cannot fail stale); owner-
loss reclamation mechanism or explicit removal of the owner-loss guarantee
(WeakMap alone cannot service it — say which); worker results stay "pending"
through result application/discard and resource release, not merely promise
settlement (kills the settled-but-unapplied publication race).

## C8 — keystone/quarantine contradiction [r3c-1]
The keystone bullet says quarantine uses VACUUM INTO; the normative standing-
journal quarantine forbids opening the DB and uses byte-exact copies
(protecting the W2 signature). Fix the KEYSTONE BULLET to match the normative
section (byte-exact copy while a journal stands; VACUUM INTO only where the
normative text actually allows it). Do not weaken the normative section.

## C9 (minors) [r3c-3]
Remove stale "independently shippable" U0 wording (2.0-only). Mark the
256 KiB empty-DB seed cap as "to be measured at implementation, cap adjusted
then". Reconcile the <200 ms trusted target against the 0.84 s current
baseline (state it as target vs baseline, not implied parity).

Fold rule: strictly additive precision — no weakening of any keystone
constraint; cite the round (r3) at each fold site. Update the status header
to "v4 — pending final serial review" with a one-line v4 changelog.
