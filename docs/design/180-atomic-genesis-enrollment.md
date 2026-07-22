# 180 — atomic genesis enrollment

Status: v1 — DRAFT (founder-directed wrong-layer split from design 179; pending its own adversarial review loop, 2026-07-21).

Owner: Claude (founder-directed, 2026-07-21)

Origin: design 179 review rounds 3–5. Round 3 found the lost-bootstrap-response
classification defect; rounds 4–5 established that publication atomicity,
restart replay, enrollment classification, and orphan repair are a pre-existing
genesis subsystem rather than macOS Keychain behavior.

## Problem

Production genesis is already crash-unsafe, before and independently of the
recovery-kit Keychain work. `bootstrapAccountKeys` first commits the
`account_keys` claim and only afterward submits roster v0, account-key-state
epoch 0, and the first device in a separate D1 batch
(`apps/api/src/keys.ts:109-125`). A process, transport, or D1 failure between
those commits leaves a non-null account with no verified genesis chain.

That partial account is permanently wedged today:

- every retry sees the committed `account_keys` row and returns
  `already_bootstrapped`;
- chain verification correctly rejects the empty roster/key-state history
  (`src/cli/e2ee-client.ts:84-89`); and
- direct genesis, device-code login, and setup currently use DTO presence as an
  enrollment answer (`src/cli/auth-cmd.ts:128`, `src/cli/auth-cmd.ts:175`,
  `src/cli/setup-cmd.ts:526`), so they misroute the user into already-set-up,
  pairing, or recovery paths that cannot repair the missing genesis.

Consequently, **a crash during any bootstrap today can leave the account
permanently unusable for E2EE enrollment**. The macOS Keychain design merely
made this older defect visible by requiring a rigorous answer after every
publication crash. This design repairs the genesis layer for every platform and
every enrollment surface.

## Goals

1. Publish the account claim, roster v0, key-state epoch 0, and first device as
   one all-or-nothing server transaction.
2. Make a pre-publication or ambiguous-response process restart resume the exact
   same bootstrap attempt; never regenerate randomized wraps while the prior
   request can still win.
3. Classify enrollment once, cryptographically, and use that classifier at
   direct genesis, device-code login, and setup preflight.
4. Treat a lost successful response as success only after exact comparison with
   verified published genesis; never infer ownership from `409` or DTO presence.
5. Diagnose the exact legacy orphan without deleting local recovery material,
   and provide a fully fenced operator repair that cannot race stale key writes.
6. Ship the server correction and repair capability before any client depends
   on the new guarantees.

## Non-goals

- Keychain storage, recovery-kit offers, staged-RK commitment, and plaintext-kit
  cleanup remain design 179.
- This is not a general repair mechanism for malformed, non-empty, forked, or
  cryptographically invalid account histories. Those remain fatal integrity
  incidents requiring investigation.
- The server remains a zero-knowledge opaque store. It bounds and atomically
  stores client-produced values but does not parse or verify signed envelopes.
- This does not change ordinary pairing/recovery admission or define a new way
  to recover RK/MK.

## Invariants

1. **Server totality:** every new atomic publication, and every account after
   successful repair, exposes either no genesis rows or one mutually consistent
   four-row set. A new partial state cannot commit; old one-row orphans remain
   detectable until repaired.
2. **One attempt across ambiguity:** after local attempt publication, every
   retry sends the exact persisted request bytes until verified classification
   reaches a terminal result.
3. **Compare, do not assume:** `200`, `409`, a lost response, or a non-null DTO
   is not proof that this attempt won. Only a verified fetch plus exact field
   comparison can establish that.
4. **One classifier:** no enrollment entry point independently interprets
   `AccountKeysDTO | null`.
5. **Repair is narrower than detection:** only the precise old split-publication
   orphan is automatically repairable. Any dependent or ambiguous state is
   refused.
6. **No unfenced repair gap:** after orphan removal, stale clients cannot publish
   key children before the replacement atomic bootstrap consumes the repair
   permit.

## Design

### 1. Durable exact-attempt journal

Genesis becomes a resumable, platform-independent protocol. Before the first
bootstrap request, the client generates the account/device material once,
persists the local device/MK material as today, serializes the complete request
body once, and durably publishes an account-scoped `genesis-attempt.json`.

The strict v1 journal contains:

```jsonc
{
  "version": 1,
  "accountId": "acct_0123456789abcdef",
  "deviceId": "dev_…",
  "startedAt": "2026-07-21T16:28:00.000Z",
  "requestBody": "{the exact UTF-8 JSON string sent to /v1/keys/bootstrap}",
  "completionHolds": ["recovery-kit-staging"]
}
```

`requestBody` contains every exact opaque transport string: `recoveryWrap`,
`recoveryWrapId`, `genesisRoster`, `genesisKeyState`, and all four `device`
fields. It is not a reconstruction from hashes or public identifiers. In
particular, it preserves the randomized recovery-wrap and MK-wrap ciphertexts
that a fresh `bootstrapAccount` call cannot reproduce. The saved string is
bounded by `KEY_BOOTSTRAP_MAX_BYTES`, strictly parsed against the bootstrap
wire schema on read, account/device-bound, mode 600, never logged, and replayed
as the identical UTF-8 request bytes rather than parse-and-reserialize output.

`completionHolds` is a strict, duplicate-free set of registered local
prepublication obligations. It is empty for ordinary bootstrap; design 179
registers `recovery-kit-staging` when it has durably staged RK before this
journal is published. The set is immutable after the first POST. A hold is
acknowledged only after its owner durably reaches its own terminal state — for
design 179, after verified artifact-locator commitment plus staged-state
cleanup, or after verified competing-genesis cleanup. Classification may reach
a terminal publication result while a hold exists, but the exact journal is not
retired until every hold has durably acknowledged. Thus a crash between server
publication and Keychain/file commitment still has the exact comparison
evidence on restart; the account cannot collapse prematurely to plain
`enrolled`.

Journal publication uses a same-directory exclusive temporary file, complete
write, file fsync, atomic rename, exact read-back, published-file fsync, and
parent-directory fsync. Fresh ancestors are durably published before the
journal counts as present. Journal deletion is complete only after parent-
directory fsync. Any failure before durable journal publication prevents the
POST. Any read, parse, identity, local-material, or durability failure with a
journal present fails closed and preserves it; it never starts a second
attempt.

On a restart with a journal and server-null classification, the client reuses
the already persisted local device material and replays `requestBody` exactly.
It does not call `bootstrapAccount`, overwrite the journal, replace local keys,
or overwrite any design-179 staged RK. This closes the round-5 server-null gap
where a prior in-flight request remains capable of winning after the process
has restarted.

### 2. Shared verified enrollment classifier

`e2ee-client.ts` owns one pure-with-crypto classifier over authenticated
`AccountKeysDTO | null` plus the optional valid attempt journal. It is the only
component allowed to translate a preflight DTO into enrollment state:

| Result | Required evidence | Caller behavior |
|---|---|---|
| `pristine` | Server returns `null`; no attempt journal. | A new attempt may be generated and journaled. |
| `resume-attempt` | Server returns `null`; exact valid journal and matching local material exist. | Replay only that request. |
| `committed-this-attempt` | Complete signed chains verify for the authenticated account and every exact persisted genesis field matches. | Treat a lost/ambiguous response as success; preserve dependent local state until its owner commits it. |
| `competing-genesis` | Complete signed chains verify, but at least one exact persisted genesis field differs or the journal's device is absent. | The pending attempt lost; perform the existing abandoned-attempt local cleanup. |
| `enrolled` | Complete signed chains verify and no attempt journal exists. | Route to ordinary already-enrolled/pair/recover behavior. |
| `legacy-orphan` | A non-null DTO has an `account_keys` claim but zero rosters, zero key states, and zero devices. | Preserve all local/pending state and show the wedged-account support error. |
| `integrity-failure` | Any other non-null incomplete shape, parse failure, invalid signature/chain, signed account-id mismatch, or inconsistent history. | Fatal refusal; never label repairable or clean up evidence. |

Verification parses the signed roster and key-state histories, runs the existing
`verifyAccount` chain verification, and binds the verified roster account id to
the authenticated account before returning any enrolled result. Exact-attempt
comparison then compares the persisted request's `recoveryWrap`,
`recoveryWrapId`, roster-v0 string, key-state-0 string, and the matching device's
id/public keys/`mkWrap` directly to the fetched opaque strings. It does not
reserialize signed objects or compare only hashes.

The same classifier is mandatory at all three preflight entries:

- direct `runGenesisEnrollment` (`src/cli/auth-cmd.ts:128`);
- device-code post-approval (`src/cli/auth-cmd.ts:175`); and
- setup `resolveEnrollment` (`src/cli/setup-cmd.ts:526`).

Those call sites switch on the closed result set and contain no independent
`Boolean(dto)`, null/non-null, empty-array, or catch-and-assume logic. Pairing and
recovery retain their existing full verification; this shared preflight only
decides which enrollment route is valid.

`legacy-orphan` uses one stable safe user message and machine-readable error
code across all three surfaces: the account's encryption setup is incomplete,
pairing/recovery cannot repair it, local material has been preserved, and rbox
support must run the atomic-genesis repair before setup is retried.

### 3. Atomic server-side publication

`bootstrapAccountKeys` uses one `dbFor` handle and one D1 atomic batch/
transaction for, in order:

1. `account_keys` for the account claim and recovery wrap;
2. roster version 0;
3. account-key-state epoch 0;
4. the authenticated first device; and
5. deletion of any repair permit for this account.

The first four statements use conflict-raising `INSERT`, never `INSERT OR
IGNORE`. A uniqueness/constraint error at any statement aborts and rolls back
the entire batch. This is load-bearing: ignored constraints report successful
zero-row statements and could otherwise let bootstrap against an old orphan
populate its missing child rows before returning `409`.

The handler maps a conflict on the account claim to
`already_bootstrapped` only after rollback. Other child constraint failures are
safe conflicts/integrity errors, also after rollback; none can return `ok: true`.
The batch results must show one change for each genesis insert. `ok: true` is
returned only after commit. A bootstrap against an exact legacy orphan returns
`409` and leaves the existing claim and every child table byte-for-byte
unchanged.

Automatic transport retries may remain enabled. Regardless of whether the
caller observes `200`, `409`, a timeout, or a socket close, it fetches and runs
the shared classifier. `committed-this-attempt` is the only terminal success for
a journaled attempt. `resume-attempt` retries the exact bytes within existing
bounds or on the next invocation. Fetch/classification failure retains the
journal and local material for later retry; it is neither success nor a
competing genesis.

### 4. Repair permit and mutation fence

A migration adds an account-scoped `genesis_repair_permits` table with one row
per account, an unguessable permit id, `created_at`, operator/reason audit
metadata, and no client-visible secret. The permit marks the narrow interval
after a verified old orphan is removed and before replacement genesis commits.

Every non-bootstrap E2EE key mutation (`device`, `admit`, `roster`, `keystate`,
and `workspace`) and E2EE-bearing pairing-token creation is changed to require
both an existing `account_keys` row and the absence of a repair permit in the
same conditional write/batch. A failed guard returns `409 repair_in_progress`
or `409 account_not_bootstrapped` and writes nothing. This protects ordinary
pristine accounts as well as repaired ones and prevents stale authorized
clients from constructing children or old-genesis admission material without a
genesis claim.

The operator repair helper uses one D1 handle and one atomic transaction. Its
first statement conditionally creates exactly one permit with the same complete
orphan proof below; its second statement performs one conditional delete whose
SQL `WHERE` clause independently repeats and therefore itself encodes that
entire repair proof:

- the targeted `account_keys` row exists exactly once;
- no roster row exists for the account;
- no account-key-state row exists for the account;
- no device-key row exists for the account;
- no workspace-key row exists for the account;
- no E2EE-bearing pairing token exists for the account; and
- no other current account-scoped encrypted/key-dependent table identified by
  the implementation inventory contains a row for the account.

The delete must report `changes === 1`, and the conditional permit insert must
also report one change. If the proof is false, both statements change zero rows,
the transaction leaves state unchanged, and the helper returns
`not_exact_orphan`; it never follows a separate read with an unguarded delete.
Any impossible one/zero result mismatch leaves the permit fence in its safer
state and escalates rather than attempting cleanup. A pre-existing permit with
no account claim returns `already_repairing` so the operator resumes the
existing runbook instead of minting a second permit. The migration and
implementation review inventory every account-scoped E2EE table, including
indirect workspace ownership where a table lacks `account_id`, so adding a
future dependent table requires updating both predicates and their tests.

While the permit exists, all non-bootstrap key mutations are fenced. The next
bootstrap is allowed, publishes all four rows atomically, and deletes the permit
as the final statement in that same transaction. A bootstrap failure rolls back
both genesis rows and permit deletion, leaving the fence in force. A concurrent
or stale bootstrap either wins one complete atomic genesis or loses without
mutation; no client-supplied permit token bypass exists.

Permits do not expire automatically. An abandoned repair remains visibly
fenced until the operator resumes the runbook or explicitly investigates and
revokes it with the same guarded tooling. This prefers a diagnosable halt over
silently reopening the race.

### 5. Client state machine

Under the existing per-account genesis lock:

1. Fetch once and invoke the shared classifier with any journal.
2. On `pristine`, generate once, persist local device/MK material, satisfy any
   caller-owned prepublication condition (design 179's staged-RK foothold is one
   such condition), serialize once, and durably publish the exact journal.
3. On `resume-attempt`, skip generation and reuse journal plus local material.
4. Send the exact journal bytes. After any response or transport ambiguity,
   fetch and classify rather than interpreting the response as ownership.
5. On `committed-this-attempt`, return that typed result to dependent local
   state machines. Durably retire the journal only when every registered
   completion hold has acknowledged; a crash before acknowledgement or
   retirement is harmless because comparison is idempotent.
6. On `competing-genesis`, return that typed result, run abandoned-attempt
   cleanup, acknowledge its completion hold only after cleanup reaches its
   conservative durable terminal state, and retire the journal only after all
   holds acknowledge.
7. On `legacy-orphan`, `integrity-failure`, fetch failure, or indeterminate
   local state, retain journal and all local material and fail closed.

The lock acquisition path must not recursively create a fresh keystore tree
before the caller's required durable-directory publication. Design 179 retains
that stronger local foothold contract for staged RK; the generic journal uses
the same ordering principle.

### 6. Wedged-account runbook

The support procedure is deliberately one-way and narrow:

1. Confirm the client reports `legacy_orphan`, record account/request/audit
   context, and tell the user not to delete the affected machine's local state.
2. Confirm the atomic bootstrap, shared classifier, repair-permit migration, and
   mutation fences are deployed in production. Never repair for an old client
   against an old split endpoint.
3. Invoke the scoped operator repair helper for the exact account. Do not issue
   an ad-hoc `DELETE` or run the proof and deletion as separate SQL commands.
4. The helper atomically creates the permit and executes the emptiness-encoding
   delete. If `changes !== 1`, stop: preserve all rows, capture the table counts,
   retain any safety permit, and escalate as an integrity incident.
5. Confirm the account claim is absent, the repair permit is present, and every
   guarded key mutation is fenced.
6. Ask the user to rerun genesis from the machine that retains the pending
   attempt/local material. It replays that attempt when present or creates one
   only when the classifier proves `pristine` with no journal.
7. Confirm one atomic bootstrap consumed the permit and that the fetched roster,
   key-state chain, recovery-wrap binding, and first device verify end to end.
   Preserve the audit record; do not call the repair complete from row counts
   alone.

If the account has any roster, key state, device key, workspace key,
E2EE-bearing pairing token, indirect dependent row, malformed signed material,
or an ambiguous shape, the runbook refuses deletion. There is no “best effort”
completion of a partial genesis.

### 7. Ownership and release order

Per `docs/CODEMAP.md:143`, `src/cli/e2ee-client.ts` owns bootstrap orchestration,
the attempt journal protocol, verified DTO classification, and exact-attempt
comparison. Per `docs/CODEMAP.md:154`, `src/cli/remote/keys.ts` remains transport
only: exact-body POST/fetch and typed HTTP errors, never crypto interpretation.
`apps/api/src/keys.ts` owns atomic publication, mutation guards, permit
consumption, and the narrow operator repair transaction. Command modules consume
classifier outcomes and own only UX/routing. Implementation updates CODEMAP if
the API module line or any new module changes mapped ownership.

Release is API-first. Read `docs/DEPLOYMENTS.md` before changing or deploying
`apps/api/**`: add/apply the migration, deploy and verify the atomic endpoint,
guards, and repair helper in dev, promote the production API only after CI and
dev validation, and only then release a CLI that relies on the protocol. The
compare-don't-assume client remains mandatory after promotion because an atomic
commit can still lose its response.

## Security and privacy

- The attempt journal contains opaque recovery/device wraps and signed public
  material, not plaintext RK, MK, private keys, or phrase text. It is still
  treated as sensitive local state: mode 600, bounded, redacted, and removed
  durably only at a terminal classification.
- Server logs and client errors never include request-body fields, hashes of
  secrets, permit ids, signed envelopes, wraps, account ids as metrics
  dimensions, or local journal paths.
- The repair permit is operator/audit state, not authorization granted to a
  client. Authentication and account scoping remain required for bootstrap.
- Exact comparison happens only after chain and account-id verification. A
  server-provided matching string outside a verified genesis cannot cause
  success or local cleanup.
- Repair defaults to preservation. Unexpected rows, invalid crypto, missing
  audit context, migration skew, and guard failures all halt.

## Testing

1. **Attempt-journal unit tests:** strict version/account/device/body parsing;
   exact UTF-8 byte preservation through escaping and reload; maximum size;
   no parse/reserialize replay; atomic temp/rename, read-back, file fsync,
   parent-directory fsync, ancestor publication, and durable unlink failures;
   malformed/mismatched journal preserves state and prevents generation/POST.
2. **Restart tests:** crash at every boundary from local-key persistence through
   journal publication, send, response, fetch, classification, and retirement.
   A journal plus server-null restart replays identical bytes and never calls
   key generation or overwrites staged/local material. Repeated null and network
   failure remain idempotent. A committed result with a recovery-kit hold keeps
   the exact journal across restart until design 179 durably clears staging and
   acknowledges; crash before and after acknowledgement is conservative and
   idempotent.
3. **Classifier tests:** exhaustive closed-result table; verified complete
   account; exact matching attempt; one-field-at-a-time competing attempt;
   exact empty legacy orphan; every partially non-empty shape; malformed JSON,
   invalid signature/chain, account-id mismatch, missing attempt device, and
   fetch error. Only a verified exact match yields `committed-this-attempt`.
4. **Every-entry preflight tests:** direct genesis, device-code post-approval,
   and setup each consume the same classifier seam. Seed pristine, resume,
   enrolled, matching, competing, orphan, and integrity-failure results; assert
   no entry point branches on raw DTO presence and orphan preserves local state
   with the same actionable error.
5. **API atomicity tests:** inject failure after every logical statement. Failure
   leaves zero new genesis rows; success leaves exactly four consistent rows.
   Cover all constraint failures, concurrent bootstraps, rollback retry, lost
   success response followed by `409`, and result-count checks. Seed an exact
   legacy orphan, call bootstrap, require `409`, and compare every table
   byte-for-byte before/after.
6. **Repair/fence tests:** one predicate at a time makes both the proof-gated
   permit insert and emptiness-encoding delete change zero rows; `changes === 1`
   is mandatory for both on success. Cover
   device, roster, key-state, workspace-key, E2EE-pairing, and every indirect
   dependent table. Race stale mutations, E2EE-bearing pair creation, and stale
   bootstrap attempts between repair and rerun; all non-bootstrap writes remain
   empty, one atomic bootstrap consumes the permit, and failed bootstrap retains
   it. Test operator retry, abandoned permit visibility, and no automatic
   expiry.
7. **Lost-response end-to-end:** commit the atomic transaction and drop the
   response; transport retry receives `already_bootstrapped`; fetch/verify/exact
   compare returns success. A complete different genesis returns competing; a
   failed fetch is indeterminate and preserves the journal.
8. **Deployment validation:** migration and API tests, unit/typecheck, then
   `bun run rig` or a dev build shipped to the local fleet per repository flow.
   Exercise the runbook against a seeded dev orphan before production promotion.

## Slices

1. Migration, conflict-raising atomic genesis transaction, statement-boundary
   tests, mutation guards, repair permit, and guarded operator repair helper.
2. Exact attempt journal and durable replay, shared verified classifier, and
   lost-response compare-don't-assume state machine.
3. Direct genesis, device-code login, and setup adoption of the shared result
   type; uniform wedge UX and local-material preservation.
4. Dev orphan/runbook validation, API-first production promotion, dependent CLI
   release, and full rig/local-fleet validation.

## Open questions (for review)

None in v1. Atomic conflict behavior, exact-payload replay, shared classifier
coverage, repair fencing/permit consumption, lost-response comparison, and the
runbook boundaries are founder-pinned inputs to design 180's review loop.
