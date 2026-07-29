# Design 225 — review log

Provenance for `docs/design/225-active-bytes-fast-path.md`. This is the record
of what each adversarial review round found, how it was ruled, and where the
ruling landed — plus the line numbers verified against the worktree during each
fold. It is **not** part of the spec: an implementer needs the design doc, not
this file. Read this when you want to know *why* 225 says what it says, or
before re-proposing something an earlier round already rejected.

The conclusions an implementer must not re-litigate were carried forward into
the design doc itself (§5, "Settled — do not re-litigate"). Everything else
lives here.

**Three rounds have run and the 3-round cap is spent.** The design is
self-certified for implementation; there is no round 4.

## Round-1 rulings (9 findings, all ACCEPT)

| # | Finding | Where it landed | Round-2 status |
|---|---|---|---|
| 1 | The algorithm was wrong: the sidecar refset ≠ the live set, and inline mode (`SIDECAR_THRESHOLD = 4000`) returns ZERO for every small workspace | §2.1 — redefined as `refSetAt` parity: inline XOR sidecar, ∪ chainRefs ∪ encManifestSha ∪ sidecarSha; git sections shown already included; reuse `readRefMode`/`readManifestChain` | **Confirmed complete** in round 2 (finding 8) |
| 2 | Cross-workspace dedup is impossible (per-workspace KEKs), not merely rare | §2.2 — union DELETED, account total is a SUM; dedup only within a workspace-group | Unchanged |
| 3 | "One tick / no as-of hazard" was overclaimed; no budgets of any kind existed | §2.3 (per-group as-of model, checkpointing, no in-memory union), §2.5 (fail-closed budgets, the 250k/10 MB/640 MB numbers, `blob_refs` has no size column) | **Partly REVERSED.** This ruling also said `readSidecarRecords` "DOES exist … reused as-is". Round-2 finding 1 reversed the reuse half — see below |
| 4 | NULL `history_bytes` needs a table rebuild and would read as `0` anyway | §2.8 — additive `history_computed` flag in a new migration; `bound_bytes` must not be computed when history was not | **Default corrected** from `0` to `1` in round 2 (finding 6) |
| 5 | The anomaly surface is unnamed; `fairuse.ts` emits zero metrics in 1,151 lines | §2.9 — `metric()` from `gc-observability.ts:159-162` **plus** a persisted `entitlement_missing_count` column | Unchanged |
| 6 | Reading the head envelope from D1 `commits` is a blocker; `/latest` is a trap (positional path + `ensureBootstrap`) | §2.6 — new `/roots-inspect` head-envelope mode: fixed path, slash-safe, read-only, pre-bootstrap, not index-gated, envelope + pins in one atomic response | **Extended** with empty/pristine semantics in round 2 (finding 4) |
| 7 | A blanket "missing sidecar aborts" reproduces the very wedge being fixed | §2.7 — stale (`missing`) retries against a re-read head, bounded at 2 like `MAX_SNAPSHOT_RETRIES`; only hash/size/parse faults hard-abort | Unchanged; round 2 made it the *only* retry on the path |
| 8 | Assorted notes; test 1 must assert an exact total, not `> 0`; §1.1 is conservative; §2.4 self-contradiction | §2.11, test 1, §1.1, §2.10 | Unchanged |
| 9 | Citation errors: `grantUsage` was invented; several line numbers off; the design-149 quote was an inference | §2.10 (`grantEntitlementWithQuota` `billing.ts:65`, `releaseUsage` `:113`, `commitAccounting` `:162`, `reconcileUsage` `gc-phase1.ts:264-279`, cap triggers `0014`+`0016`), §1.1/§1.4, §3, §1.3 | Unchanged |

Line numbers corrected against the worktree during the round-1 fold: `samePin`
`:261` (was `:262`); `FAIRUSE_LEASE_TTL_MS` `:14` (the ruling said `:13`, which
is `FAIRUSE_ENTITLEMENT_PAGE`); `grantEntitlementWithQuota` `:65` (was `:66`);
`releaseUsage` `:113` (was `:118`); `reconcileUsage` `:264-279` (was
`:263-278`); `accounts_cap_guard` `:60-66` (was `:59-66`); pin-churn test
`:186-223` (was `:185-222`); `plan_snapshot` insert `:420-425`, guard
`:315-317`; KEK workspaceId binding `keys.ts:34` (was `:35`);
`blobRefsForManifest` `:141-155` (was `:141-153`); D1-mirror comment
`workspace-sync.ts:111-114` (was `:112-114`).

## Round-2 rulings (9 findings, all ACCEPT)

| # | Finding | Ruling | Where folded |
|---|---|---|---|
| 1 | Round 1's "reuse `readSidecarRecords`" was half right: it exists and is ranged (right), but 600 records/GET means 86 GETs for the founder's 51,262-ref sidecar and 417 at 250k refs, and it never hashes the object against `descriptor.sha` | ACCEPT — **reverses the round-1 correction** | §2.4 — one whole-object validated read per stream (`sidecar.ts:52` pre-buffer size gate + sha verify); no incremental digest; §4 non-goal rewritten; round-1 entry 3 amended above |
| 2 | Cross-project dedup contradicts the `(workspace_id, project_id)` stream key | ACCEPT — blocker | §2.3 — exactly ONE aggregate per `workspace_id`; `roots_done` reused as the per-stream marker; no new dedup relation, no sorted merge |
| 3 | `MAX_REFS_PER_COMMIT` bounds one commit, not a group; calling an over-cap group "a corrupt descriptor" fails closed on valid data | ACCEPT | §2.5 — `FAIRUSE_GROUP_REF_CAP` / `FAIRUSE_ACCOUNT_REFS_CAP` justified by isolate memory and statement budget (the 250,000 coincidence flagged as coincidence), checked from head envelopes before any GET, 50% warning metric, worst-case table (GETs, statements, subrequests, checkpoints, retries), boundary test 9 |
| 4 | The `/roots-inspect` head mode omits ordinary empty-workspace states | ACCEPT | §2.6 — pristine vs damaged discriminated with `ensureBootstrap`'s own read-only predicates (`workspace-sync.ts:234-237`, `hasRetainedSeqEvidence` `:289-300`); defined empty-head 200 contributing a computed `0`; test 11 |
| 5 | §2.3 (retry if head moves) contradicted §2.5 (the caller "never re-fetches pins") | ACCEPT — preferred branch | §2.3 — **the captured DO response IS the accepted snapshot**; the head-stability claim and retry-on-head-move are deleted; multi-project groups explicitly read at differing instants; only the stale-sidecar retry survives (§2.7) |
| 6 | `history_computed … DEFAULT 0` relabels every existing completed scan as uncomputed | ACCEPT — rollout bug | §2.8 — `NOT NULL DEFAULT 1 CHECK(… IN (0,1))`; the active-only path writes `0` explicitly; both `historyBytes` and `bound` gated on the flag; test 7 covers a pre-migration row |
| 7 | The `totalBytes` cross-check is wrong — it excludes `encManifestSha`, chain refs and the sidecar carrier, all of which are charged | ACCEPT — delete | §2.1 — cross-check deleted with the arithmetic shown (`e2ee-remote.ts:788`, `refset.ts:8-13`); the decoded-record size sum (`fairuse.ts:600-606`) noted as a possibility, not a requirement |
| 8 | No additional head blob is charged into `blob_refs` — §2.1's formula is complete — but the parity test could still ratify an undercount; §2.1 cited a dangling "§3.8" | ACCEPT | §2.1 — the positive verification recorded with its citations (`workspace-sync.ts:595-597`, `:648-665`, `gc-roots.ts:101-114`); test 10 asserts **equality** against `result.refs ∪ {manifestSha} ∪ {carrierSha}`; "§3.8" → test 10 |
| 9 | Two wrong citations; the ranged reader was credited with a pre-buffer full-object-length gate it does not have | ACCEPT | §2.4 — the reader's real checks enumerated by line (`:554`, `:557-558`, `:568`, `:577` final-chunk only, no sha check); the pre-buffer gate correctly attributed to `sidecar.ts:35/55/68`; with finding 1 no stale reference to the ranged reader survives |

### Round-2 addendum — the group aggregate is a table, not an anchor row

The first round-2 fold satisfied finding 2 with a nullable
`fairuse_workspace_streams.group_active_bytes` column written to the group's
`MIN(project_id)` "anchor" row. **Rejected on review**, in favour of
`fairuse_workspace_group_totals(account_id, epoch, workspace_id, active_bytes,
updated_at)`:

- "Fewest moving parts" is not "fewest tables". A moving part is something a
  reader must hold in their head to reason correctly; the anchor convention is
  an invisible rule that never appears in the schema.
- It put a workspace-level fact in a table keyed `(workspace_id, project_id)`.
- It collided NULL-as-sibling-row with NULL-as-not-computed, destroying the
  computed-zero vs not-computed distinction finding 2 explicitly required.

The table makes existence itself the completion marker, so `active_bytes = 0`
is unambiguously a computed zero. Its only cost is one mechanical line in
`account-delete.ts:411-417` (§2.11) — visible, not invisible. Do not re-propose
the anchor row.

Line numbers re-verified against the worktree during the round-2 fold:
`readSidecarRecords` `fairuse.ts:540-578` (ranged GET `:551`,
`FAIRUSE_ROOT_STAGE_ROWS` `:11` used at `:547`, final-length check `:577`);
`loadSidecarRaw` `sidecar.ts:32` (`:35`/`:37`), `loadSidecarRefs` `:52`
(`:55`/`:57`), `loadSidecarShaSet` `:65` (`:68`/`:70`); `MAX_REFS_PER_COMMIT`
checks `workspace-sync.ts:578-580` and `:653-655`; carriers `:595-597`;
`rootsInspect` `:1046` (head read `:1050`, index gate `:1059`, pins `:1064`,
gap 409 `:1116`); `ensureBootstrap` pristine/damaged branch `:227-251`,
`hasRetainedSeqEvidence` `:289-300`, `GENESIS_HASH` `:1356`;
`fairuse_workspace_streams` DDL `0029_storage_economics.sql:41-56`,
`fairuse_scans` byte columns `:31-33`, latest index `:36-38`; completion UPDATE
`fairuse.ts:994`; workspace-set aborts `:961`/`:967`; `billing.ts` fair-use
block `:162-164`; sidecar `totalBytes` `e2ee-remote.ts:788`; highest migration
on disk `0034_key_delivery.sql`.

## Round-3 rulings (7 findings, all ACCEPT) — FINAL

Round 3 was the last round of a hard 3-round cap. After this fold the design is
**self-certified for implementation**. Three of the seven rulings delete
mechanism.

| # | Finding | Ruling | Where folded |
|---|---|---|---|
| 1 | `FAIRUSE_ACCOUNT_REFS_CAP` was circular — the cap defined the per-tick statement budget and the budget justified the cap, neither derived from a platform limit — and it wedges any account above ~250,000 `blob_refs` at `activeBytes: null` **forever**. The founder is at ~75,000 with 4 workspaces (~a year of growth), and the only warning was a metric from a module that has never emitted one. The substrate already handles unbounded cardinality: `classifyEntitlements` (`fairuse.ts:862-897`) does it in **2 statements per tick** with a checkpointed cursor (`entitlement_cursor_sha` resumed `:863-864`, written `:893-895`), which is exactly why design 149 gives its 64-statement budget to fold/output WRITE ticks only (`149-storage-economics.md:931-939`) and not to classify. 225 had discarded that and done 125 SELECTs in one tick | ACCEPT — **DELETE the cap** | §2.5 — one cap only (`FAIRUSE_GROUP_REF_CAP`, re-justified from isolate memory + the Workers subrequest ceiling); paging bounded at `FAIRUSE_ENTITLEMENT_PAGES_PER_TICK = 48` (49 statements, inside 149's 64) and **checkpointed across ticks**, so no budget scales with account size; `FAIRUSE_ACTIVE_STATEMENTS_PER_TICK` deleted; new resume-validity rule (re-derive the group's set on resume, restart from cursor 0 if the head moved) explicitly distinguished from the round-2 head-stability retry; §5.8; tests 9 and 12 |
| 2 | **The biggest gap: the status machine was never written down.** The design specified mechanisms but never said what happens to `capture_pins` → `materialize_roots` → `classify_entitlements` → verify → `complete` (dispatched `fairuse.ts:1104-1116`). Four specific holes: (a) no site writes `fairuse_scans.active_bytes` from the group SUM, and billing reads that column (`billing.ts:162`) — leaving it unwritten means billing reports **0**; (b) `classifyEntitlements`'s `SET active_bytes=active_bytes+?` (`:893`) was never removed, double-counting a billing input; (c) the fate of `fairuse_root_membership` / `fairuse_materialize_refs` / `fairuse_sha_last` was unstated though they are still named by the abort-residue query (`:1058-1066`) and `cleanupAbortedPage` (`:905-941`); (d) nothing sets `pins_verified`, which the unchanged completion predicate requires on every stream (`:1010-1015`) and which only the now-non-gating `samePin` loop (`:975-982`) ever set | ACCEPT | **new §2.12** — a status-by-status table. `classify_entitlements` and the verify phase are both DELETED (with head comparison retired, `verifyPinsWithEnv` was a flag-setter; the flag moves into the group's completion batch, the workspace-set aborts move into the group pass). `complete` becomes the single writer of `active_bytes` and writes `bound_bytes` as a literal `0` — which also sidesteps the trap that all `SET` expressions in one UPDATE read the OLD row, so `5*MAX(active_bytes,?)` beside a new `active_bytes` would use the pre-update value. The three membership tables stay unwritten but undropped so pre-deploy aborted epochs still drain. Tests 13 |
| 3 | §2.4's closing sentence ("reuse `loadSidecarRefs`… the sizes come out of the refset bytes, not out of D1") contradicted §2.5's `blob_refs ⋈ blobs` query **and was wrong**: the refset record layout `32-byte sha ‖ size u64be` (`src/engine/refset.ts:5-7`, `:25-27`) covers DATA REFS ONLY, so `encManifestSha`, chain refs and the sidecar carrier would sum as **0** — undercounting exactly the terms §2.1 fought to include — and inline mode (`commit-envelope.ts:75`, `:84-90`) yields `refShas: string[]` with no sizes at all. Independently, a refset size is client-declared while `blobs.size_bytes` (`0001_init.sql:8`) is the server's recorded R2 object size | ACCEPT — **DELETE the sentence** | §2.4 — `blobs.size_bytes` named the SOLE size authority with all three reasons; reader switched from `loadSidecarRefs` to `loadSidecarShaSet` (`sidecar.ts:65`, gate `:68`, hash `:70`), the same reader `refSetAt` uses (`workspace-sync.ts:852`), which also removes the 250,000-element `Ref[]`; §5.9 |
| 4 | §2.3's "set once a stream's refs are folded into its group's row" reads as per-stream incremental accumulation, under which a sha shared by two projects of one `workspace_id` is counted twice — round-2 finding 2's blocker, reintroduced by wording | ACCEPT | §2.3 — the unit of work is stated as the GROUP: one union of K projects' `refs(head)`, ONE intersection, ONE row write, all K streams marked in the same batch; `ON CONFLICT DO UPDATE SET active_bytes = active_bytes + …` explicitly FORBIDDEN in text; §5.10; test 13 asserts no stream carries an accumulated total |
| 5 | The isolate-memory arithmetic understated peak: `parseRefset` (`refset.ts:120`) materializes 250,000 `{encSha,size}` objects at ~200 B/entry, so real peak was ~10 MB buffer + ~50 MB array + ~33 MB Set ≈ 80 MB against 128 MiB, not the quoted ~43 MB | ACCEPT — resolved by finding 3 | §2.5 — arithmetic corrected and the reason for the change stated; adopting `loadSidecarShaSet` deletes the array and restores the ≈43 MB figure |
| 6 | The group-cap pre-check added 2 carriers unconditionally, but inline commits have no sidecar so `encManifestSha` is the only carrier. The commit path's `CARRIER_REFS = 2` is exact on the sidecar branch (`workspace-sync.ts:577`) and a deliberate defensive over-count on the inline **rejection** branch (`:652`) | ACCEPT | §2.5 — "+2 (sidecar) / +1 (inline)", plus an explicit acknowledgement that summing pre-dedup per-project counts is itself an over-estimate. Both errors are fail-closed, which is why they matter now that no account cap absorbs them; test 9 |
| 7 | A legacy numeric `head` lands in the "damaged" branch: `ensureBootstrap` migrates it via `migrateNumericHead` (`workspace-sync.ts:220-226`, `:271-282`), but `isStoredHead` (`:1363-1369`) rejects a number and head mode is deliberately pre-bootstrap, so it never migrates. A healthy legacy DO would return `503 repair_required` forever — fail-closed, so no undercount, but permanently unbillable | ACCEPT | §2.6 — head mode coerces with the existing `readHead` helper (`:1372-1376`), reading a numeric `head` as `{ sequence: rawHead }` and taking `commitHash` from the `seq:<head>` envelope; plus the explicit rule that head mode must NOT call `this.sql()` (the DO's tables are created at `:217-219`); test 11 |

### Round-3 positive — §2.1's formula confirmed a SECOND time, independently

The round-3 reviewer re-derived §2.1's `refs(head)` formula from source without
reference to round 2's search and reached the same conclusion: commit admission
charges exactly `[...carriers, ...chainShas, ...dataShas]` with
`carriers = [encManifestSha, sidecarSha]` (`workspace-sync.ts:595-597`) and
`[encManifestSha, ...chainShas, ...refShas]` inline (`:648`); `readManifestChain`
excludes `encManifestSha` (`src/engine/manifest-chain.ts:11`); git sections fold
into `blobRefs` before the threshold decision (`src/cli/e2ee-remote.ts:141-155`).
**Nothing is omitted.** This is the design's single most important correctness
claim and it now has two independent verifications behind it — recorded in §2.1
of the spec, not only here.

One framing correction came with it: `blob_refs` rows are created by **UPLOAD**,
not by commit (`apps/api/migrations/0006_tenancy.sql:26-33`), so the
intersection is an *entitlement filter*, not a charge event. Commit admission
merely requires the entitlement to already exist. Folded into §2.1.

### Round-3 fold — line numbers verified against the worktree

`classifyEntitlements` `fairuse.ts:862` (cursor resume `:863-864`, `SET
active_bytes=active_bytes+?` `:893`, function `:862-897`); `cleanupAbortedPage`
`:905-941`; `verifyPinsWithEnv` `:944`, `samePin` loop `:975-982`,
`pins_verified=1` batch `:983-987`, completion UPDATE `:994` with its
`pins_verified` requirement `:1010-1015`; abort-residue query `:1058-1066`;
phase dispatch `:1104-1116`; `roots_done` DDL
`0029_storage_economics.sql:52`. `loadSidecarShaSet` `sidecar.ts:65` (`:68`,
`:70`); `refSetAt`'s call to it `workspace-sync.ts:852` (**corrected** — the
ruling said `:856`); `CARRIER_REFS` uses `:577` and `:652` (**corrected** — the
inline `MAX_REFS_PER_COMMIT` check is `:652-655`, not `:653-655`);
`ensureBootstrap` table creation `:217-219`, numeric-head branch `:220-226`,
`migrateNumericHead` `:271-282`, `isStoredHead` `:1363-1369`, `readHead`
`:1372-1376`. `readRefMode` `commit-envelope.ts:75`, inline `refShas` built
`:84-90` (the ruling said `:82-91`). `parseRefset` `src/engine/refset.ts:120`,
record layout `:5-7` and `:25-27`. `blobs.size_bytes`
`apps/api/migrations/0001_init.sql:8`; `blob_refs` DDL
`0006_tenancy.sql:26-33`. `billing.ts:162` reads `active_bytes`. Design 149's
64-statement WRITE-tick budget `149-storage-economics.md:931-939` (the "fold
ticks admit 600 … within one 64-statement budget" sentence is `:932-933`).
