# 180 — atomic genesis enrollment

Status: ALIGNED v14 — post-field-validation amendments r14

Pinned r1 ruling record (2026-07-22; binding):

1. ACCEPT — every bootstrap durably stages phrase-recoverable RK before journal/POST and retains it behind a completion hold until phrase delivery or durable artifact commitment.
2. ACCEPT — `device.json`, `mk.key`, staged RK, markers, and journal all use the hardened atomic-write/fsync/directory-publication contract before POST.
3. ACCEPT — account fetch exposes authoritative child presence when the claim is absent, so child-only state is `integrity-failure`.
4. ACCEPT — pending genesis state overrides every local-enrolled shortcut, with whole-command restart coverage for setup, init bootstrap, and bare rbox.
5. ACCEPT — bootstrap is exact-field idempotent server-side, and consuming a repair permit requires a capable client (r2 replaces the historical minimum-version mechanism with a protocol header).
6. ACCEPT — repair uses a concrete platform-secret admin route, exact request/dry-run contracts, and a dedicated permanent audit table.
7. ACCEPT — repairability requires the precise nonempty old-endpoint claim shape in client classification and both authoritative SQL predicates.
8. ACCEPT — no-journal enrollment requires recovery-wrap, device-row, roster-lifecycle, and wrap-authorization consistency in addition to chain verification.
9. ACCEPT — the pairing-token fence pins N=1 co-location as a prerequisite and explicit sharding blocker.

Pinned r2 ruling record (2026-07-22; binding):

1. ACCEPT — a permanent server repair witness unlocks only the exact unmarked legacy local shape, which is archived by rename into a timestamped keystore quarantine before pristine restart.
2. ACCEPT — claim deletion requires the sole existing permit to be the newly inserted permit/audit pair; `1/1/0` is a concurrent-permit race refusal.
3. ACCEPT — receipt-bearing journals are terminal `cleanup-resume`; cleanup is idempotent, competing authorization precedes destruction, and prepublication cleanup removes the marker last.
4. ACCEPT-MODIFIED — repair refuses any authoritative workspace-registry ownership, and workspace-sync commit acceptance requires a claim and no active repair permit.
5. ACCEPT — the common E2EE-loading boundary gates unreleased genesis holds, with a read-only diagnostics allowlist and the same check on export.
6. ACCEPT — design 180 solely owns `rk.key.staged` and journal-phase migration; design 179 layers cache preference and verified artifact commitment on that artifact.
7. ACCEPT-MODIFIED — durability guarantees are explicitly limited by platform crash semantics and best-effort, lstat-based symlink checks.
8. ACCEPT — `x-rbox-genesis-capability: 1` replaces the minimum-version gate; `x-rbox-version` is informational.
9. ACCEPT — audit rows begin at `attempted` and an idempotent completion update records the result vector and `completed_at`, with read-time reconciliation.
10. ACCEPT — every 404 and 200 presence body requires `genesisPresenceVersion: 1`.
11. ACCEPT — the stale `e2ee-client.ts` citation is corrected to line 92.

Pinned r3 ruling record (2026-07-22; binding):

Where this record corrects an earlier pinned line, the r3 ruling controls.

1. ACCEPT — while a repair permit is active, account preflight returns `423 repair_in_progress` to clients lacking the genesis-capability header, before an old client can replace local legacy keys; POST retains its 428 defense-in-depth fence.
2. ACCEPT — `competing-cleaned` always quarantines the losing staged RK, and ordinary winning-path promotion requires exact validated destination bytes before journal retirement.
3. ACCEPT — a separate durable completion-intent record pins the selected phrase, Keychain identity, or exact kit path before commitment; absence means deterministic user-visible reselection, not resumption of an unknown choice.
4. ACCEPT — repaired-legacy archival uses a witness-bound, manifest-first, hash-checked `quarantine-resume` protocol whose only legal partial states are executable and crash-closed.
5. ACCEPT — a repair witness is exposed and accepted only while its exact repair permit is active; the permanent audit row is not continuing client mutation authority.
6. ACCEPT — transactional result vectors `1/1/0` and `1/0/0` are integrity anomalies with `outcome='anomaly'`, a 500-class response, audit id, and manual escalation.
7. ACCEPT — the workspace commit fence is a new claim/permit check immediately before Durable Object forwarding, not an existing lookup.
8. ACCEPT — CODEMAP ownership language describes the implementation's future state and retains the required same-change CODEMAP update.
9. ACCEPT — design 179 corrects the existing unwrap-test claim and adds explicit wrong/historical-envelope substitution coverage.

Pinned r4 ruling record (2026-07-22; binding):

Where this record replaces the permit-absence/witness/expiry mechanism in an
earlier pinned line, the r4 tombstone ruling controls.

1. ACCEPT VIA PIVOT — operator repair atomically replaces the orphan claim with
   a versioned tombstone claim; single-row observation and bootstrap's exact
   tombstone expected-previous check close the preflight race.
2. MOOT VIA PIVOT — there is no ACTIVE predicate. The tombstone itself is the
   fence and client witness; audit outcome is operator record-keeping only.
3. MOOT VIA PIVOT — tombstones do not expire. A tombstoned account can never be
   observed as pristine by any client, capable or not.
4. ACCEPT — local quarantine publishes a durable `completed` terminal marker
   before repair bootstrap; a completed archive is permanently inert and never
   classification input.
5. ACCEPT — quarantine publication order is directory, manifest, renames, then
   completed marker; an empty directory for the current uniqueness key is
   removable debris.
6. ACCEPT — workspace creation as well as workspace commit returns 423 while
   the account claim is a tombstone.
7. ACCEPT — repaired-legacy archival and competing/abandoned staged-RK disposal
   use one manifest-first, hash-checked, completed-marker quarantine primitive,
   keyed respectively by repair id and journal request digest.
8. MOOT-SIMPLIFIED VIA PIVOT — the two-statement execute batch has only
   `audit=1, update=1` success and `audit=1, update=0` refusal; completion records
   the vector, with no anomaly-vector machinery.
9. ACCEPT — 423 is the only repair-fencing status for tombstone-blocked POSTs,
   key mutations, pairing, workspace creation, and workspace commits. The 428
   bootstrap capability validation remains defense in depth, not a repair
   state discriminator.
10. ACCEPT — completion intent is versioned and bound to account id and the
    active journal's exact request digest; mismatch invokes visible
    deterministic reselection.
11. ACCEPT — old clients honestly surface their own transport or chain-
    verification error, not necessarily server copy; safety is fail-closed with
    zero local mutation.

Pinned r5 ruling record (2026-07-22; binding):

Where this record corrects an earlier refusal-proof, old-client, workspace-
fence, reconciliation, quarantine, completion-intent, or version statement,
the r5 ruling controls.

1. ACCEPT — an execute `update=0` has no transaction-bound exact refusal
   classification: it records generic `refused` plus an explicitly
   observational post-hoc snapshot and returns
   `repair_refused_state_changed` with the audit id and that snapshot.
2. ACCEPT — every repair-bootstrap child insert and the final claim update
   carries the complete exact-tombstone, all-zero dependent inventory, and
   zero-workspace expected-previous predicate.
3. ACCEPT — old-client behavior is stated per call site; the load-bearing
   invariant is that no old-client tombstone path writes or deletes local keys,
   with deletion reachable only from literal `409 already_bootstrapped` while
   tombstone POSTs return 423.
4. ACCEPT — workspace creation checks the tombstone before quota and viewer
   authorization, guards ownership and fair-use statements, and suppresses
   audit effects on refusal; workspace-sync fencing is defense in depth after
   ordinary authorization for anomalous workspace-bearing tombstones.
5. ACCEPT — every tombstone mutation or deletion, including repair bootstrap,
   account deletion, and future cancel/re-repair, first reconciles and
   completes attempted audits for that account.
6. ACCEPT — the hardened writer contract expressly covers the quarantine
   directory chain, `quarantine-resume.json`, and `completed.json`, with the
   complete parser/crash/state matrix tested for both quarantine users.
7. ACCEPT — kit-path completion intent stores the selection-time resolved
   absolute path, and no structurally valid intent acts without a winning,
   authorized classifier result.
8. ACCEPT — design 179's seam version reference and this design's capability-
   versus-schema version wording are consistent.

Pinned r6 ruling record (2026-07-22; binding):

Where this record strengthens the reconciliation, purge, quarantine,
presence, writer-test, or workspace-creation language in an earlier pinned
line, the r6 ruling controls.

1. ACCEPT — every tombstone/claim mutator transaction carries a transaction-
   local `NOT EXISTS` guard for attempted repair audits; a blocked mutator
   reconciles and retries, including repair execute, repair bootstrap, the
   `finishD1` claim deletion, and future cancel/re-repair.
2. ACCEPT — reconciliation completes a stranded dry-run audit as
   `dry_run_incomplete`; it never infers an execute result or grants authority,
   and it blocks mutators until that cheap reconciliation completes.
3. ACCEPT-MODIFIED — hard purge scrubs rather than deletes repair audits:
   account-scoped/free-text/original-claim evidence is replaced by a hash while
   the minimal compliance fields remain, as an explicit design-37 privacy
   exemption; reconciliation occurs at the actual scheduled-purge `finishD1`
   boundary.
4. ACCEPT — `competing-cleaned` quarantines the losing `rk.key.staged`,
   `device.json`, and `mk.key` in one shared-primitive manifest, and the journal
   cannot retire before that manifest is terminally completed.
5. ACCEPT — version-1 `GenesisPresence` includes authoritative owned-workspace
   count, and a workspace-bearing tombstone is `integrity-failure`.
6. ACCEPT — the hardened-writer injected-failure matrix covers both
   `quarantine-resume.json` and `completed.json` for both quarantine users.
7. ACCEPT — workspace creation's guard is "claim is not a tombstone": an
   absent claim preserves legacy behavior, while only a tombstone produces the
   guarded zero vector and 423 with no side effects.

Pinned r7 ruling record (2026-07-22; binding):

Where this record strengthens the repair-audit insertion and mandatory
pending-state-consumer language in an earlier pinned line, the r7 ruling
controls.

1. ACCEPT — execute and dry-run repair-audit insertion transactionally refuses
   when the account deletion ledger is `purging` or `done`: the audit insert
   itself carries the deletion-ledger `NOT EXISTS` predicate, returns the
   distinct `account_erased` response without an `auditId`, and creates no
   account-linked row. Reverse-order races cover `finishD1` winning before
   either insertion.
2. ACCEPT — direct pairing redemption (`rbox connect` / pair) and `rbox key
   recover`, including design 179's Keychain restore, are mandatory
   pending-state consumers. Under the genesis lock they resolve an active
   journal through the classifier's resume/cleanup path before replacing
   credentials, persisting device/MK material, or admitting.

Pinned r8 ruling record (2026-07-22; binding):

Where this record strengthens the deletion-ledger fence and corrects pairing's
pre-redemption scope in an earlier pinned line, the r8 ruling controls.

1. HIGH ACCEPT-MODIFIED — pairing redemption uses machine-global pending-state
   arbitration, not account-scoped target discovery or a new non-consuming
   token-resolution protocol. Before consuming any opaque pairing token it
   enumerates every local account directory, including stale directories, and
   routes every active genesis journal through the shared classifier. While any
   journal remains active, pairing blocks with the stable resume instruction and
   performs no token redemption or local/admission mutation.
2. BLOCKER ACCEPT — every statement in every affected account-linked mutation
   batch carries its own transaction-local deletion-ledger `NOT EXISTS` guard:
   ordinary bootstrap's four-row genesis, repair bootstrap, and workspace
   creation including its fair-use upsert. A `purging` or `done` ledger refuses
   with `account_erased`; an absent ledger passes, preserving live legacy
   accounts with absent `account_keys`. Reverse-order tests schedule deletion
   and let `finishD1` commit before each batch.

Pinned r9 ruling record (2026-07-22; binding):

Where this record strengthens workspace-creation audit atomicity and completes
pairing's global-to-account lock handoff, the r9 ruling controls.

1. BLOCKER ACCEPT — the workspace-creation audit INSERT is part of the same
   guarded transaction as the ownership INSERT and fair-use upsert, and carries
   the same transaction-local deletion-ledger `NOT EXISTS` guard. No separate
   post-batch audit call remains, so `finishD1` cannot be followed by any newly
   committed account-linked workspace-creation row.
2. HIGH ACCEPT — publication of the first pending artifact, including the
   prepublish marker, coordinates with the global arbitration lock. Pairing
   holds that lock through `/pair/redeem`; once the response identifies the
   target account, pairing acquires the target account's genesis lock before
   releasing the global lock and retains the account lock through credential
   replacement, device/MK persistence, and admission.

Pinned r10 ruling record (2026-07-22; binding):

Where this record strengthens first-artifact publication, response validation,
the pairing handoff race, offer reselection, or completion-intent fallback in an
earlier pinned line, the r10 ruling controls.

1. HIGH ACCEPT — repaired-legacy `quarantine-resume.json` is a first pending
   artifact and uses the same global-lock choreography: acquire global, perform
   a fresh revalidating scan, acquire account, publish under both, then release
   global; the pairing final-empty-scan race is covered equivalently.
2. HIGH ACCEPT — pairing strictly validates and containment-checks the redeem
   response's `accountId` before any lock naming. Fresh-target locks live only
   in a dedicated lock namespace and never materialize a keystore tree;
   malformed responses mutate no filesystem state outside that namespace.
3. MEDIUM ACCEPT — the invalid post-redeem journal-publisher race is replaced
   by a valid first-marker publisher queued on global, which acquires global
   after the handoff and then blocks on pairing's held target-account lock
   through all remaining pairing writes.
4. HIGH ACCEPT — design 180's reselection controls the seam: design 179's
   once-only genesis offer binds to journal resolution, not prompt claim. An
   `outcome:"claimed"` record cannot suppress re-presentation in the same active
   enrollment episode while no completion intent has been satisfied.
5. HIGH ACCEPT — after explicit interactive consent, a pre-receipt Keychain
   failure may RETARGET to plaintext only by durably replacing the Keychain
   completion intent with the exact file intent, using write-new-then-supersede
   under the hardened writer contract before any fallback commitment attempt.

Pinned r11 ruling record (2026-07-22; binding):

Where this record corrects the r10 RETARGET supersession boundary, the r11
reconciliation ruling controls.

1. HIGH ACCEPT — RETARGET has no old-before/new-after durability binary. The
   invocation in which replacement durability fails performs no fallback
   write. On locked resume, the flow reloads the canonical intent record and
   accepts only either the exact old Keychain intent or the exact new file
   intent, completes exact read-back, published-file fsync, and parent-directory
   fsync for whichever one it found before proceeding, and fails closed on
   every other state. Stage-specific reconciliation tests cover crashes after
   rename, after read-back, after file fsync, and after directory fsync.

Pinned r12 ruling record (2026-07-22; binding):

Where this record strengthens r11's RETARGET provenance and corrects any
earlier mismatch-reselection wording, the r12 rulings control.

1. HIGH ACCEPT — before replacing the canonical completion intent, RETARGET
   durably publishes a full-hardened-writer transition witness that binds the
   exact old and new intents and both digests. Locked resume reads that witness
   first, accepts only its exact two values, completes durability for whichever
   canonical value survives, fails closed on every other state, and retires the
   witness only after the survivor is fully durable. The four stage-specific
   crash tests include the witness-present and witness-absent boundaries.
2. MEDIUM ACCEPT-MODIFIED — absence is the only reselection case. Any present
   completion intent that is structurally invalid or has a version, account,
   digest, shape, or target mismatch is preserved integrity evidence and fails
   closed, consistent with the journal failure contract and pending-artifact
   gate. A valid RETARGET witness authorizes reconciliation only between its
   exact two bound values; it does not turn any other value into absence.

Pinned r14 post-field-validation amendments (2026-07-22; binding):

1. ACCEPT — a hardened, byte-bound local enrollment witness removes the
   per-invocation server observation for unchanged enrolled device/MK material;
   every pending artifact, malformed witness, byte mismatch, or account mismatch
   falls back to authenticated consultation.
2. ACCEPT — exact pre-180 404 and AccountKeysDTO response shapes raise a
   dedicated terminal rollout error, while every genuinely malformed response
   retains strict corruption handling and no legacy bootstrap mode exists.
3. ACCEPT — the design-180 server vocabulary deploys and is verified before any
   client that depends on it is released or fleet-installed.

Owner: Claude (founder-directed, 2026-07-21)

Origin: design 179 review rounds 3–5. Round 3 found the lost-bootstrap-response
classification defect; rounds 4–5 established that publication atomicity,
restart replay, enrollment classification, and orphan repair are a pre-existing
genesis subsystem rather than macOS Keychain behavior. Round 1 of this design
then pinned the platform-independent RK foothold, exhaustive wire observation,
old-client transition, and executable repair protocol.

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
  (`src/cli/e2ee-client.ts:92`); and
- direct genesis, device-code login, setup, bare-rbox routing, and init's auth
  planning use DTO or local-device presence as enrollment answers, so a
  pre-persisted `device.json` can bypass the server classifier entirely.

There is a second no-loss defect. RK is independently random and the recovery
phrase is returned only in memory. A crash after local keys or server genesis
are published can resume the exact request only if it also retains a
phrase-recoverable RK. An exact request journal without RK preserves server
idempotency but can permanently lose the only recovery phrase.

Consequently, **a crash during any bootstrap today can leave the account
permanently unusable or enrolled without a recoverable phrase**. This design
repairs genesis for every platform and enrollment surface.

## Goals

1. Publish the account claim, roster v0, key-state epoch 0, and first device as
   one all-or-nothing server transaction.
2. Before any POST, durably preserve device/MK material, phrase-recoverable RK,
   and the exact serialized request so a restart loses neither ownership nor
   the recovery phrase.
3. Make a pre-publication or ambiguous-response restart resume the exact same
   attempt; never regenerate randomized wraps while the prior request can win.
4. Classify enrollment once, cryptographically, from an exhaustive server
   observation, and make every entry/routing shortcut consume that result.
5. Make exact replay safe for both upgraded and transition-era clients by
   recognizing exact opaque-field idempotency on the server.
6. Diagnose only the exact legacy orphan as repairable, and provide a fully
   fenced, authenticated, permanently audited operator repair.
7. Ship the server correction, wire observation, old-client protection, and
   repair capability before any client depends on them.

## Non-goals

- macOS Keychain mechanics, recovery-kit offers, artifact-target selection,
  plaintext-kit cleanup, and locator verification remain design 179. This
  design owns the generic temporary staged-RK foothold and completion hold that
  design 179 consumes.
- This is not a general repair mechanism for malformed claims, child-only
  state, non-empty partial state, forked history, or cryptographically invalid
  account history. Those remain fatal integrity incidents requiring manual
  investigation.
- This does not enumerate Durable Objects or repair pre-existing claim-less DO
  history. Any authoritative workspace-registry ownership refuses repair, and
  suspected claim-less DO history is an integrity incident for manual
  escalation.
- The server remains a zero-knowledge opaque store. It may compare stored and
  submitted strings byte-for-byte, bound shapes, count rows, and transact them;
  it does not parse or cryptographically verify signed envelopes.
- This does not change ordinary pairing/recovery cryptographic admission or
  define a new way to recover RK/MK. Pairing requires machine-global pending-
  state arbitration before opaque-token redemption and a global-to-target-
  account lock handoff afterward; recovery uses account-scoped arbitration once
  its account is known.
- This design does not build a cross-plane fence for future sharding. N>1 is
  blocked until one exists.

## Invariants

1. **Server all-or-none co-presence:** every new atomic publication, and every
   account after successful repair bootstrap, exposes either no genesis rows or
   the co-present four-row genesis set: claim, roster v0, key-state epoch 0, and
   first device. Between operator repair and that bootstrap, the sole legal
   intermediate is the exact tombstone claim with zero children. The server
   makes no cryptographic mutual-consistency claim about opaque envelopes.
2. **Client cryptographic mutual consistency:** only the shared client
   classifier may call a co-present set enrolled, after verifying signed chains
   and binding every fetched recovery/device field to those chains.
3. **RK before publication:** every bootstrap has a durably readable,
   phrase-recoverable staged RK before journal publication and before POST.
4. **One attempt across ambiguity:** after durable journal publication, every
   retry sends the exact persisted UTF-8 request bytes until verified
   classification reaches a terminal result.
5. **Completion is local and explicit:** server commit is not completion. The
   staged-RK hold releases only after successful phrase delivery or verified
   durable artifact commitment; cleanup and journal retirement follow that
   durable release record.
6. **Compare, do not assume:** `200`, `409`, a lost response, or a non-null DTO
   is not client proof that an attempt won. Only verified fetch plus exact
   field comparison establishes `committed-this-attempt`.
7. **One classifier and gate, no shortcuts:** no enrollment entry, direct
   pairing/recovery entry, front door, export path, or E2EE-loading boundary
   independently interprets raw DTO presence, `hasDevice`, or a local account
   id while pending genesis state or an unreleased completion hold exists.
8. **Repair is narrower than detection:** only the precise old split-publication
   orphan with no authoritative workspace-registry ownership is automatically
   repairable. Any malformed claim, dependent row, workspace, or ambiguous
   state is refused.
9. **No pristine repair gap:** repair replaces the orphan claim with a durable
   tombstone claim in one conditional update. A tombstoned account is never
   observable as pristine by any client, capable or not, and cannot publish key
   children, E2EE-bearing pairing tokens, workspaces, or workspace-sync commits.
   Only capable bootstrap may atomically replace the exact tombstone with the
   real four-row genesis set.
10. **N=1 prerequisite and sharding blocker:** `dbFor` and `dirDb` must resolve
    to the identical D1 database so pairing-token proof, tombstone installation,
    claim replacement, and pairing fencing share one transactionally ordered store. Any
    N>1 rollout is blocked until a reviewed mirrored or cross-plane fence
    replaces this assumption.
11. **Transaction-bound reconciliation fence:** every operation that can
    replace, alter, or delete a tombstone or its claim first reconciles every
    `attempted` repair-audit row for that account, then repeats a `NOT EXISTS`
    predicate for such rows inside every guarded mutating statement. A guard
    refusal runs reconciliation and retries the mutation; the preflight alone
    is never sufficient. This applies to every ordinary- and repair-bootstrap
    statement, repair execute, the hard purge's `account_keys` deletion at the
    actual `finishD1` boundary, and every future cancel, re-repair, or other
    tombstone/claim mutator, so no interleaving can destroy the evidence needed
    to finish an attempted audit.
12. **No post-erasure account-linked resurrection:** every statement in an
    account-linked mutation batch transactionally requires no `purging`/`done`
    account deletion ledger. This includes execute and dry-run audit INSERTs,
    all four ordinary-bootstrap statements, all four repair-bootstrap
    statements, and all three workspace-creation statements: ownership INSERT,
    fair-use upsert, and creation-audit INSERT. Once erasure owns the account, a
    blocked endpoint returns `account_erased` and cannot recreate an account-
    linked row. An absent ledger
    and non-erasure states such as `pending` pass; in particular, an absent
    ledger does not turn a live legacy account with absent `account_keys` into
    an erasure refusal.
13. **Global pairing arbitration:** because an opaque pairing token does not
    reveal its target until the consuming redemption response, pairing never
    claims account-scoped pre-redemption arbitration. Before any redemption it
    enumerates every local account directory, including stale ones, and resolves
    each active genesis pending state through the shared classifier. Any
    pending artifact that remains active blocks all pairing redemption on that
    machine with the stable resume instruction. The first pending-artifact
    publication, including the prepublish marker, shares the global lock.
    Pairing holds the global lock through redemption, then hands off without an
    unlocked gap to the target-account lock and holds that lock through every
    local and admission mutation.

## Design

### 1. Durable prepublication bundle and exact-attempt journal

Genesis is a resumable, account-scoped protocol under the existing genesis
lock. A transition from no pending state to its first pending-artifact
publication additionally uses section 4's global-to-account acquisition order;
it never acquires the global lock while holding the account lock. The protocol
uses these local artifacts beside the account keystore:

- `genesis-prepublish.json`: a non-secret strict marker proving generation was
  in progress but no request was yet eligible to POST;
- `rk.key.staged`: the phrase-recoverable encoded RK, mode 600, never phrase
  text;
- `genesis-attempt.json`: the exact request plus the completion-hold record;
- `genesis-completion-intent.json`: the selected completion mode and exact
  target, created only after server commitment is classified; and
- `genesis-completion-intent.retarget.json`: a transient, durable RETARGET
  transition witness binding the exact old and new intents, present only across
  the one legal pre-receipt Keychain-to-file replacement.

The authenticated `accountId` and `deviceId` already exist before key
generation. The client first classifies the server as pristine, then durably
publishes the prepublish marker using those ids, generates secret key/RK/wrap
material once, and persists in this exact order: `device.json`, `mk.key`,
`rk.key.staged`, then the complete journal. **No code path can POST until all
four exact read-backs succeed.** The
staged RK is authenticated against the just-generated recovery envelope and
must round-trip through the canonical RK-to-phrase encoding before the journal
is eligible to publish.

The strict v1 marker is:

```jsonc
{
  "version": 1,
  "accountId": "acct_0123456789abcdef",
  "deviceId": "dev_…",
  "repairId": null,
  "startedAt": "2026-07-21T16:28:00.000Z",
  "phase": "prepublish"
}
```

`repairId` is exactly null for an ordinary prepublication bundle and the exact
tombstone id for a repair bundle. This binds a marker-only crash to the server
state it is allowed to clean and regenerate against.

The strict v1 journal is:

```jsonc
{
  "version": 1,
  "accountId": "acct_0123456789abcdef",
  "deviceId": "dev_…",
  "startedAt": "2026-07-21T16:28:00.000Z",
  "phase": "active",
  "requestBody": "{the exact UTF-8 JSON string sent to /v1/keys/bootstrap}",
  "requestSha256": "64 lowercase hex over the exact requestBody UTF-8 bytes",
  "originalCacheRecovery": false,
  "completionHolds": ["recovery-kit-staging"],
  "completionReceipts": {}
}
```

Every bootstrap, interactive or not and on every platform, registers exactly
the one `recovery-kit-staging` hold. `completionHolds` is a strict,
duplicate-free, immutable set after the first POST.
`requestSha256` is the journal attempt identity and must equal SHA-256 over the
exact persisted `requestBody` bytes on every load. `originalCacheRecovery` is
the caller's explicit pre-staging preference
(omitted input normalizes to false), captured before any platform-specific save
or cache behavior. Its only v1 receipt is:

```jsonc
{
  "recovery-kit-staging": {
    "outcome": "phrase-delivered | artifact-committed | competing-cleaned",
    "at": "2026-07-21T16:30:00.000Z"
  }
}
```

For a committed attempt, `phrase-delivered` is written only after the output
sink successfully accepts the complete canonical phrase; a partial/failed
write does not release the hold. `artifact-committed` is written only after the
artifact is exactly read back and its locator is durably committed under
design 179. For `competing-genesis`, verified classification authorizes
conservative abandoned-attempt cleanup, but the client first durably records
`competing-cleaned`; that receipt is the authorization for every later
destructive step, and the losing phrase is never delivered as the account's
recovery phrase. Receipt mutation uses the same durable rewrite contract and
is monotone. Writing the first receipt atomically advances `phase` from
`active` to terminal `cleanup`. On the winning/ordinary path only, cleanup may
atomically promote `rk.key.staged` to the user-requested durable `rk.key`
cache. Before journal retirement it must read back and validate the exact
destination `rk.key` bytes against the staged RK expected by the journal; if
the source is absent, only that exact valid destination proves promotion
finished. A promotion-intent cleanup journal for which both the source and a
valid destination are absent is `integrity-failure`, never silent success.
`competing-cleaned` is excluded from promotion regardless of
`originalCacheRecovery`: it always archives all three losing enrollment
artifacts—`rk.key.staged`, `device.json`, and `mk.key`—through one invocation of
the shared local-quarantine primitive in section 3, keyed by the journal's
`requestSha256`, and never bare-unlinks any of them. Its one manifest lists all
three exact files, and the durable receipt authorizes their hash-checked moves
before any source is removed. The journal and completion intent cannot retire
until that manifest's `completed.json` is durably published and validated; at
that point no losing local device/MK pair remains capable of satisfying
`hasDevice` or any enrollment shortcut. On the winning path, the applicable RK
promotion/removal must instead validate before journal retirement. Other
already-removed cleanup artifacts remain legal only where the applicable
receipt and completed manifest authorize them. Thus crashes after
commit, after response, during phrase display, after authorization, during
artifact commitment, or during cleanup retain an unambiguous next action.

Before attempting any completion action, the resume handler durably writes the
strict, account-bound `genesis-completion-intent.json` beside the journal using
the same hardened publication contract:

```ts
type CompletionIntent =
  | {
      version: 1;
      accountId: string;
      requestSha256: string;
      mode: "phrase-display";
      intentAt: string;
    }
  | {
      version: 1;
      accountId: string;
      requestSha256: string;
      mode: "keychain";
      keychain: {
        service: "rbox recovery phrase";
        account: string;
        keychainPath: string;
      };
      intentAt: string;
    }
  | {
      version: 1;
      accountId: string;
      requestSha256: string;
      mode: "kit-path";
      path: string; // resolved absolute path
      intentAt: string;
    };
```

The object is an exact tagged shape. `version` is exactly 1, `accountId` must
equal the active journal's account, and `requestSha256` must equal both the
journal field and a fresh digest of its exact `requestBody`. `phrase-display` has neither target,
`keychain` has only the already resolved and validated identity, and `kit-path`
has only the resolved absolute selected path. The client resolves a relative or
otherwise user-selected kit path to that absolute path at selection time,
before intent publication; no restart resolves it again against a potentially
different working directory. A valid intent makes every authorized restart
resume that exact selection under design 179's rules, except for the one legal
pre-receipt Keychain-to-file RETARGET below. **Absence is the only reselection
case:** if no completion-intent record and no RETARGET witness exists because
the process crashed before selection was durably recorded, the handler
deterministically and visibly re-presents the completion options,
reconstructing the same canonical phrase from `rk.key.staged`; it does not
claim to resume the user's original unknown selection. Any present intent with
an invalid version, account, request digest, tagged shape, or target—including
malformed, torn, or otherwise structurally invalid bytes—is
`integrity-failure`; it is preserved as evidence and never replaced through
reselection. A valid RETARGET witness is the sole exception to single-value
resume and authorizes only the exact two-value reconciliation below, never
reselection around an invalid record. Design 179's
`kit.json.offer.outcome:"claimed"` is not a completion intent and cannot
suppress that re-presentation while this exact journal remains active with both
the completion-intent record and RETARGET witness absent; the resumed UI
continues the same enrollment episode rather than issuing a second once-only
offer. The intent is removed
durably only during receipt-authorized cleanup and before journal retirement.
A structurally valid intent is data, not completion authority: phrase display,
Keychain add, or kit-path output remains forbidden unless the current shared
classification is `committed-this-attempt` for that exact journal.

The transition witness is a strict, bounded record published beside the
canonical intent under the same full hardened writer contract:

```ts
type CompletionIntentRetargetWitness = {
  version: 1;
  accountId: string;
  requestSha256: string;
  oldIntent: CompletionIntent;
  oldIntentSha256: string;
  newIntent: CompletionIntent;
  newIntentSha256: string;
  witnessedAt: string;
};
```

Both embedded intents must be exact tagged `CompletionIntent` values for the
same active account and request digest. `oldIntent` must be the exact current
Keychain intent and `newIntent` the exact proposed resolved-absolute-path
intent. Each SHA-256 is over the exact bounded UTF-8 bytes produced for its
embedded value by the same deterministic serializer used for the canonical
intent; before witness publication, the old digest must also match the exact
canonical bytes read back from disk, and the new digest must match the exact
bytes staged for canonical replacement. Unknown or extra fields, duplicate
keys, invalid timestamps or digests, a non-Keychain old value, a non-kit-path
new value, equal old/new values, or any identity/target mismatch fails closed.

There is one narrowly legal intent replacement. If an interactive Keychain
attempt fails before any completion receipt and the user then explicitly
consents to the offered plaintext fallback, the resume handler resolves the
exact absolute fallback path and performs a pre-receipt **RETARGET** while
holding the account genesis lock. It revalidates that the canonical current
intent is the exact account/request-bound `keychain` intent and that the journal
is still active and receipt-free, with current shared classification still
`committed-this-attempt`. It first durably publishes
`genesis-completion-intent.retarget.json`, including exact read-back,
published-file fsync, and parent-directory fsync. Only after that full contract
succeeds may the hardened replacement writer create the
complete new `kit-path` record in an exclusive same-directory temporary file,
write and fsync it, close it, then atomically rename it over the canonical
intent; exact published read-back, published-file fsync, and parent-directory
fsync complete the supersession. Rename can expose the new record before those
post-rename durability steps finish, so there is no old-before/new-after
supersession binary. Any failure in the invocation performing RETARGET performs
no fallback write, including a failure after rename.

On the next locked resume, the handler revalidates the active receipt-free
journal and `committed-this-attempt` classification, then strictly loads the
RETARGET witness before interpreting the canonical intent. If the witness is
present, it must satisfy the schema, identity, exact-value, and digest checks
above; the handler then accepts only one of its two exact tagged values as the
canonical record. For whichever exact value is canonical, it idempotently
completes the post-publication durability suffix—exact read-back,
published-file fsync, and parent-directory fsync—even when the crash stage is
unknown or a step may already have completed. It then retires the witness by
durable unlink plus parent-directory fsync; retirement is forbidden until the
surviving canonical intent has completed the full durability suffix. An absent
canonical record while a witness exists, a malformed/torn/identity- or digest-
mismatched witness, or a canonical record that is malformed, mismatched, or not
one of the witness's exact two values is `integrity-failure` and preserves all
evidence. If the exact old Keychain intent survives, the flow retains that
Keychain target and writes no fallback file. If the exact new file intent
survives, fallback commitment may begin only after its durability suffix and
witness retirement complete. With no witness, an exact valid canonical intent
resumes normally; an absent canonical intent permits visible reselection, and
any present invalid intent fails closed. Keychain-to-file is the only retarget;
after any completion receipt, retargeting is forbidden and receipt-authorized
cleanup remains monotone.

`requestBody` contains every exact opaque transport string: `recoveryWrap`,
`recoveryWrapId`, `genesisRoster`, `genesisKeyState`, and all four `device`
fields, plus the exact `repairId` for a tombstone replacement and no such key
for ordinary bootstrap. It preserves randomized recovery/MK-wrap ciphertexts. It is bounded by
`KEY_BOOTSTRAP_MAX_BYTES`, strictly parsed against the bootstrap schema on
read, account/device-bound, mode 600, never logged, and replayed as identical
UTF-8 bytes rather than parse-and-reserialize output.

#### Hardened local durability contract and failure model

`writeSecret` and the shared JSON writer use same-directory exclusive temporary
files created mode 600, complete bounded writes, temporary-file fsync, close,
atomic rename, exact read-back, published-file fsync, and parent-directory
fsync. Fresh ancestors are created one component at a time with restrictive
mode and each child/parent directory publication fsynced before use.
Replacement never truncates the live target in place. Durable unlink/rename is
complete only after parent-directory fsync. This contract applies identically
to `device.json`, `mk.key`, `rk.key.staged`, all four genesis JSON files, and
design 179's locator records, plus the quarantine directory chain,
`quarantine-resume.json`, and `completed.json`.

The guaranteed failure model is process-crash safety on every supported
platform and power-loss/kernel-crash safety on Linux through file and directory
fsync. macOS uses ordinary fsync; a power loss can therefore still lose a
recently reported publication. `F_FULLFSYNC` through a native call is optional
future hardening, not a requirement for this seconds-long enrollment window.
Path-component and target checks use `lstat` and no-follow opens where
available. They are best-effort no-symlink defenses, not race-resistant path
resolution, so a same-user attacker able to mutate the keystore concurrently
remains a documented residual risk.

Any durability or exact-read-back failure prevents journal eligibility and
POST. Any read, parse, identity, local-key, staged-RK, or durability failure
with a journal present fails closed, preserves every artifact, and never starts
a second attempt.

A marker without a journal is `restart-prepublication`, not enrolled: by
construction no POST was eligible. Only after the exhaustive server
observation is pristine may the client durably discard that unattached partial
generation and create a new bundle. That cleanup removes every staged secret
and local key first and removes the marker last; a crash resumes from the still
present marker. A journal without its marker is valid only when all other
active-phase journal, local-key, and staged-RK checks pass; the marker can be
recreated. In active phase, unmarked partial local material or a missing staged
RK is `integrity-failure`, except for the tombstoned exact repaired-legacy shape
in section 3. In cleanup phase only the receipt-specific absences defined
above are legal; promotion still requires its source or exact valid
destination, and competing cleanup requires the completed three-artifact
quarantine.

#### Seam with design 179

This design solely owns `rk.key.staged`, the completion-intent record, and its
RETARGET witness: their creation, durability, validation, completion hold,
phase transitions, and cleanup. Design 179's non-interactive
macOS path reuses this exact artifact and does not create a second staging
record or temporarily overload `rk.key`. Its cache-preference restoration,
Keychain or explicit-file save, exact artifact verification, and durable
commitment-locator reconciliation layer on top of the same artifact. A verified
locator permits design 179 to request `artifact-committed`; design 180 writes
the receipt, enters `cleanup`, and then either promotes `rk.key.staged` to
`rk.key` when the original cache preference requires it and exact destination
bytes validate, or removes it on the ordinary cache-false path. A
`competing-cleaned` attempt instead quarantines `rk.key.staged`,
`device.json`, and `mk.key` together and never promotes or bare-unlinks any of
them.
All crash migration and recovery decisions are defined solely by design 180's
journal phases; `kit.json` does not carry an independent genesis-staging axis.
For a genesis touchpoint, design 179's local offer claim is provisional until
this journal resolves a completion intent. While the same journal is active and
both the completion-intent record and RETARGET witness are absent,
`outcome:"claimed"` does not suppress the resume handler's deterministic
visible re-presentation. A present invalid record fails closed instead.

### 2. Exhaustive account wire contract

`GET /v1/keys/account` must expose child presence even when `account_keys` is
absent. Counts are non-negative safe integers computed from the same N=1 D1
database and cover the implementation-reviewed dependent inventory:

```ts
interface GenesisPresence {
  rosters: number;
  keyStates: number;
  devices: number;
  workspaces: number;
  workspaceKeys: number;
  e2eePairingTokens: number;
}

interface GenesisRepairTombstone {
  version: 1;
  repairId: string;
  repairedAt: number;
}
```

The v1 inventory is exactly `rosters`, `account_key_states`, `device_keys`,
authoritative workspace-registry rows owned by the account (`workspaces`),
`workspace_keys`, and E2EE-bearing `pairing_tokens` (`mk_wrap IS NOT NULL OR
admission_grant IS NOT NULL`, regardless of expiry/consumption). These are the
current genesis/key-child and authoritative ownership surfaces. There is no
catch-all bucket:
adding another such table requires a wire-version/design update that names its
count explicitly and adds the identical account predicate to the dry-run
classifier and execute conditional update before that table can ship.

The endpoint obtains the claim and every presence count in one SQL statement.
Its single account-row observation is therefore atomically exactly one of
absent, real claim, or repair tombstone; repair never creates a claim-absent
window. A tombstone is the fence and the capable client's repair witness. The
audit table is not joined and audit outcome is not consulted to interpret it.

Capable clients continue to send exactly `x-rbox-genesis-capability: 1` on this
GET and on bootstrap POST. GET does not hide a tombstone from an incapable
client: every client receives the same non-null 200 claim observation. An old
client therefore never takes its `account === null` bootstrap branch, but its
observable behavior is call-site-specific. Genesis preflights test presence
only and report their existing non-error `already-setup` result without parsing the DTO.
Setup treats the non-null claim as existing and offers pairing/recovery; those
flows then fail at `verifyDto` before any following local write. Direct crypto
consumers likewise reject the empty chains at verification. Admission retry
may perform its pre-existing save before this GET, but the tombstone response
causes no additional save; partial-keystore healing and sync pinning also fail
before their following local writes.

The load-bearing transition invariant is narrower and stronger: **no old-
client path writes or deletes local keys because it observed a tombstone**.
The sole local-key deletion branch requires the literal 409
`already_bootstrapped`; every tombstone-blocked POST returns 423 instead. Thus
old-client copy varies honestly by call site, while the legacy
`device.json`/`mk.key` pair remains byte-for-byte untouched. Section 5's POST
capability validation is defense in depth.

When the claim is absent the endpoint returns this exact 404 body, rather than
a content-free `not_found`:

```jsonc
{
  "error": "not_found",
  "genesisPresenceVersion": 1,
  "present": {
    "rosters": 0,
    "keyStates": 0,
    "devices": 0,
    "workspaces": 0,
    "workspaceKeys": 0,
    "e2eePairingTokens": 0
  }
}
```

When the claim exists, the 200 `AccountKeysDTO` adds `claimCreatedAt`, nullable
`genesisDeviceId`, and the same `present` object. The marker is null for rows
created before this migration and non-null for every new atomic bootstrap:

```jsonc
{
  "genesisPresenceVersion": 1,
  "recoveryWrap": "opaque wrap",
  "recoveryWrapId": "opaque id",
  "claimCreatedAt": 1784651280000,
  "genesisDeviceId": "dev_…",
  "rosters": ["opaque signed roster JSON"],
  "keyStates": ["opaque signed key-state JSON"],
  "devices": [
    {
      "deviceId": "dev_…",
      "sigPubkey": "…",
      "encPubkey": "…",
      "mkWrap": "opaque wrap"
    }
  ],
  "present": {
    "rosters": 1,
    "keyStates": 1,
    "devices": 1,
    "workspaces": 0,
    "workspaceKeys": 0,
    "e2eePairingTokens": 0
  },
  "repairTombstone": null
}
```

The exact tombstone 200 body preserves the old DTO's non-null claim shape while
making the new state unambiguous:

```jsonc
{
  "genesisPresenceVersion": 1,
  "recoveryWrap": "rbox:genesis-repair-tombstone:v1",
  "recoveryWrapId": "rbox:genesis-repair-tombstone:v1",
  "claimCreatedAt": 1784651280000,
  "genesisDeviceId": null,
  "rosters": [],
  "keyStates": [],
  "devices": [],
  "present": {
    "rosters": 0,
    "keyStates": 0,
    "devices": 0,
    "workspaces": 0,
    "workspaceKeys": 0,
    "e2eePairingTokens": 0
  },
  "repairTombstone": {
    "version": 1,
    "repairId": "gra_…",
    "repairedAt": 1784651400000
  }
}
```

The database tombstone shape is exact: both opaque claim fields equal the
literal sentinel above; `genesis_device_id IS NULL`; `repair_id` is a strict,
bounded, filename-safe audit id; and `repaired_at` is a positive integer. Its
original positive `created_at` remains unchanged. A real claim has
`repair_id IS NULL`, `repaired_at IS NULL`, non-sentinel opaque fields, and the
ordinary DTO with `repairTombstone:null`. Any half-tombstone, sentinel collision,
malformed repair id/time, tombstone with a child count or nonzero `workspaces`
count, or real claim carrying repair metadata is `integrity-failure` and
remains fenced as a non-real claim.

Both 404 and 200 bodies require top-level `genesisPresenceVersion: 1`; every
200 also requires `repairTombstone: GenesisRepairTombstone | null`. The client
transport strictly parses the observation into
`{ genesisPresenceVersion: 1, claim: null, present } | {
genesisPresenceVersion: 1, claim: AccountKeysDTO, present,
repairTombstone }`; it no longer collapses every 404 to bare `null`. For a 200,
the roster/key-state/device array lengths must equal their corresponding
counts. Missing, malformed, negative, inconsistent, or unknown-version
presence data, or malformed/half-present tombstone fields, is
`integrity-failure`, never pristine. Any future account-scoped E2EE dependent
table updates the inventory, wire version/count, the dry-run classifier and
execute conditional-update predicate, CODEMAP
ownership where applicable, and tests in the same change.

An absent `genesisPresenceVersion` has one rollout-only distinction. The exact
legacy 404 body `{ "error": "not_found" }` and the exact pre-180
`AccountKeysDTO` key set (`recoveryWrap`, `recoveryWrapId`, `rosters`,
`keyStates`, and `devices`) raise a dedicated typed terminal error with the
verbatim message: "this rbox version requires the upgraded sync service; the
service upgrade is rolling out — retry shortly or use the previous rbox
version". Entry points surface it without retry or local mutation. Any other
missing-version, malformed, inconsistent, or unknown-version response retains
the ordinary strict malformed-response error. There is no dual-mode bootstrap
against a legacy server.

### 3. Shared verified enrollment classifier

`e2ee-client.ts` owns one pure-with-crypto classifier over the parsed account
observation plus strictly loaded marker/journal/local material. It is the only
component allowed to translate preflight state into enrollment state:

| Result | Required evidence | Caller behavior |
|---|---|---|
| `pristine` | Claim absent; every presence count zero; no journal, marker, staged RK, completion intent or RETARGET witness, active quarantine-resume state, or pending local device/MK. Completed quarantine archives are inert and ignored. | An ordinary new bundle may be generated. A tombstone is never pristine. |
| `restart-prepublication` | Either the same pristine server observation or the exact tombstone named by the partial repair bundle; valid marker/partial bundle exists; no journal. | Durably remove only that provably unposted generation, then start once against the same expected server state. |
| `resume-attempt` | Either claim-absent/all-zero ordinary state or the exact tombstone named by `repairId` in the request; exact valid journal, matching device/MK, and authenticated staged RK exist. | Replay only the exact request bytes; never regenerate. |
| `cleanup-resume` | A valid journal has a durable completion receipt and terminal `phase:"cleanup"`; artifacts may be absent only where that receipt's cleanup contract permits it, and promotion still requires either its source or exact valid destination. | Resume only the receipt-authorized cleanup idempotently, validate promotion/quarantine disposition, then retire the journal. |
| `committed-this-attempt` | Complete cryptographically mutually consistent account and every persisted payload field matches its fetched genesis row. | Treat ambiguity as success; satisfy the RK completion hold before cleanup/retirement. |
| `competing-genesis` | Complete cryptographically mutually consistent account, but at least one persisted field differs or journal device is absent. | Pending attempt lost; perform conservative abandoned-attempt cleanup and receipt. |
| `enrolled` | Complete cryptographically mutually consistent account and no pending genesis artifact exists. | Route to ordinary already-enrolled/pair/recover behavior. |
| `legacy-orphan` | Claim has the precise old-endpoint shape and every dependent count is zero. | Preserve everything and show the stable support error. |
| `repaired-legacy` | Exact all-zero tombstone; the only active local partial material is the exact unmarked old-flow `device.json` plus `mk.key`, with no journal, marker, staged RK, completion intent, RETARGET witness, or incomplete quarantine. | Start shared quarantine with purpose `repaired-legacy` and uniqueness key `repairId`, then enter `quarantine-resume`. |
| `quarantine-resume` | Exact all-zero tombstone; an incomplete shared-quarantine archive for its `repairId` has exactly one of the legal states below. | Execute only the manifest's hash-checked renames and completed-marker publication. |
| `repair-ready` | Exact all-zero tombstone; no active partial local material or incomplete quarantine exists. Any retained completed archive is ignored. | Generate one new bundle whose request names this exact `repairId`; bootstrap must replace this tombstone as expected previous. |
| `integrity-failure` | Child-only state; malformed real claim or tombstone; any workspace-bearing tombstone; any other incomplete shape; count mismatch; local-artifact failure; mismatched repair id; parse/crypto/account mismatch; or mutually inconsistent fetched fields. | Fatal refusal; preserve evidence and never auto-repair. |

`repair-ready`, `repaired-legacy`, and `quarantine-resume` require
`present.workspaces === 0` as part of their exact all-zero tombstone. A
tombstone with `present.workspaces > 0` is the anomalous workspace-bearing
state: it is `integrity-failure` immediately rather than a repair loop, while
the server-side workspace-sync fence remains defense in depth.

The precise old-endpoint claim shape is: `recoveryWrap` and `recoveryWrapId`
are nonempty bounded strings, `claimCreatedAt` is a positive integer,
`genesisDeviceId` is null (the old endpoint could not write it), and all
dependent presence counts are zero. A null/empty/oversized wrap or id, null or
nonpositive/non-integer timestamp, non-null genesis-device marker, or any
dependent row is `integrity-failure`, even if roster/key-state/device arrays
are empty.

For every non-orphan 200, “complete” requires all of the following before
either `enrolled`, `committed-this-attempt`, or `competing-genesis` is possible:

1. strictly parse all signed roster and key-state envelopes, run
   `verifyAccount`, and bind genesis/current roster account id to the
   authenticated account;
2. parse the recovery wrap, require its computed wrap hash to equal the DTO
   `recoveryWrapId`, the signed chain's authorized recovery-wrap id, and the
   current key state's `recoveryWrapId`;
3. strictly parse every device row, require non-null bounded id/public-key/wrap
   fields and unique device ids, and reject unknown extra/missing rows;
4. for every non-recovery roster principal, require exactly one device row,
   immutable public keys equal to its signed roster identity, and lifecycle
   presence consistent with the verified roster history (active and revoked
   rows remain represented; removed/never-authorized rows are rejected); and
5. compute each device `mkWrap` hash, require it to equal that principal's
   signed binding and pass `assertMkWrapAuthorized` against the verified
   account.

For new rows, `genesisDeviceId` must identify the unique first device bound by
roster v0. A null marker is accepted only as legacy compatibility for an
otherwise complete, mutually consistent pre-migration account; a non-null
mismatch is `integrity-failure`.

These checks apply equally with and without a journal. A valid signed chain
beside a substituted recovery wrap, missing device field, unauthorized wrap,
or extra device row is never called enrolled.

Exact-attempt comparison then compares the persisted request's
`recoveryWrap`, `recoveryWrapId`, roster-v0 string, key-state-0 string, and the
matching device's `deviceId`, `sigPubKey`, `encPubKey`, and `mkWrap` directly to
the fetched opaque strings. It does not reserialize signed objects or compare
only hashes.

`legacy-orphan` uses one stable safe user message and machine-readable error
code across every surface: the account's encryption setup is incomplete,
pairing/recovery cannot repair it, local recovery material was preserved, and
rbox support must run atomic-genesis repair before setup is retried.

#### Shared local-quarantine primitive

One account-scoped primitive under the genesis lock owns every destructive
genesis archival rename. It has exactly two users and deterministic uniqueness
keys:

- repaired-legacy archival uses purpose `repaired-legacy`, key `repairId`, and
  directory `quarantine/genesis-legacy-<repairId>/`; and
- competing/abandoned enrollment disposal uses purpose `abandoned-attempt`, key
  `requestSha256`, and directory
  `quarantine/genesis-attempt-<requestSha256>/`.

Each directory contains `quarantine-resume.json` and, only when terminal,
`completed.json`. The strict manifest is published before any source rename:

```jsonc
{
  "version": 1,
  "accountId": "acct_0123456789abcdef",
  "purpose": "repaired-legacy | abandoned-attempt",
  "uniquenessKey": "gra_… | 64 lowercase hex request digest",
  "createdAt": "2026-07-22T14:00:00.000Z",
  "entries": [
    { "source": "device.json", "destination": "device.json", "sha256": "64 lowercase hex" },
    { "source": "mk.key", "destination": "mk.key", "sha256": "64 lowercase hex" }
  ]
}
```

For `repaired-legacy`, `entries` is exactly the two rows shown, sources are
relative to the keystore root, and destinations are relative to its quarantine
directory. For `abandoned-attempt`, the one manifest contains exactly three
entries, in canonical order, whose source and destination names are
`rk.key.staged`, `device.json`, and `mk.key`. The staged-RK SHA-256 must equal
the RK authenticated by that journal; the device/MK hashes must equal the exact
local files already bound to the journal request and losing device identity.
The durable `competing-cleaned` receipt is authority to create this manifest,
but no source is removed before the manifest itself is durable. The manifest's
exact bytes are themselves hashed for the terminal marker:

```jsonc
{
  "version": 1,
  "accountId": "acct_0123456789abcdef",
  "purpose": "repaired-legacy | abandoned-attempt",
  "uniquenessKey": "gra_… | 64 lowercase hex request digest",
  "manifestSha256": "64 lowercase hex",
  "completedAt": "2026-07-22T14:00:01.000Z"
}
```

Publication order is normative: create the quarantine directory; publish
`quarantine-resume.json`; perform the hash-checked renames; then publish
`completed.json`. Every one of those directory, manifest, rename, and marker
operations uses the complete hardened local durability contract in section 1,
including ancestor publication, same-directory exclusive temporary files,
temporary-file fsync, atomic rename, exact read-back, published-file fsync, and
parent-directory fsync; the shorter ordering here does not weaken that
contract. A crash after directory publication but before the manifest
leaves removable debris only when the empty directory is the deterministic
directory for the operation's current uniqueness key. Resume removes that
empty directory durably and recreates it; classification never treats it as an
archive. A nonempty manifest-less directory, a directory for a different
incomplete key, or more than one path naming the same `(purpose,
uniquenessKey)` is `integrity-failure`.

For `repaired-legacy`, `quarantine-resume.json`—not its removable empty
directory—is the account's first pending artifact: there is no marker or journal
to arbitrate pairing before the manifest exists. A flow that classified
`repaired-legacy` while holding only the account lock must release that lock,
acquire the machine-global genesis-pairing arbitration lock, perform a fresh
revalidating all-account scan, then acquire the repaired account's genesis lock
in global-then-account order. After the account lock is held it re-fetches and
reclassifies the exact tombstone and local legacy pair. Only if both
revalidations still authorize the same `repairId` may it durably publish
`quarantine-resume.json` while holding both locks. It then releases global and
retains account through the hash-checked renames and terminal marker. A
competing pending state or changed repair shape stops publication and preserves
the legacy pair. Thus pairing's final empty scan cannot race this first
quarantine artifact any more than it can race a first prepublish marker.

Each entry has exactly one legal pre-completion state: the regular bounded
source exists with the manifest hash and destination is absent, so rename with
no replacement; or source is absent and the regular bounded destination exists
with the manifest hash, so that entry is done. After rename, both source and
destination directories are fsynced and the destination is read back and
hash-checked. Both present, both absent, wrong type, wrong identity, wrong hash,
unexpected names, or any other combination fails closed. Only after every
destination validates may `completed.json` be published under the same
hardened contract. Repair bootstrap is forbidden until that terminal
publication is durable; abandoned-attempt journal retirement is likewise
forbidden until its three-entry terminal publication is durable and validated.

A valid completed archive is permanently inert operator evidence: it is never
part of `pendingGenesisState`, never grants repair authority, and never affects
classification, whether the tombstone remains or has been replaced. The active
operation validates it before advancing; later classifiers ignore retained
completed archives. Thus post-consumption enrollment remains valid with both
the repair audit and completed local archive retained. Neither user ever
bare-unlinks secret source material.

### 4. No local-enrolled or completion-hold bypass

For every surface whose account is already known, one account-scoped
`pendingGenesisState` check runs before any `hasDevice`, `enrolledAccountId`,
auth-plan, or menu decision. A valid marker, journal, completion intent,
RETARGET witness, or quarantine-resume artifact routes through authenticated
fetch and the shared
classifier. An unreadable, malformed, identity-mismatched, or partially present
genesis artifact fails closed with a repairable-local-state diagnostic; it is
never ignored. Pairing is the exception only to the *scope* of this
pre-redemption check: its opaque token cannot identify the target account until
the consuming response, so pairing uses the machine-global arbitration below.

After a complete cryptographic `enrolled` classification validates the local
device against the roster and authenticates its MK wrap, the client publishes
`genesis-enrolled.json` beside `device.json` and `mk.key` through the full
hardened-writer contract. Its exact version-1 record contains `accountId`, SHA-256
hashes of the current raw bytes of both files, and `verifiedAt`. Consultation may
be skipped only when this strict bounded record parses, its account matches, its
two hashes match the current bytes, and marker, journal, staged RK, completion
intent, RETARGET witness, and active quarantine state are all absent. Any
failure consults the server. Key recovery, pairing replacement, local-material
quarantine, MK/device replacement, and credential account switch durably unlink
the witness before their mutation. The witness is a local routing cache only;
it is never repair authority or enrollment evidence for the server.

The following are mandatory consumers, not optional inner seams:

- direct `runGenesisEnrollment` and device-code post-approval in
  `src/cli/auth-cmd.ts`;
- setup's top-level `enrolledAccountId` skip gate and `resolveEnrollment`'s
  local-device early return in `src/cli/setup-cmd.ts`;
- bare `rbox` target/menu selection in `src/cli/front-door.ts`;
- `rbox init --bootstrap` planning before `auth="have"` can bypass login in
  `src/cli/init-plan.ts` / `src/cli/init-cmd.ts`;
- direct pairing-token redemption through `rbox connect` and every equivalent
  pair entry point, using machine-global pending-state arbitration and the
  global-to-target-account lock handoff; and
- direct `rbox key recover`, for both manual phrase recovery and design 179's
  macOS Keychain restore path.

With account-scoped pending state, the account-identifying surfaces acquire or
resume that account's genesis lock, load credentials, fetch the exhaustive
observation, and switch on the closed result set. None contain independent
`Boolean(dto)`, raw null/non-null, empty-array, `hasDevice`, or catch-and-assume
enrollment logic. Pairing and recovery retain their existing full verification,
but that verification is not a substitute for pending-state arbitration.

Before pairing redeems any token, it acquires the machine-global genesis-
pairing arbitration lock and enumerates **all** account directories below the
local E2EE root, including stale directories. The scan is independent of
whether credentials are absent, identify the eventual token target, or identify
a different account. For every discovered pending-artifact set it acquires the
corresponding account genesis lock in deterministic account-id order, strictly
reads every marker, journal, and related artifact, and invokes the shared
classifier's resume/cleanup decision. A terminal automatic cleanup may retire
the pending state and trigger a full rescan. If any pending state remains
active, needs interactive resume, cannot authenticate, or classifies as
nonterminal, competing, indeterminate, invalid, or integrity-failure, pairing
returns the stable instruction to resume setup for the identified local
account(s). It performs zero `/pair/redeem`,
credential replacement, device/MK persistence, admission, or other pairing
mutation. Multiple pending states are not an ambiguity to resolve by choosing
one; every pending artifact must durably retire before redemption is eligible.

Every transition that publishes the **first pending artifact** for a previously
clean account directory—including durable publication of
`genesis-prepublish.json` and repaired-legacy
`quarantine-resume.json`—coordinates with the same global arbitration lock.
Active-journal publication and final pending-artifact retirement retain that
coordination as well. When both locks are needed, the order is global
arbitration lock then account genesis lock. The publisher holds both through
durable publication of the first pending artifact; after the global lock is released, the
account lock continues to serialize the rest of that genesis operation. Thus a
marker or repaired-legacy manifest cannot appear after pairing's final empty
scan while pairing still owns the global critical section. A flow that already holds only the account lock
must leave it and re-enter global then account before any transition that needs
both; an already-durable pending artifact or the required fresh global scan and
post-account-lock revalidation closes that handoff, and no path inverts the lock
order.

Pairing holds the global lock through its final empty rescan and the consuming
`/pair/redeem` request. The response is the first authoritative identification
of the target account. Before deriving any path or lock name from that response,
pairing strictly parses the response and requires `accountId` to match the
canonical `^acct_[0-9a-f]{16}$` grammar. It rejects separators, dot components,
encoding tricks, extra fields, and every malformed response; constructs the
lock path only from the validated basename; and verifies that the normalized
result remains a direct child of the dedicated genesis-account lock namespace.
Canonical account genesis locks used by pairing and pending-artifact publishers
live in that namespace, outside every per-account keystore directory. Acquiring
a fresh target lock may create and durably publish only that lock namespace; it
never recursively creates the E2EE root or the target account's keystore tree.

Only after grammar and containment validation succeed, and while still holding
the global lock, pairing acquires that target account's genesis lock; only after
acquisition succeeds does it release the global lock. It retains the target-
account lock through credential
replacement, device and MK persistence, ordinary cryptographic verification,
the admission request, and admission persistence. This global-to-account
handoff has no unlocked interval: a first marker publisher cannot pass the
global lock before the handoff; after the handoff it may acquire global but
cannot pass the held target-account lock. Once both locks are acquired it must
freshly revalidate before deciding whether publication remains legal. This is
local arbitration only; it adds no token-resolution endpoint and makes no claim
about the token's target account before the consuming response. A malformed
response fails before target-lock naming and causes no filesystem mutation
outside the dedicated lock namespace.

Direct manual or Keychain recovery remains account-scoped. Once its account is
known, it acquires that account's genesis lock before phrase/Keychain restore,
credential replacement, device/MK persistence, or admission. If a journal is
active, the shared authenticated fetch/classifier first drives its exact resume
or cleanup path. Recovery may continue only after the journal is durably
retired; every conservative outcome routes to genesis resume or fails closed
with the journal and existing local material preserved.

The same pending-genesis check is enforced again at the common E2EE-loading
boundary used by `buildAuthedRemote` and keystore loading, not only by command
routing. While a valid journal has any completion hold without a durable
receipt, every command that would load or consume E2EE material refuses with a
stable instruction to resume setup and view-and-confirm the recovery phrase (or
finish the selected durable recovery-kit save). The command cannot sync,
publish, mutate, pair, recover, back up, or otherwise use the device/MK merely
because local keys and a server claim exist.

The explicit diagnostic allowlist is exactly `rbox status`, `rbox status
--json`, `rbox key status`, `rbox key status --json`, and local read-only `rbox
doctor`; doctor report upload and every other doctor mutation are excluded.
These surfaces may inspect enough state to report that genesis is pending and
show the same resume instruction, but may not release a hold, perform cleanup,
or construct an E2EE-mutating remote. Export's independent `hasDevice` shortcut
calls this same gate before loading keys.

The genesis-resume handler reached by setup is not a general command allowlist:
under the genesis lock, it is the sole writer allowed to re-present the phrase,
resume the exact durably selected design 179 artifact commitment, or visibly
reselect only when both the completion-intent record and RETARGET witness are
absent regardless of a provisional
design 179 `outcome:"claimed"`, perform the one legal pre-receipt RETARGET, and
then advance the journal. A
receipt-bearing `cleanup` journal takes the `cleanup-resume` path
instead of the unreleased-hold refusal and may perform only its already-
authorized cleanup.

### 5. Atomic, exact-field-idempotent server publication

`POST /v1/keys/bootstrap` strictly validates the existing opaque fields, the
authenticated first-device id, and one optional `repairId`. Ordinary bootstrap
requires `repairId` to be absent. Repair bootstrap requires it to be the exact
strict id exposed by the tombstone and persisted inside the journal's exact
`requestBody`.

`bootstrapAccountKeys` uses one `dbFor` handle and one D1 atomic
batch/transaction. Ordinary publication retains the same row payload:
conflict-raising claim insert with `genesis_device_id = submitted deviceId`,
then conflict-raising
roster-v0, key-state-0, and authenticated-device inserts. Each uses
`INSERT … SELECT`, never `INSERT OR IGNORE`, and success is exactly `1/1/1/1`.
Before the batch the handler reconciles attempted audits. Every one of the four
statements also carries `NOT EXISTS (SELECT 1 FROM genesis_repair_audit WHERE
account_id = :accountId AND outcome = 'attempted')` **and** `NOT EXISTS (SELECT
1 FROM account_deletions WHERE account_id = :accountId AND status IN
('purging','done'))`. Both predicates are inside each statement; neither an
application precheck nor a guard on only the claim insert is sufficient. If a
crashed execute or dry-run interleaves before the serialized batch, the guarded
vector is `0/0/0/0`: no claim or child is published, the handler reconciles, and
the exact ordinary request retries. If the deletion-ledger guard caused the
zero vector, the handler instead returns 410 `account_erased`; it does not retry,
run exact-field idempotency, or relabel the refusal as repair fencing. An absent
ledger or a ledger in `pending` passes this guard.

Repair publication uses a separate four-statement batch. Its complete
expected-previous predicate is: the claim is the exact tombstone named by
`repairId`; the roster, key-state, device-key, workspace-key, and E2EE-bearing
pairing-token inventories are all zero; and the authoritative workspace
registry has zero rows owned by the account. It also requires `NOT EXISTS`
any `genesis_repair_audit` row for the account whose `outcome='attempted'`, and
`NOT EXISTS` an `account_deletions` row for the account in `purging` or `done`.
**Every statement**—all three child inserts and the final claim update—carries
that complete predicate, including both `NOT EXISTS` guards, as well as the
capable-request check. Before entering the batch the handler reconciles
attempted rows; if the transaction-local guard still blocks because another
audit interleaved, it reconciles and retries the exact same journal request
rather than treating the preflight as sufficient. A deletion-ledger refusal is
terminal `account_erased`, never that retry path. Because later statements
observe exact children inserted earlier in the same sequential batch, their
SQL expresses the original all-zero condition by requiring the exact expected prefix of
batch-created children and excluding those exact rows from the zero-count
subqueries; every additional row in every inventory category still makes the
guard false. The final update requires all three exact batch-created children,
zero additional roster/key-state/device rows, zero workspace-key and E2EE-
bearing pairing-token rows, and zero authoritative workspace-registry rows.

In order, the batch conditionally inserts roster v0, key-state epoch 0, and the
authenticated device, then conditionally updates the exact tombstone row to the
submitted real claim, clears `repair_id`/`repaired_at`, and sets
`genesis_device_id`. Success is exactly `1/1/1/1`. D1 serializes the batch
without an interleaving observer, and any uniqueness/constraint failure aborts
and rolls back all four statements. A wrong, stale, or omitted repair id, a
child-bearing tombstone, or workspace ownership cannot replace the tombstone
or publish any child. Nor can an attempted audit be stranded by tombstone
replacement: the transaction that would destroy its evidence first sees the
`NOT EXISTS` guard. A repair executing between an ordinary client's GET and
POST turns its claim insert into a conflict; after rollback the handler
observes the tombstone and returns 423 without mutation.

For both publication branches, a transaction-local deletion-ledger refusal has
precedence over tombstone fencing, conflict/idempotency interpretation, and
attempted-audit retry. After the zero vector, the handler's read-only result
classification confirms `purging` or `done` and returns exactly:

```jsonc
{ "error": "account_erased" }
```

with status 410. This API-style envelope reuses the existing
`account_erased` discriminator; it does not copy the admin repair route's
`dryRun` field. No genesis row or other account-linked side effect exists. The
four statement-local guards, rather than the post-batch classification, enforce
that safety.

Every client that implements this design's journal and classifier, including
unversioned dev builds, sends exactly `x-rbox-genesis-capability: 1` on both
account GET and bootstrap POST. Capability is pinned to protocol behavior, not
package semver. A repair request that names a tombstone but has a missing,
duplicated, malformed, or non-`1` capability value receives status 428:

```jsonc
{
  "error": "genesis_capability_required",
  "requiredHeader": "x-rbox-genesis-capability",
  "requiredValue": "1"
}
```

It performs no mutation. This is capability-schema defense in depth, not a
repair-state response. Any bootstrap otherwise blocked because the current
claim is a tombstone returns the sole repair-fencing status, 423:

```jsonc
{ "error": "repair_in_progress" }
```

An old client normally stops on the non-null tombstone GET—either at a
presence-only `already-setup` result or at later chain verification—and never
POSTs. If any old path does POST, it receives 423 rather than its local-key-
deletion-triggering literal 409 `already_bootstrapped`. `x-rbox-version`
remains informational for support telemetry and has no authorization meaning.

If either atomic publication branch conflicts, the handler waits for rollback,
then performs the same one exact-field idempotency query. It returns `200` only
when the stored claim is real rather than a tombstone and the genesis device is
structurally identified by either (a)
`genesis_device_id = submitted deviceId`, or (b), for a pre-migration complete
row, null `genesis_device_id` plus claim/roster-v0/key-state-0/submitted-device
`created_at` equality and exactly one device in that timestamp cohort. The
stored claim's `recovery_wrap`/`recovery_wrap_id`, roster v0 `signed`, key-state
epoch 0 `signed`, and that identified genesis device's id/public keys/`mk_wrap`
must then equal all eight submitted fields byte-for-byte:

```jsonc
{ "ok": true, "idempotent": true }
```

Created timestamps in compatibility branch (b) identify the legacy four-row
cohort; they are not compared to client input. Later valid descendant rows do
not participate. The server is comparing opaque fields, not declaring them
cryptographically valid. Any absent, ambiguous, or unequal corresponding row
returns only:

```jsonc
{ "error": "already_bootstrapped" }
```

with status 409. An exact replay therefore protects an old client after a lost
successful response and protects a repair client after tombstone replacement;
the optional historical `repairId` grants no continuing authority and does not
change exact-field comparison. Genuine mismatch retains the existing conflict signal.
A bootstrap against an exact legacy orphan mismatches the absent children,
returns 409, and leaves every table byte-for-byte unchanged.

Pinned reviewer note — idempotency/TOCTOU: the exact-field idempotency query is
observation-only and runs only after the conflicting atomic insert batch has
fully rolled back. It grants no capability and mutates nothing; concurrent
change can only prevent an exact match and force 409. Repair is intentionally
stricter: no application-level proof authorizes a later mutation. Every repair
child insert and the final claim update repeat the exact tombstone id and the
complete all-zero/no-workspace expected-previous predicate inside the batch,
with only the exact earlier batch-created prefix excluded as described above;
a preflight read is never the decision. This is the reviewed boundary that
keeps both branches free of a proof/use gap.

Upgraded clients still fetch and run the shared classifier after `200`, `409`,
timeout, or socket close. `committed-this-attempt` is their only terminal
publication success. `resume-attempt` retries exact bytes within existing
bounds or on the next invocation. Fetch/classification failure retains all
local state.

### 6. Tombstone repair, scrub-on-purge audit, and mutation fence

A migration adds nullable `account_keys.genesis_device_id`, `repair_id`, and
`repaired_at`, plus the durable audit table. Old rows have null values for all
three; every new ordinary atomic bootstrap sets only the authenticated
`genesis_device_id`. The two repair columns represent the exact tombstone shape
from section 2 and are never client mutation authority once cleared.

```sql
ALTER TABLE account_keys ADD COLUMN genesis_device_id TEXT;
ALTER TABLE account_keys ADD COLUMN repair_id TEXT;
ALTER TABLE account_keys ADD COLUMN repaired_at INTEGER;
CREATE UNIQUE INDEX account_keys_repair_id_unique
  ON account_keys(repair_id) WHERE repair_id IS NOT NULL;

CREATE TABLE genesis_repair_audit (
  audit_id TEXT PRIMARY KEY,
  account_id TEXT,
  operator TEXT,
  reason TEXT,
  requested_at INTEGER NOT NULL,
  dry_run INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
  observed_classification TEXT,
  proof_json TEXT,
  original_claim_present INTEGER CHECK (original_claim_present IN (0, 1)),
  original_claim_snapshot BLOB,
  original_recovery_wrap BLOB,
  original_recovery_wrap_id BLOB,
  original_created_at INTEGER,
  original_genesis_device_id TEXT,
  outcome TEXT NOT NULL,
  result_vector TEXT,
  completion_observation_json TEXT,
  completed_at INTEGER,
  scrubbed_at INTEGER,
  scrubbed_evidence_sha256 TEXT
);
```

The audit row is never deleted when bootstrap replaces the tombstone. Before
hard purge it retains the full restricted operator evidence; at the hard-purge
boundary it is minimized under the scrub-on-purge contract below. Execute
audit rows preserve the
orphan claim's original `recovery_wrap` and `recovery_wrap_id` as exact SQLite
TEXT UTF-8 bytes cast to BLOB, plus the original timestamp and marker, before
replacement. `original_claim_snapshot` is a canonical length-prefixed encoding
computed inside statement 1 from row presence plus `typeof()` and raw value
bytes for every account-row claim field, including `repair_id` and
`repaired_at`; recomputing it is exact even for malformed rows and distinguishes
absence from an all-null projection. These fields are secret operator evidence: never returned by the
route, logged, or included in proof JSON. Proof JSON remains bounded redacted
row-shape/count facts.

Every account-linked statement in every non-bootstrap E2EE key mutation batch
(`device`, `admit`, `roster`, `keystate`, and `workspace`) conditionally
requires a real, non-tombstone claim and no `purging`/`done` deletion ledger in
that statement. E2EE-bearing pairing-token creation uses the identical claim
and deletion-ledger checks through
`dirDb`; the repair inventory still counts every pairing row
whose `mk_wrap IS NOT NULL OR admission_grant IS NOT NULL`, regardless of
expiry or consumption of the token itself. This is sound only under invariant
10's N=1 co-location. A tombstone guard failure writes nothing and returns 423
`{ "error": "repair_in_progress" }`; a deletion-ledger guard failure takes
precedence and returns 410 `{ "error": "account_erased" }`.

Workspace creation at the `authz.ts:89` / `routes/account.ts:37` path checks for
a `purging`/`done` deletion ledger and then a tombstone **first**, before quota
evaluation and before viewer authorization, so 410 `account_erased` has
precedence over 423 `repair_in_progress`, which has precedence over 402 and 403.
Those reads are response-order preflight only; the ensuing single transaction
contains the ownership `INSERT … SELECT`, fair-use upsert, and workspace-
creation audit `INSERT`. It replaces the current post-batch `audit` call: no
account-linked creation audit may execute separately after this batch. All
three statements independently guard on two exact predicates: **claim is not a
tombstone**, and the deletion ledger is not `purging` or `done`. Each statement
independently contains both `NOT EXISTS (SELECT 1 FROM account_keys WHERE account_id =
:accountId AND (recovery_wrap = :tombstoneSentinel OR recovery_wrap_id =
:tombstoneSentinel OR repair_id IS NOT NULL OR repaired_at IS NOT NULL))` and
`NOT EXISTS (SELECT 1 FROM account_deletions WHERE account_id = :accountId AND
status IN ('purging','done'))`. The claim predicate deliberately does not use
`EXISTS(real claim)`: either no `account_keys` row or a clean non-tombstone claim
proceeds, preserving the existing absent-claim behavior for live legacy
accounts. Likewise, an absent deletion ledger or a ledger in `pending` passes.
`genesis_device_id IS NULL` is not a tombstone-family discriminator because
legitimate legacy real claims also have a null marker.

An absent or clean non-tombstone claim with an allowed ledger produces the
ordinary `1/1/1` ownership/fair-use/audit vector. An exact or malformed
tombstone-family shape produces guarded `0/0/0`, returns 423
`repair_in_progress`, and suppresses every ownership, fair-use, creation-audit,
and DO side effect. A `purging` or
`done` ledger also produces `0/0/0` but takes precedence, returns 410
`{ "error": "account_erased" }`, and suppresses the same complete side-effect
set. Neither case can be relabeled as a generic missing-claim error. A preceding
application check, a guard on only one batch statement, or a separate audit
call is insufficient.

Workspace-sync retains its existing authorization lookup first. A legal
tombstone owns no workspace, so that lookup normally returns 404 before the
new fence is reachable. The tombstone check immediately before Durable Object
forwarding is defense in depth for the anomalous workspace-bearing tombstone
case: it returns 423 and performs no DO forwarding. The current authorization
lookup and current key-epoch query are not substitutes for that final check. A
truly absent claim continues to use ordinary non-repair behavior; no 409 is a
repair-fencing response.

Execute first reconciles attempted rows for the account, then uses exactly one
ordered two-statement D1 batch:

1. conditionally insert the permanent audit row as `outcome='attempted'` with
   `INSERT ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM account_deletions
   WHERE account_id = :accountId AND status IN ('purging','done'))`. This
   deletion-ledger predicate is inside the audit-insert statement itself, not
   an application precheck. When allowed, the statement copies the account
   row's original claim fields and canonical full snapshot with scalar
   subqueries at transaction time (nullable fields plus an explicit absent
   snapshot when no row exists), along with operator/reason, redacted preflight
   proof, and the newly allocated `auditId`; the one captured `requested_at`
   value is also the tombstone's `repairedAt`;
2. conditionally update that same account row from the exact legacy orphan to
   the exact tombstone sentinels, `repair_id = auditId`, and
   `repaired_at = repairedAt`. The statement requires that its own exact
   `auditId` row exists for `account_id = :accountId` with
   `outcome='attempted'`, so a deletion-ledger refusal of statement 1 forces
   `update=0`. In the same statement, `NOT EXISTS` must find no other audit for
   the account with `outcome='attempted'`; the batch's own newly inserted
   `auditId` is the sole explicit exclusion because it is the transaction-bound
   evidence for this very mutation.

Statement 2 repeats the complete authoritative proof and binds every original
claim field byte-for-byte to the values captured by statement 1:

- exactly one targeted real claim whose `recovery_wrap` and
  `recovery_wrap_id` are SQLite TEXT, 1–65536 UTF-8 bytes, whose `created_at` is
  an INTEGER > 0, and whose repair metadata is null;
- `genesis_device_id IS NULL`, because the old split endpoint could not write
  the new marker;
- zero roster, key-state, device-key, workspace-key, and E2EE-bearing
  pairing-token rows using exactly section 2's inventory predicate; and
- no workspace owned by the account in the authoritative workspace registry,
  independent of the `workspace_keys` count.

There are exactly three committed result vectors:

| Result vector | Meaning and required handling |
|---|---|
| `audit=1, update=1` | Repair committed. Complete the audit as `tombstone_claim_installed`, return success, and expose the tombstone on the next single-row account observation. |
| `audit=1, update=0` | Some transaction-time predicate failed. Complete the audit with `outcome='refused'`, the exact result vector, and a bounded post-hoc re-read snapshot explicitly labeled observational; return generic `repair_refused_state_changed` with the audit id and that observational snapshot. Nothing was deleted and no client authority was created. |
| `audit=0, update=0` | The account's deletion ledger was already `purging` or `done` when statement 1 ran. Return `account_erased` with no `auditId`; no repair-audit row, tombstone, or other account-linked row is created. |

No other committed vector exists: `audit=0, update=1` is excluded by statement
2's own-audit predicate, and an audit constraint or database error aborts the
atomic batch. There is no anomaly vector protocol and no compensating
mutation. For an audited vector, the route uses an idempotent completion update
to store its exact vector, final outcome, nullable
`completion_observation_json`, `completed_at`, and
`scrubbed_evidence_sha256`. The digest is SHA-256 over a canonical
length-prefixed encoding of every field that hard purge will null; normal
completion and reconciliation compute it from the stored row and publish it
atomically with the final outcome. For `audit=1, update=0`, the
completion snapshot is a bounded redacted re-read of claim shape, dependent
counts, and workspace ownership taken only after the batch. It is useful
operator context but is explicitly **observational, not transaction-bound
proof**: a concurrent mutation may occur before or after it, so neither the
audit nor wire response claims an exact refusal classification or decisive
transaction-time counts.

The route does not return the first `update=0` when a post-hoc observation says
the other expected-previous facts remain eligible. It first completes its own
no-op audit as `refused`, runs reconciliation even if the interleaving audit
already completed and the pass is now a no-op, and retries with a fresh audit
id. A bounded retry that still loses the transaction-local guard fails closed
as the generic refusal; it never drops
the guard or reuses an attempted row as authority. Future cancel/re-repair
mutators use the same reconcile-then-guard-then-retry discipline.

A crash may leave `outcome='attempted'`. Admin reads/dry-runs and account
tombstone reads opportunistically run the cheap account-scoped reconciler.
Reconciliation is split by the persisted `dry_run` flag:

- for `dry_run=0`, an exact tombstone whose `repair_id` equals the audit id
  proves `update=1`; otherwise the no-prior-claim-mutation fence proves the
  committed vector was `update=0`, which is completed only as generic
  `refused` with a fresh observational snapshot; and
- for `dry_run=1`, reconciliation never interprets claim state as an execute
  vector. It preserves the row's persisted classification/proof, sets
  `outcome='dry_run_incomplete'`, leaves `result_vector` null, and records
  `completed_at`. This is truthful for both eligible and ineligible dry-runs
  that crashed between attempted insertion and their normal completion; it
  grants no authority and asserts no mutation.

Dry-run audit creation uses the same transaction-local deletion-ledger
predicate inside its own `INSERT ... SELECT`: it may commit only `audit=1`, or
`audit=0` when an `account_deletions` row for the account is already `purging`
or `done`. The `audit=0` vector returns `account_erased` and creates no audit or
other account-linked row. Execute and dry-run may perform a read-only preflight,
but that observation never weakens or replaces their insertion predicate; if
`finishD1` wins after preflight and before insertion, the serialized insert
still sees the purging/done ledger and refuses without an `auditId`.

Every attempted row, including a dry-run, blocks a tombstone/claim mutator
until reconciled. Ordinary bootstrap, repair execute, repair bootstrap, hard
purge, and every future cancel/re-repair first reconcile, then repeat the
`NOT EXISTS (outcome='attempted')` test inside the mutating transaction. If it
loses that race, it reconciles and retries; no pre-transaction reconciliation is treated
as proof. Audit state is only this evidence-preservation interlock and never
grants bootstrap authority.

Account deletion is scheduled under design 37; the DELETE route does not
immediately remove the claim. The reconciliation point is the purge driver's
actual `finishD1` boundary. In that atomic finish batch,
`DELETE FROM account_keys …` carries the same `NOT EXISTS` attempted-audit
predicate. A zero change does not mark the deletion ledger `done`: the driver
reconciles and retries `finishD1`, closing the execute-versus-purge interleaving
without weakening the scheduled purge semantics.

At the actual `finishD1` boundary, immediately after reconciliation, the
successful atomic batch set-wise scrubs, but does not delete, every completed
audit row selected by the account id. The scrub requires a valid prepared
`scrubbed_evidence_sha256`, nulls the account id, operator, free-text reason,
classification/proof/observation data, and every original-claim field and byte
snapshot, and records `scrubbed_at`. That scrub statement precedes claim
deletion. In addition to the explicit no-attempted predicate, the claim
deletion and deletion-ledger `done` statement each require that no audit row
with this `account_id` remains after the scrub. Therefore an audit that
interleaves before the serialized finish batch is either completed with its
digest and included by the set-wise scrub, or is attempted and blocks finish
until reconciliation; neither can escape the exhaustive transaction. Thus the
original claim bytes and operator reason are replaced by a one-way evidence
hash rather than surviving the erasure. The retained minimal record is only `audit_id`, `requested_at`,
`completed_at`, `scrubbed_at`, `dry_run`, final `outcome`, nullable
`result_vector`, and the evidence hash; it has no remaining account linkage or
free text.

This is an explicit, narrow privacy exemption to design 37's ordinary rule
that account-scoped D1 and forensic audit rows are deleted (§4a/§4h). It follows
design 37 §4i's model for a minimized proof-of-erasure/compliance record: the
full row is account-scoped only until `finishD1`, and the scrubbed row is
retained solely to prove that a privileged genesis-repair action and its purge
were recorded. No other repair-audit retention exemption is implied. The
finish batch may scrub only completed rows; the guarded claim deletion and
deletion-ledger `done` transition cannot succeed while any attempted row
remains.

Conversely, once the deletion ledger is `purging`, no later execute or dry-run
can create a full account-linked audit for `finishD1` to miss. Once it is
`done`, the same insert-local predicate preserves the completed-erasure
boundary permanently. This closes the reverse-order race as well as the
audit-first race handled by reconciliation and the set-wise scrub.

Any workspace-registry ownership refuses automatic repair even when all D1
E2EE child counts are zero: a wedged genesis account should be brand-new, while
a workspace proves potentially real authoritative history. Pre-existing
claim-less DO history is likewise outside this repair protocol and is an
`integrity-failure` requiring manual escalation, not DO enumeration or a force
flag.

The tombstone has no expiry and is durable until exact capable replacement. A
tombstoned account can never be observed as pristine. Operator cancellation or
re-repair, if required, is a new platform-authenticated, conditionally applied,
permanently audited operation that first performs the mandatory attempted-
audit reconciliation; it is never a timeout or unaudited SQL edit.
Failure of capable bootstrap rolls back both child publication and tombstone
replacement, leaving the exact same tombstone for retry.

### 7. Concrete authenticated repair route

`apps/api/src/routes/admin.ts` exposes:

```text
POST /v1/admin/account/:accountId/genesis-repair
x-rbox-platform: <RBOX_PLATFORM_SECRET>
content-type: application/json
```

It sits before tenant authentication and uses the existing constant-time
`isPlatform` convention; unauthorized requests are cloaked as 404. The path
and body account ids must equal and match `^acct_[0-9a-f]{16}$`. The request is
an exact object with no extra keys:

```jsonc
{
  "accountId": "acct_0123456789abcdef",
  "operator": "on-call@example.com",
  "reason": "support case RBOX-1234: split genesis",
  "dryRun": true
}
```

`operator` is trimmed, control-free UTF-8 of 1–128 bytes; `reason` is trimmed,
control-free UTF-8 of 1–1024 bytes; `dryRun` is a required boolean. Invalid
schema is 400 before database access.

Dry-run performs the same inventory and exact claim-shape classification but
does not mutate the claim. It does permanently append an audit
row with `dry_run=1`, initially `attempted` and then completion-updated to the
dry-run result, and opportunistically reconciles older attempted rows before it
returns, unless its insert-local deletion-ledger guard yields `audit=0`. If it
crashes before its own completion update, reconciliation records
`dry_run_incomplete` rather than deriving eligibility or refusal from later
claim state:

```jsonc
{
  "ok": true,
  "dryRun": true,
  "auditId": "gra_…",
  "classification": "exact_legacy_orphan",
  "proof": {
    "eligible": true,
    "claimShape": "old_endpoint_exact",
    "dependents": {
      "rosters": 0,
      "keyStates": 0,
      "devices": 0,
      "workspaces": 0,
      "workspaceKeys": 0,
      "e2eePairingTokens": 0
    },
    "ownsWorkspace": false
  },
  "result": "no_change"
}
```

An ineligible dry-run returns the exact classified 409 refusal envelope below
and still writes its permanent dry-run audit row. Because dry-run makes no
subsequent mutation claim, its single inventory query may report that observed
classification and proof as dry-run output.

Execute uses the same body with `dryRun:false`. Exact success returns 200 with
the same classification/proof plus
`"result":"tombstone_claim_installed"`, `"repairId":"gra_…"`, and the exact
`repairedAt`. An `update=0` execute refusal returns 409 with `ok:false`, the
permanent `auditId` when `audit=1`, generic classification
`repair_refused_state_changed`, `result:"refused"`, and the bounded post-hoc
observational snapshot defined below; it never claims which predicate failed
and never offers a force flag. The distinct `audit=0, update=0` deletion-ledger
refusal uses the exact `account_erased` envelope below instead. An
unexpected database failure returns 500; the atomic batch leaves either no new
audit/update or its committed `attempted` audit plus exact update result for
idempotent reconciliation. It never invents an anomaly vector or compensates.

The exact dry-run refusal envelope is:

```jsonc
{
  "ok": false,
  "dryRun": true,
  "auditId": "gra_…",
  "classification": "not_found | malformed_claim | dependent_rows | workspace_history | already_tombstoned",
  "proof": {
    "eligible": false,
    "claimShape": "absent | malformed | old_endpoint_exact | repair_tombstone_v1",
    "dependents": {
      "rosters": 0,
      "keyStates": 0,
      "devices": 0,
      "workspaces": 0,
      "workspaceKeys": 0,
      "e2eePairingTokens": 0
    },
    "ownsWorkspace": false
  },
  "result": "refused"
}
```

The execute refusal envelope is instead:

```jsonc
{
  "ok": false,
  "dryRun": false,
  "auditId": "gra_…",
  "classification": "repair_refused_state_changed",
  "observation": {
    "observational": true,
    "claimShape": "absent | malformed | old_endpoint_exact | repair_tombstone_v1",
    "dependents": {
      "rosters": 0,
      "keyStates": 0,
      "devices": 0,
      "workspaces": 0,
      "workspaceKeys": 0,
      "e2eePairingTokens": 0
    },
    "ownsWorkspace": false
  },
  "result": "refused"
}
```

When either mode's audit insert sees the account deletion ledger in `purging`
or `done`, the route returns this exact 410 response. `dryRun` echoes the
request; the execute vector is `audit=0, update=0`, and the dry-run vector is
`audit=0`:

```jsonc
{
  "ok": false,
  "dryRun": true,
  "classification": "account_erased",
  "result": "refused"
}
```

The response has no `auditId`, proof, observation, `repairId`, or account-linked
payload. No audit row was inserted, so there is no completion or reconciliation
step for this vector.

The observation is a post-batch re-read and is not proof of the transaction-
time cause; its bounded current counts may differ from the state that caused
the conditional update to affect zero rows. Every `audit=1` refusal exposes its
newly inserted permanent refusal `auditId`; that id need not equal an existing
tombstone's `repairId`, which remains only redacted observed state. The
`account_erased` refusal deliberately exposes none. No response exposes
original claim bytes.

### 8. Client state machine

Pairing performs section 4's machine-global enumeration and classification
before this account-scoped machine or any consuming token redemption. It enters
an account state machine only while resolving one enumerated local pending
state; it does not infer the opaque token's target account. Recovery and all ordinary
genesis consumers already know their account and enter directly below.

Pending-state consumption runs under the per-account genesis lock. A path that
classifies a clean state and will publish its first pending artifact releases
that account-only acquisition, enters the global-to-account lock order, and
rechecks both server classification and local pending-artifact absence before
publication. It releases the global lock only after the marker is durable and
continues under the account lock except at the explicitly ordered re-entry
below:

1. Detect pending artifacts before every local-enrollment shortcut, fetch once,
   and invoke the shared classifier.
2. On revalidated `pristine`, start an ordinary bundle. On revalidated
   `repair-ready`, start a repair bundle bound to the tombstone's exact
   `repairId`. In either case durably publish the marker while both locks are
   held, release the global lock, generate once, and durably write/read back
   device, MK, and staged RK. Before journal publication, release the account
   lock with the marker still durable, re-enter in global-then-account order,
   revalidate the bundle, durably publish the journal, release global, and
   retain account.
3. On `restart-prepublication`, require the exact expected pristine or
   tombstone server state,
   durably clear only the provably unposted partial bundle with the marker
   removed last, then return to step 2. Any cleanup failure stops.
4. On `resume-attempt`, skip generation and reuse journal, local keys, and
   staged RK. Send the exact journal bytes.
5. On `cleanup-resume`, trust only the durable receipt's authorization, allow
   only receipt-specific legal absences, require exact destination bytes for a
   completed promotion, finish cleanup idempotently, and retire the journal
   last. A `competing-cleaned` attempt always uses one three-entry shared
   quarantine keyed by `requestSha256`; its journal remains until the terminal
   manifest proves the RK, device, and MK are all quarantined.
6. On `repaired-legacy`, start shared quarantine keyed by the tombstone's
   `repairId` only through the global-lock fresh-scan/account-lock choreography
   for first-manifest publication. On `quarantine-resume`, accept only the
   manifest's exact per-entry
   source-or-destination states, finish both renames durably, and publish the
   completed marker before returning to `repair-ready` generation. The retained
   completed archive is inert.
7. After any response or transport ambiguity, fetch and classify rather than
   interpreting the response as ownership.
8. On `committed-this-attempt`, reconstruct the canonical phrase from staged
   RK. If a valid completion intent exists and no RETARGET witness exists,
   resume its exact phrase-display, resolved-Keychain, or resolved-absolute-path
   action. If both records are absent, visibly re-present the deterministic
   completion choices and durably record the new selection before attempting
   it. Any present invalid intent or witness is integrity failure. A valid
   witness instead reconciles only its exact old/new canonical values and
   durably retires only after the survivor is fully durable. A pre-receipt
   interactive Keychain failure may, only
   after explicit fallback consent, RETARGET by atomically replacing the exact
   Keychain intent with the resolved file intent after first durably publishing
   their exact two-value witness. A failing invocation performs no fallback
   write; locked resume accepts only the witness's exact old or exact new
   canonical intent and completes its remaining read-back/file-fsync/directory-
   fsync durability plus witness retirement before any file commitment. Durably
   record the hold receipt
   and terminal cleanup
   phase only after delivery/commitment succeeds; only then clean staging and
   retire the journal.
9. On `competing-genesis`, durably record `competing-cleaned` and terminal
   cleanup phase before moving anything, then invoke shared quarantine with
   purpose `abandoned-attempt` for `rk.key.staged`, `device.json`, and `mk.key`
   regardless of cache preference and run only that authorized cleanup. Retire
   the journal only after `completed.json`; on `enrolled`, route normally.
10. On `legacy-orphan`, `integrity-failure`, fetch failure, or indeterminate
   local state, preserve journal, staged RK, device/MK, marker, and all other
   evidence and fail closed. A valid completion intent is inert in these
   states, on a tombstone, and on `competing-genesis`; it cannot authorize
   phrase display, Keychain add, or file output.

Account genesis locks live in the dedicated lock namespace and their acquisition
must not recursively create a fresh keystore tree before the marker's required
durable-directory publication. A redeem response cannot name any target lock
until its account id passes strict grammar and lock-namespace containment.

### 9. Wedged-account production runbook

The support procedure is deliberately one-way and narrow. Set the production
target explicitly, disable shell tracing, and pass the platform header through
curl's config stdin so the secret is not placed in curl's process argv:

```bash
export RBOX_REPAIR_API='https://api.rbox.to'
export RBOX_REPAIR_ACCOUNT_ID='acct_0123456789abcdef'
export RBOX_REPAIR_OPERATOR='on-call@example.com'
export RBOX_REPAIR_REASON='support case RBOX-1234: split genesis'
# RBOX_PLATFORM_SECRET is loaded from the approved operator secret source.
set +x

repair_body="$(
  jq -n \
    --arg accountId "$RBOX_REPAIR_ACCOUNT_ID" \
    --arg operator "$RBOX_REPAIR_OPERATOR" \
    --arg reason "$RBOX_REPAIR_REASON" \
    '{accountId:$accountId,operator:$operator,reason:$reason,dryRun:true}'
)"
printf 'header = "x-rbox-platform: %s"\n' "$RBOX_PLATFORM_SECRET" | \
  curl --config - --fail-with-body --silent --show-error \
    --request POST \
    "$RBOX_REPAIR_API/v1/admin/account/$RBOX_REPAIR_ACCOUNT_ID/genesis-repair" \
    --header 'content-type: application/json' \
    --data-binary "$repair_body"
```

After the dry-run response is checked, execute with this exact production
invocation:

```bash
repair_body="$(
  jq -n \
    --arg accountId "$RBOX_REPAIR_ACCOUNT_ID" \
    --arg operator "$RBOX_REPAIR_OPERATOR" \
    --arg reason "$RBOX_REPAIR_REASON" \
    '{accountId:$accountId,operator:$operator,reason:$reason,dryRun:false}'
)"
printf 'header = "x-rbox-platform: %s"\n' "$RBOX_PLATFORM_SECRET" | \
  curl --config - --fail-with-body --silent --show-error \
    --request POST \
    "$RBOX_REPAIR_API/v1/admin/account/$RBOX_REPAIR_ACCOUNT_ID/genesis-repair" \
    --header 'content-type: application/json' \
    --data-binary "$repair_body"
```

Operational sequence:

1. Confirm the client reports `legacy_orphan`; record support context; tell the
   user not to delete the exact old-flow unmarked `device.json`/`mk.key` local
   state.
2. Confirm production has the atomic/idempotent endpoint, exhaustive fetch,
   tombstone migration, workspace creation/commit and mutation fences, permanent
   audit reconciliation, and the genesis-capability gate. Confirm the user's
   rerun client sends `x-rbox-genesis-capability: 1` on account GET and
   bootstrap POST; its package version is not authorization.
3. Run the exact dry-run command above. Require `classification` equal to
   `exact_legacy_orphan`, `eligible:true`, and every dependent count zero.
   Require `ownsWorkspace:false`; preserve its `auditId`.
4. Run the exact execute invocation with the identical account/operator/reason.
   Require
   `tombstone_claim_installed` and `repairId === auditId`; do not use ad-hoc D1
   SQL or separate proof and update commands.
5. Confirm the account row is the exact version-1 tombstone, every dependent
   count remains zero, and the permanent execute audit is completed (reconcile
   `attempted` if necessary). Confirm old and capable account reads both return
   the same non-null tombstone, each old-client GET consumer follows its
   documented presence-only or verification behavior without local write or
   deletion. Guarded key/pairing mutation, workspace creation, and non-repair
   bootstrap each return 423 `repair_in_progress`; ordinary workspace sync
   authorization returns 404 because the legal tombstone owns no workspace and
   performs no DO forwarding. The anomalous workspace-bearing fixture is the
   separate defense-in-depth case that returns 423 before DO forwarding.
6. Ask the user to rerun genesis on the machine retaining the exact unmarked
   legacy device/MK pair. The classifier uses the tombstone itself as witness,
   creates the repair-id quarantine directory, publishes its hash manifest,
   archives both files, and durably publishes `completed.json` before creating
   one new bundle bound to that `repairId`. It sends the capability header on
   both requests.
7. Confirm one capable atomic bootstrap replaced the exact tombstone and that the client
   verifies roster/key-state chains, recovery binding, and every device row end
   to end. Confirm the audit row and quarantine archive remain. Row counts
   alone do not complete the incident.

Any refusal or result mismatch stops the runbook. There is no best-effort
completion and no manual `DELETE` fallback.

### 10. Ownership and release order

Under this design, `src/cli/e2ee-client.ts` will own bootstrap orchestration,
the prepublish/journal protocol, verified observation classification, and exact
attempt comparison; implementation must update its `docs/CODEMAP.md:143` line
to record that future state. Per `docs/CODEMAP.md:154`,
`src/cli/remote/keys.ts` remains
transport only: exact-body POST/fetch and typed HTTP errors, never crypto
interpretation. `apps/api/src/keys.ts` owns atomic publication, exact opaque
field idempotency, per-statement deletion-ledger and mutation guards, and exact
tombstone replacement. The admin route and
its scoped helper own repair proof/audit execution and reconciliation. The sync
route owns the new workspace-commit tombstone check immediately before Durable
Object forwarding; workspace authorization owns the matching pre-creation
checks, all three creation statements' deletion-ledger guards and atomic batch,
result precedence, and ordering. Pairing command/orchestration owns machine-
global local-pending-state enumeration, zero-redemption arbitration, and the
global-to-target-account lock handoff; first-pending-artifact publication,
active-journal publication, and final retirement coordinate with its global
lock, while account-specific classification remains in the shared genesis
subsystem. The account-delete purge driver's `finishD1` flow owns the
same account-scoped attempted-audit reconciliation, transaction-local claim-
deletion guard, scrub-on-purge minimization, and retry before the deletion
ledger can become `done`. Other command/front-door modules consume classifier
outcomes and own only UX/routing; the common E2EE-loading boundary owns the shared
pending-hold gate. Implementation updates CODEMAP for new modules or changed
ownership.

Release is API-first. Read `docs/DEPLOYMENTS.md` before changing/deploying
`apps/api/**`. Apply the migration; deploy and verify exhaustive fetch,
atomic/idempotent bootstrap, capability gate, workspace/mutation fences, admin
route, and audit in dev; exercise the dev runbook; promote production only
after CI/dev validation; only then release a CLI that implements the
capability-1 classifier behavior and the version-1 marker, journal, and
completion-intent schemas, and sends `x-rbox-genesis-capability: 1`. The
capability is the rollout boundary; those persisted schemas remain v1. Until that capable
CLI is available, operators do not execute repair. Compare-don't-assume remains
mandatory after promotion because an atomic commit can still lose its response.

### 11. Deployment ordering

The design-180 server MUST be live before any CLI carrying design 180 is
released or fleet-installed: merge `main` to deploy DEV, verify it there, then
use the explicit production promotion described in `docs/DEPLOYMENTS.md` before
shipping clients. Fresh setups against older servers fail closed with the
dedicated rollout error above. Already-enrolled users are insulated from that
transition by the byte-bound local enrollment witness. Old clients against the
new server remain certified safe by the section-2 old-client analysis. As with
the telemetry allowlist, the ordering rule is simple: server vocabulary deploys
before clients emit it.

## Security and privacy

- `rk.key.staged` contains RK secret material and is treated like `mk.key`:
  mode 600, bounded, never logged, and retained on uncertainty. Its lstat-based
  no-symlink checks are best-effort as described in the failure model. Neither
  marker nor journal contains plaintext phrase text.
- The journal contains opaque recovery/device wraps and signed public material.
  It remains sensitive, redacted, and durably removed only after receipt and
  staged cleanup.
- Server logs/client errors never include request fields, secret hashes,
  signed envelopes, wraps, account ids as metric dimensions, local paths,
  or the platform secret.
- Before hard purge, admin audit stores operator, reason, account id,
  timestamps, preflight observations, final outcome/vector, and—only for
  execute—the exact original orphan claim bytes required for reconciliation.
  Execute refusal also stores a bounded post-hoc snapshot explicitly as
  observation rather than proof. Those original fields receive the same
  restricted data-plane access and log redaction as live wraps and are never
  returned to clients; no submitted replacement request is stored there. At
  design 37's scheduled `finishD1` hard-purge boundary, the row is scrubbed to
  the explicitly exempted minimal compliance fields and a canonical evidence
  hash; account linkage, free text, proof/observations, and original claim bytes
  are nulled in the same successful finish transaction. Once the deletion
  ledger is `purging` or `done`, the audit insert and every statement in the
  ordinary-bootstrap, repair-bootstrap, and three-statement workspace-creation
  batches refuse.
  The same erasure guard covers other account-linked E2EE mutations. No later
  request can recreate a claim, genesis child, workspace ownership, fair-use
  row, workspace-creation audit row, or unscrubbed repair-audit record after
  that boundary.
- Exact comparison happens only after client chain/account verification. Server
  equality is transition-safe idempotency, not cryptographic attestation.
- Repair defaults to preservation. Unexpected rows, invalid crypto, malformed
  claims, audit failure, migration skew, and guard failure all halt.

## Testing

The implementation MUST write all tests below.

1. **Durable bundle unit tests:** strict marker/journal version, identity,
   null-or-exact-tombstone marker `repairId`,
   timestamp, phase, request SHA-256, original-cache-preference, enum, receipt,
   and body parsing;
   strict completion-intent tagged shapes, resolved Keychain identity,
   selection-time resolved absolute kit path, `version:1`, `accountId`, matching journal request digest, and
   `intentAt`; every structurally invalid or version/account/digest/shape/target-
   mismatched present intent is preserved and fails closed. Only record absence
   invokes deterministic reselection rather than target resumption. Strictly
   parse the RETARGET witness's exact tagged old/new intents, both digests,
   common account/request binding, and timestamp; a valid witness authorizes
   only its exact two canonical values. Active phase requires all
   staged material while receipt-bearing cleanup permits only its
   outcome-specific legal absences;
   exact UTF-8 preservation through escaping/reload; size bounds; mode 600; no parse/reserialize replay. Inject
   failures at ancestor mkdir/fsync, temp create/write/fsync/close, rename,
   exact read-back, published-file fsync, parent fsync, durable unlink, and
   promotion for `device.json`, `mk.key`, `rk.key.staged`, marker, journal, and
   completion intent and RETARGET witness, including witness publication,
   write-new-then-supersede RETARGET, and durable witness-retirement failures.
   Every pre-journal failure prevents POST; every active-journal failure
   prevents generation/replay and preserves state. Pin the documented Linux
   versus macOS crash guarantees and lstat race residual without claiming the
   test simulates physical power loss.
2. **RK no-loss/restart tests:** crash before POST after durable journal; crash
   after server commit before response; crash after response before phrase
   display; partial/throwing phrase output; crash after successful phrase output
   before receipt, after receipt/cleanup-phase publication before staged
   cleanup, and after each staged removal before journal retirement. Every
   active restart with an intent resumes its exact mode and target; change cwd
   across a kit-path restart and require the same persisted absolute target
   with no re-resolution. A crash
   before durable intent visibly re-presents deterministic choices from the
   same staged phrase and never claims the prior selection. Persist design
   179 `outcome:"claimed"`, crash before prompt emission with both the completion-
   intent record and RETARGET witness absent, then restart the same active
   journal: the completion UI
   is visibly re-presented as the same enrollment episode without a second
   independent offer claim. Every cleanup
   restart resumes idempotently from the receipt. Repeat for durable artifact
   commitment and both cache preferences; require exact promoted `rk.key`
   destination bytes when the source is absent and classify absence of both as
   integrity failure. Assert `competing-cleaned` always quarantines the losing
   RK, device, and MK through one three-entry shared-primitive manifest, never
   promotes or bare-unlinks them, and cannot retire the journal before the
   terminal marker. After retirement, assert `hasDevice` is false (or the
   equivalent common gate refuses) and no losing local enrollment survives. For
   **both** quarantine users, inject manifest and completed-marker parser
   failures, ancestor-fsync loss/failure, and crashes at directory creation,
   manifest publication, rename, destination validation, and completed-marker
   publication. For each of `quarantine-resume.json` and `completed.json`, for
   each of the two users, inject every hardened-writer failure at exclusive
   temp creation, write, temp fsync, close, atomic rename, exact read-back,
   published-file fsync, and parent-directory fsync, and prove the caller awaits the full
   contract without advancing. For both users also test empty-current-directory recovery,
   nonempty manifest-less directories, duplicate directories naming the same
   key, a directory for a different incomplete key, both-present and both-absent entry states,
   unexpected names and file types, and completed-to-manifest hash mismatch.
   For interactive Keychain failure, inject crashes/failures before replacement
   temp creation, after every hardened-writer stage, during exact file
   publication, after file verification, and before locator/receipt
   publication. Add explicit reconciliation cases for crashes after replacement
   rename, after exact read-back, after published-file fsync, and after parent-
   directory fsync. Extend that four-stage matrix across the witness boundaries:
   crash immediately before and after durable witness publication, require the
   witness to remain present through rename/read-back/file-fsync and through the
   post-directory-fsync pre-retirement point, then crash after witness unlink and
   after its parent-directory fsync and accept absence only because the survivor
   was already fully durable.
   In every case the crashing/failing invocation performs no fallback write.
   Locked resume strictly loads the witness first, accepts either its exact old
   Keychain intent or exact new resolved file intent, idempotently
   completes read-back, file fsync, and directory fsync for whichever it found,
   durably retires the witness only afterward, and only then retries that target;
   absent canonical state with a witness, malformed/mismatched/torn witnesses,
   or any canonical third state fail closed. Separately assert that a missing
   intent with no witness visibly reselects, while every present invalid
   version/account/digest/shape/target intent is preserved and fails closed.
   Assert the old canonical value retains the
   Keychain target, the new canonical value alone can authorize the exact file
   target after reconciliation, and after receipt RETARGET is rejected and
   cleanup remains monotone.
3. **Prepublication crash tests:** crash after marker and after each of device,
   MK, and staged-RK publication but before journal. Local shortcuts are
   overridden. Exhaustive expected pristine or exact-tombstone server state permits only conservative
   marker-last cleanup/regeneration; crash after each removal still resumes
   through the marker. Child-only, claim-present, missing marker, or malformed
   local state preserves evidence and fails closed.
4. **Wire/classifier matrix:** both 404 and 200 require
   `genesisPresenceVersion:1`; missing/unknown versions fail closed. A 404
   all-zero is pristine/resume as local state dictates; claim-absent with each
   presence field, including authoritative `workspaces`, nonzero is
   `integrity-failure`; malformed/missing/count-
   mismatched bodies fail closed. Force repair between presence observation and
   POST: the one-row read returns either the old orphan or tombstone, never 404,
   and the tombstone expected-previous predicate excludes the stale POST. Old
   GET with absent/duplicate/malformed/non-`1` capability still receives the
   same non-null tombstone. A table-driven matrix covers every old-client GET
   consumer: presence-only genesis preflight reports already setup; setup's
   pair/recovery choice reaches verification before any write; admission retry
   makes no new save after the GET; partial-keystore healing and sync pinning
   fail before their following writes; and the literal 409-versus-423
   discriminator proves tombstone handling cannot enter the local-key deletion
   branch. Capable GET parses its exact version/id/time. Test sentinel collisions, half-tombstones, bad id
   or time, repair metadata on a real claim, every tombstone child count, and a
   workspace-bearing tombstone. The latter is client `integrity-failure`
   rather than `repair-ready`, with no bootstrap loop.
   Test the precise legacy orphan and every malformed old-claim field; only the
   precise claim plus all zeros is `legacy-orphan`. The exact unmarked old
   device/MK pair plus matching tombstone is `repaired-legacy`; wrong repair id
   or malformed local state fails closed. Crash after quarantine directory
   creation, manifest publication, each rename, and completed publication;
   enumerate legal source/destination states and hash failures. Assert the empty
   directory is not pending, `quarantine-resume.json` is the first pending
   artifact, and no source rename occurs before its durable publication. Retain a valid
   completed archive through tombstone replacement and confirm it is inert and
   enrolled classification still succeeds.
5. **Cryptographic consistency tests:** valid no-journal enrollment; invalid
   signature/chain/account id; recovery-wrap substitution/hash/id/current-state
   mismatch; null/malformed device fields; duplicate/extra/missing device;
   public-key mismatch; active/revoked/removed lifecycle cases; unauthorized or
   wrong-principal MK wrap. Test exact matching attempt and one-field-at-a-time
   mismatch across all eight request fields. Only fully verified exact match is
   `committed-this-attempt`.
6. **Whole-command and shared-gate tests:** direct genesis and device-code,
   top-level setup (including `enrolledAccountId`), `resolveEnrollment`, bare
   `rbox`, `rbox init --bootstrap`, direct `rbox connect`/pair redemption, and
   direct `rbox key recover` (manual and design 179 Keychain restore). Every
   account-identifying surface with a pre-persisted `device.json` plus pending
   journal reaches the shared fetch/classifier under that account's genesis lock
   and resumes or cleans up first; none chooses enrolled menu, `auth="have"`,
   recovery, or setup skip first.

   Pairing has a separate machine-global pre-redemption matrix. Enumerate active
   pending state with absent credentials, credentials for a different account,
   multiple account directories, multiple simultaneous journals, marker-only
   state, and stale account directories. In every case the scan reaches each
   pending state's shared classifier without using current credentials to scope
   enumeration. While any pending artifact remains active, every classifier
   outcome—including marker-only,
   cleanup-resume not yet retired, invalid pending state, orphan, competing,
   indeterminate/fetch failure, and integrity failure—has zero `/pair/redeem`,
   credential replacement, device/MK write, admission, or other mutation and
   returns the stable resume instruction. A same-account fixture alone is
   insufficient. Terminal automatic cleanup must rescan, and redemption may
   proceed only after **all** pending artifacts are durably retired.

   Add all lock-boundary races. First, use a token that will resolve to the same
   account as the competing genesis flow, pause pairing after its final empty
   scan, and attempt to publish `genesis-prepublish.json` as the first pending
   artifact. The publisher must block on the global lock: either durable marker
   publication precedes the scan and pairing refuses without redemption, or
   pairing redeems, acquires the named target-account lock, completes credential
   replacement, device/MK persistence, and admission, and only then can the
   publisher acquire the account lock and revalidate; it publishes only if the
   fresh state still authorizes it. Repeat this final-empty-scan race with repaired-legacy
   `quarantine-resume.json` as the first artifact: its publisher must perform
   global acquisition, a fresh revalidating scan, account-lock acquisition, and
   manifest publication under both locks; either the manifest precedes the scan
   and pairing refuses, or its publisher blocks on global. No source rename may
   precede the manifest.

   Second, pause pairing after `/pair/redeem` returns a valid target but while it
   still owns global, before any credential, device/MK, or admission write.
   Queue a valid first-marker publisher for that target on global. Prove pairing
   first acquires the target-account lock and releases global; the publisher
   then acquires global, blocks specifically on pairing's still-held target lock
   through all remaining pairing writes and admission, and revalidates after it
   eventually acquires the account lock before deciding whether it may publish.
   Do not construct this race with a journal publisher, whose existing-marker
   precondition would have made the final scan nonempty. Also return malformed,
   traversal-shaped, separator-bearing, Unicode-confusable, overlong, and
   extra-field redeem account ids and assert rejection before target-lock naming
   or account fetch, zero keystore-tree creation, and zero filesystem mutation
   outside the dedicated lock namespace. A valid fresh target creates only the
   lock namespace before pairing's ordinary writes. No race permits pending
   state concurrent with token consumption or post-response pairing writes.

   For direct recovery, every nonterminal outcome has zero manual phrase
   prompt/read, Keychain probe/offer/read, credential replacement, device/MK or
   RK write, admission request/persistence, or record merge. The only permitted
   work before refusal/routing is lock handling and read-only observation/
   classification. A terminal cleanup-resume fixture proves the original
   command may proceed only after durable journal retirement. All conservative
   outcomes preserve material and use the uniform error. With an unreleased
   hold, whole-command sync is gated at the
   common E2EE-loading boundary, status is allowlisted and reports the pending
   state read-only, and export's `hasDevice` shortcut reaches the same gate. A
   structurally valid completion intent causes zero phrase display, Keychain
   add, or file output for every tombstone-backed classifier result, or when
   classification is `competing-genesis`, indeterminate/fetch failure, or
   `integrity-failure`.
7. **API atomicity/result-vector tests:** inject failure after every logical
   statement in both ordinary insert and tombstone-replacement batches. Failure
   leaves zero newly published child rows and preserves the prior absent or
   exact tombstone state; success leaves all four real rows co-present. Cover
   every constraint, concurrent bootstraps, rollback, exact expected result
   vectors, and wrong/stale `repairId`. Every ordinary- and repair-bootstrap
   statement must independently prove both its attempted-audit and its
   `account_deletions.status IN ('purging','done')` `NOT EXISTS` guards.
   Crash an absent-claim dry-run at `attempted`, race ordinary bootstrap, and
   require `0/0/0/0` with no claim before reconciliation and exact-request
   retry succeeds. For repair bootstrap, race a newly
   attempted execute so it commits immediately before the serialized bootstrap
   batch, require publication to remain absent with the tombstone intact, then
   reconcile and retry the exact request successfully. Seed a child-bearing tombstone for each
   inventory category and a workspace-owning tombstone; each of all four
   statements' complete expected-previous guard refuses, the whole batch rolls
   back, no new child is published, and the tombstone remains unchanged. Assert no test attributes crypto
   consistency to server row co-presence.

   Add the erasure-first reverse-order matrix for both branches. Capture an
   already-authenticated request, schedule deletion, and let `finishD1` commit
   claim/child deletion and ledger `done` before ordinary bootstrap, then before
   repair bootstrap. Each batch must
   produce `0/0/0/0`, return exact 410 `{ "error": "account_erased" }`, skip
   idempotency/repair-fence interpretation, and recreate no claim or child.
   Repeat with a directly seeded `purging` ledger. Conversely, prove an absent
   or `pending` ledger allows ordinary bootstrap and an eligible repair
   bootstrap, so the guard does not redefine live legacy state.
8. **Server idempotency/capability tests:** exact opaque replay returns 200 for an
   immediate retry and with later descendants; a pre-migration exact complete
   cohort with null `genesis_device_id` also returns 200, while an ambiguous
   legacy device cohort does not. Mutate each of eight payload fields and
   require only `409 already_bootstrapped`. Commit then drop the response; an
   old-client retry receives 200 and does not delete local keys. Repeat the lost
   response replay after successful tombstone replacement with the exact
   historical `repairId` and require the same field-idempotent 200.
   Seed a tombstone and test absent, duplicate, malformed, non-`1`, and exact
   `1` `x-rbox-genesis-capability` headers, including an unversioned dev build.
   GET always returns the non-null tombstone. A repair POST naming the right id
   but lacking capability changes zero rows and returns only the 428
   `genesis_capability_required` envelope; old, omitted, wrong, or stale repair
   POSTs return only 423 `repair_in_progress`. Assert the per-call-site old-
   client outcomes from the table-driven GET-consumer matrix, without promising
   one universal error, and preserve the exact legacy pair. Vary `x-rbox-version`
   without changing authorization. Race ordinary bootstrap against execute;
   it never inserts children and can observe no pristine window.
9. **Mutation-fence/N=1 tests:** every key mutation and E2EE-bearing pair create
   requires a real non-tombstone claim and no `purging`/`done` deletion ledger
   in its write transaction. A tombstone returns exact 423 without writes; an
   erasure ledger returns exact 410 `account_erased` without writes. Assert
   workspace creation checks erasure and then the tombstone before quota and
   viewer authorization: tombstoned plus over-quota returns 423 rather than 402,
   and a tombstoned viewer returns 423 rather than 403. The ownership insert,
   fair-use upsert, and creation-audit insert are one transaction, and each
   independently carries both transaction-local guards, not merely one shared
   precheck. Pin exact vectors:
   a tombstone yields `0/0/0`, 423, and zero ownership, fair-use,
   creation-audit, or DO side effects, including old setup and init paths that
   trust a local device; race operator
   execute against creation and prove ownership cannot appear after tombstone
   installation. An absent claim and a real claim each take the ordinary `1/1/1`
   path; the absent-claim regression must preserve today's legacy creation
   behavior and must not return 423 or any new missing-claim error. Each
   sentinel collision, half-tombstone, and repair-metadata-bearing real-claim
   form must instead take the same `0/0/0`, 423, zero-side-effect fence. For
   workspace sync, a legal all-zero tombstone returns the
   existing authorization 404 and never reaches the DO; an anomalous workspace-
   bearing tombstone reaches the defense-in-depth check, returns 423 immediately
   before forwarding, and still produces no DO side effect. Assert no earlier workspace-auth or
   key-epoch lookup is treated as the fence. Assert `dbFor(env, accountId) ===
   dirDb(env)` in the configured N=1 environments, and add a sharding
   configuration guard/test that refuses N>1 while this protocol is active.

   Add the workspace erasure-first reverse order. Capture an already-
   authenticated request, schedule deletion, and let `finishD1` commit before
   workspace creation; require `0/0/0`, exact 410
   `{ "error": "account_erased" }`, and zero ownership, fair-use, creation-
   audit, or DO effects. Repeat with `purging`. With an absent or `pending`
   ledger, both an absent claim and a clean real claim retain the ordinary `1/1/1`
   path; this is the explicit live-legacy absent-`account_keys` regression.

   Add the mid-operation reverse race that exposed the former split call.
   Instrument the seam that used to follow the ownership/fair-use batch and
   precede the separate audit call; under the new structure this can only pause
   before the entire combined transaction, never between its statements. Let
   `finishD1` serialize there and commit deletion plus ledger `done` first. The
   combined three-statement batch must then refuse as `0/0/0`, return exact 410
   `account_erased`, and commit no ownership, fair-use, or creation-audit row.
   The test must prove refusal by the audit INSERT's own transaction-local
   deletion-ledger guard as well as the other two guards; merely showing that
   the obsolete separate audit call was removed is insufficient.
10. **Repair SQL/admin tests:** independently violate every old-claim field and
    each dependent emptiness condition and authoritative workspace-registry
    ownership while the deletion ledger is absent or `pending`; the conditional
    update changes zero rows while the guarded audit insert records refusal and
    an exact type/byte snapshot of every
    original claim field, including row presence and repair metadata. Assert
    execute is exactly two statements and only `audit=1, update=1` success,
    `audit=1, update=0` state-change refusal, or `audit=0, update=0`
    `account_erased` refusal can commit; `audit=0, update=1` is impossible.
    Assert execute and dry-run audit INSERT statements each contain their own
    `NOT EXISTS` predicate over an `account_deletions` row in `purging` or
    `done`; an application precheck does not satisfy this test. Insert a child
    between preflight and the execute batch: require `update=0`, no tombstone
    update, generic
    `repair_refused_state_changed`, and an audit completed as `refused` whose
    post-hoc snapshot is marked observational rather than an exact cause. Verify success stores the orphan's
    original wrap/id bytes and installs the exact versioned tombstone without a
    claim-absent observation. The execute update's `NOT EXISTS` guard excludes
    only its own transaction-bound audit id. Race a second attempted execute
    into that guard: the blocked mutation completes its own no-op audit,
    reconciles, and retries without ever dropping the guard.
    Crash before completion update leaves `attempted`; admin/account/bootstrap
    read-time reconciliation idempotently records the exact execute vector,
    outcome, observational snapshot where applicable, and `completed_at`
    before tombstone replacement. Separately crash after attempted insertion
    for both an eligible and an ineligible dry-run: each reconciles only to
    `dry_run_incomplete`, with its persisted observation retained, null result
    vector, no claim mutation, and no authority. Each attempted dry-run blocks
    a mutator until read-time reconciliation completes.

    Schedule account deletion, then race a successful execute that crashes
    before audit completion immediately ahead of the purge driver's real
    `finishD1` batch. The guarded `account_keys` deletion must change zero rows,
    the deletion ledger must not become `done`, and reconciliation must record
    the true `tombstone_claim_installed` outcome before `finishD1` retries and
    deletes the claim. In a separate race, insert and complete a new audit after
    finish preflight but before the serialized batch; the set-wise scrub must
    include it. Leave the interleaving row attempted in another case and require
    the exhaustive post-scrub account-link guard to block claim deletion and
    `done` until reconciliation and retry. Apply the same transaction-local `NOT EXISTS`, blocked-
    reconcile, and retry assertions to repair bootstrap and every future
    cancel/re-repair fixture. This is an interleaving test, not merely a
    reconcile-before call-order assertion.

    Add the reverse-order races. Let `finishD1` win and commit the scrub, claim
    deletion, and ledger `done` before an execute reaches its audit INSERT; the
    batch must produce `audit=0, update=0`, return the exact 410
    `account_erased` envelope with `dryRun:false`, omit `auditId`, and leave no
    new repair-audit row or any other unscrubbed account-linked row. Repeat with
    `finishD1` winning before a dry-run INSERT; require dry-run `audit=0`, the
    same envelope with `dryRun:true`, no `auditId`, and no account-linked row.
    Seed `purging` directly for both modes as well and require the same refusal,
    proving the insertion guard closes the entire purge interval rather than
    only the final `done` state.

    On successful hard purge, assert each repair-audit row remains but every
    account/free-text/proof/observation/original-claim field is null, the
    canonical evidence hash and `scrubbed_at` are present, and only the stated
    minimal timestamps, dry-run flag, outcome, result vector, and audit id
    remain. Reconciliation must precede both scrub and claim deletion; an
    attempted row can never be scrubbed or survive a completed purge.
    Test a durable tombstone has no expiry, is never pristine, and that any
    cancel/re-repair path is a separate audited conditional operation.
    Route tests cover platform-secret 404 cloaking, exact schema/account-id and
    path/body equality, bounds/control characters, dry-run no claim
    mutation plus durable audit, every dry-run refusal classification and
    exact 409 admin envelope, both modes' exact 410 `account_erased` response,
    execute response, retry, redacted proof/original byte non-exposure, audit
    survival after tombstone-replacing bootstrap, and scrubbed minimal-record
    retention under the explicit design-37 exemption.
11. **Repair end-to-end:** seed the real production legacy orphan: the exact old
    claim plus unmarked local `device.json`/`mk.key`, with no journal, marker, or
    staged RK. Dry-run and execute, assert workspace-registry eligibility and
    that stale mutations, pairing, and workspace creation are fenced with 423;
    legal-tombstone workspace sync returns authorization 404 without DO
    forwarding, while the anomalous workspace-bearing defense fixture returns
    423 before forwarding. Fetch the non-null tombstone, quarantine the legacy
    files through directory → manifest → hash-checked renames → completed marker,
    generate a new request bound to its `repairId`, and bootstrap with
    `x-rbox-genesis-capability:1` on GET and POST. Atomically replace the exact
    tombstone, verify mutual consistency client-side, complete phrase delivery,
    retire new local staging, and retain both audit row and completed quarantine.
    Reclassify afterward to prove the retained archive is inert. Failed
    bootstrap retains the tombstone and new attempt material.
12. **Deployment validation:** migration/API/client unit tests and typecheck,
    then `bun run rig` or a dev build shipped to the local fleet per repository
    flow. Execute the exact runbook against a seeded dev orphan before
    production promotion.

## Slices

1. Migration, exhaustive account observation, conflict-raising atomic genesis,
   tombstone expected-previous replacement, server exact-field idempotency,
   capability gate, atomic three-statement workspace creation/commit and
   mutation fences, permanent pre-purge audit, deletion-ledger guards in every
   affected mutation statement,
   transaction-bound reconciliation guards, `finishD1` scrub-on-purge
   minimization, admin route, and statement/race tests.
2. Hardened keystore mutation, prepublish marker, staged RK/completion receipt,
   exact journal/replay, shared quarantine, and shared verified classifier.
3. Direct genesis, device-code, setup, front-door, init, direct pairing's
   machine-global pre-redemption arbitration plus global-to-account lock
   handoff, and direct manual/Keychain recovery's account-scoped pending-state
   adoption plus the shared result type;
   uniform wedge UX and preservation.
4. Dev orphan/runbook validation, API-first production promotion, capable CLI
   release, and full rig/local-fleet validation.

## Open questions (for review)

None in v13. The round-4 tombstone pivot supersedes the earlier
permit-absence/witness/expiry repair fence; all 11 r4 rulings are folded. The
eight accepted r5 corrections and all seven accepted r6 corrections are folded
as controlling records, both accepted r7 corrections, both r8 rulings, and
both binding r9 rulings, all five binding r10 rulings, the single binding r11
RETARGET reconciliation ruling, and both binding r12 rulings are folded; r12 is
the latest controlling record for RETARGET provenance and completion-intent
reselection. The
certified exact-field idempotency, journal phases, completion hold, E2EE gate,
durability model, capability header, presence version, server/client invariant
boundary, and unaffected earlier rulings remain pinned above.
