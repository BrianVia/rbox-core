# 180 r4 rulings (fold into v5 — MECHANISM PIVOT for the repair fence)

Reviewer: gpt-5.6-sol high, verdict CHANGES-REQUIRED, 11 findings, 4 BLOCKERs
all rooted in the permit-absence/witness/expiry fence. Per the standing
wrong-layer rule (a mechanism that breaks with a new exotic interleaving every
round is on the wrong plane), v5 REPLACES that fence rather than patching it:

## The pivot: tombstone-claim repair

Operator repair does NOT delete `account_keys`. The execute batch is exactly
two statements: (1) unconditional permanent audit insert (which stores the
orphan claim's ORIGINAL bytes for permanence and the operator/reason
metadata); (2) conditional UPDATE replacing the orphan claim's fields with a
TOMBSTONE value referencing the audit id (`repair_id`), predicated on the
exact legacy-orphan proof (unchanged from v4). Consequences, replacing v4's
permit table, witness exposure, ACTIVE predicate, and expiry:

- The claim row ALWAYS exists for a repaired account. `GET /v1/keys/account`
  observation is a single-row read — atomically either orphan, tombstone, or
  real claim. No 404 window, no cross-table snapshot problem.
- Old clients: GET returns 200 with the tombstone; their DTO verification
  fails closed (empty/invalid chains — e2ee-client.ts:92) BEFORE any key
  generation or local write; they never POST (they only bootstrap on
  account===null). The 428 capability fence on POST remains as
  defense-in-depth only.
- Capable clients: recognize the tombstone (a distinguished, versioned claim
  shape carrying `repair_id` and `repairedAt`) as the repair witness. It IS
  the witness — no separate exposure lifecycle.
- Completing repair: the capable bootstrap POST references the exact
  `repair_id`; the server transaction requires the tombstone with that id as
  the expected-previous value and atomically replaces it with the real
  genesis (claim + children batch, all-or-none as already designed). After
  replacement no tombstone exists — witness authority ends atomically with
  its consumption.
- No expiry. The tombstone is durable until replaced. An operator
  cancel/re-repair is a new audited operation, not a timeout.

## Rulings

1. **BLOCKER preflight not linearizable — ACCEPT via pivot.** Single-row
   tombstone observation removes the split read. Test: repair executing
   between a client's presence read and POST is excluded by the tombstone
   expected-previous check, and old-client GET during repair always sees the
   tombstone (fail closed), never 404/pristine.
2. **BLOCKER ACTIVE conflates fence and witness — MOOT via pivot.** No
   ACTIVE predicate exists; the fence is the tombstone row itself and the
   audit row is never consulted for fencing. Remove the attempted/completed
   fencing dependency entirely (the attempted→completed audit protocol stays,
   but purely as operator record-keeping).
3. **BLOCKER expiry fails open — MOOT via pivot.** No expiry. Fold must
   state invariant: a tombstoned account can never be observed as pristine by
   ANY client, capable or not, at any time.
4. **BLOCKER retained archive becomes illegal — ACCEPT.** The quarantine
   manifest gains a durable `completed` terminal marker written after
   archival finishes and BEFORE the repair bootstrap POST. A completed
   archive is INERT: never classification input, purely an operator artifact,
   regardless of tombstone/witness state. Post-consumption classification
   tests include a retained completed archive.
5. **HIGH manifest-first omits dir creation — ACCEPT.** Publication order:
   create quarantine dir → publish manifest → renames. An empty quarantine
   dir for the CURRENT repair_id with no manifest is removable debris
   (remove-and-recreate rule); classification never treats it as an artifact.
   Crash tests start at dir creation, not manifest publication.
6. **HIGH workspace creation unfenced — ACCEPT.** Workspace creation
   (authz.ts:89 / routes/account.ts:37 path) refuses with 423 while the
   account claim is a tombstone — same fence as workspace commits. Transition
   tests cover old setup/init attempting workspace creation during repair.
7. **HIGH competing-cleaned quarantine undefined — ACCEPT.** ONE shared
   local-quarantine primitive (manifest-first, hash-checked renames,
   completed marker, uniqueness key) with two users: repaired-legacy archival
   (key = repair_id) and competing/abandoned staged-RK disposal (key =
   journal attempt id). Specify exact paths, uniqueness, destination-byte
   validation, and legal partial states once, in the primitive's section;
   both call sites reference it. Design 179's competing-cleaned wording
   points at the shared primitive (bump 179 note to 'v10 — shared quarantine
   primitive per 180 r4').
8. **HIGH anomaly vectors not executable — MOOT-SIMPLIFIED via pivot.** The
   batch's vectors are exactly `audit=1, update=1` (success) and
   `audit=1, update=0` (refused: proof failed or tombstone/claim state
   changed). No other vector exists; completion update records which. Remove
   the anomaly machinery.
9. **HIGH 409 collides with retry semantics — ACCEPT.** 423 is THE repair
   fencing status everywhere: GET (incapable), POST fence, workspace
   creation, workspace commits. No 409 anywhere in repair fencing.
10. **MEDIUM completion intent unbound — ACCEPT.** Intent schema gains
    `version: 1`, `accountId`, the journal attempt identity (request digest),
    and `intentAt`. Any mismatch with the active journal → the deterministic
    reselection protocol (never resume a mismatched intent).
11. **MEDIUM old-client UX assertion false — ACCEPT.** Honest copy: the old
    client surfaces its own transport/verification error (e.g.
    `keys/account failed: 423` or a chain-verification failure), NOT the
    server's message; document that this is acceptable because it fails
    closed with zero local mutation.

Also: keep the r2/r3-certified pieces untouched where the pivot doesn't reach
them (exact-field idempotency for ordinary replays, classification table
structure, journal phases, completion hold, E2EE-boundary gate, durability
failure model, capability header, genesisPresenceVersion). Update the
classification table rows that referenced "active-permit repair witness" to
reference the tombstone. Update the E2E repair test to the tombstone flow with
the REAL orphan seed.
