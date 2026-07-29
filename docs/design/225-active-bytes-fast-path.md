# 225 — Active bytes without the root walk

Status: **SELF-CERTIFIED FOR IMPLEMENTATION** (three adversarial rounds folded;
the 3-round cap is spent. §5 lists what must not be re-litigated; the ledgers
live in `docs/design/notes/225/REVIEW-LOG.md`.)
Branch: `fix/fairuse-scan-completes`

## 0. Level-set — what "helped" means

**Helped (falsifiable):** `fairuse_scans` reaches `status='complete'` with a
correct `active_bytes` for the founder's account — which has produced **12
aborted, 0 complete** — within a small bounded number of hourly invocations
(one per workspace-group, §2.5), and stays correct while the fleet keeps
committing. Today that account can never complete a scan, so
`GET /v1/account/usage` reports `activeBytes: null` and the founder ruling
"bill on active bytes, never history" has nothing to bill against.

**What could get worse:** `active_bytes` becomes a billing input — an
undercount over-credits, an overcount wrongly blocks writes, both worse than
today's honest `null`. Dropping the root walk also stops `history_bytes` and the
`bound_bytes` cap being computed. A cheap path that is subtly wrong is worse
than an expensive path that never runs, because the expensive one fails visibly.

## 1. Problem

### 1.1 The abort is real but it is NOT the main blocker

`samePin` (`apps/api/src/fairuse.ts:261`) compares `pin_head` (with
`pin_floor`, `pin_generation`, `pin_roots_format_generation`), so any commit
advancing head aborts the epoch, and the founder's fleet commits every few
minutes. **But recon falsified "fix the abort and we're done":** even with zero
aborts the scan cannot finish in useful time. `readRoots`
(`fairuse.ts:349`) hardcodes `limit: "1"` and the DO caps gap pages
at 1 (`workspace-sync.ts:35`, `ROOTS_INSPECT_GAP_PAGE_LIMIT`; enforced `:1112`),
so one page yields one `dropped_index` row, one `seq_roots` row and one gap
sequence — ~9 ticks per sequence. Throughput is
`FAIRUSE_PHASE_TICKS_PER_INVOCATION = 8` (`fairuse.ts:19`) per hourly
invocation with `FAIRUSE_ACCOUNTS_PER_TICK = 1` globally (`:9`). The founder's
`Development` workspace is at **head 1275, `pruneFloor 0`**, and
`RBOX_HISTORY_PRUNE_DISABLED=1` means the floor never advances, so the walk
grows with every commit ever made: **~1,400 hours for one workspace**, and the
account has four. That is a floor, not an estimate — `droppedPage` is keyset-
paged independently over `dropped_index` (`:1088-1091`) at the same `limit=1`,
so pages scale with `dropped_index` cardinality *as well as* `head − pruneFloor`.
Two independent blockers; the expensive one is structural.

### 1.2 Why the walk exists, and why the founder's ruling removes it

`materializeRoots` (`fairuse.ts:806`) populates `fairuse_root_membership` —
every `(sha, workspace, sequence, head)` tuple across retained history.
`classifyEntitlements` (`:862`) then walks current `blob_refs` and splits it at
`:887` (`has_head=1 ⇒ active`, else `has_membership>0 ⇒ history`). Only
`has_head` feeds `active_bytes`; the entire per-sequence walk exists to compute
`history_bytes` and, through it,
`bound_bytes = 5 * MAX(active_bytes, FAIRUSE_BOUND_FLOOR)` (`:994`, floor `:21`).

**Founder rulings (2026-07-29): bill on active bytes only, never charge
history; storing history is acceptable on rbox's side.** That retires the
fair-use bound and the prune as requirements. Everything expensive computes
something we no longer need.

### 1.3 The head ref set is already reachable cheaply

The DO already reconstructs exactly the set we want, per sequence, in
`refSetAt` (`workspace-sync.ts:841-859`), and `rootsInspect` already serialises
the same material for gap sequences (`:1113-1131`). Nothing new has to be
computed; it has to be addressed at *head* instead of walked over history.

Round-0 prod evidence is **not verifiable from the worktree** — re-run before
citing (`source ~/.secret_env_vars` for `CLOUDFLARE_API_TOKEN`):

| Claim | How to reproduce |
|---|---|
| 12 aborted, 0 complete | `npx wrangler d1 execute rbox-prod-db --remote --env production --command "SELECT status, COUNT(*) FROM fairuse_scans GROUP BY status"` |
| head 1275, pruneFloor 0 | same, `SELECT workspace_id,project_id,pin_head,pin_floor FROM fairuse_workspace_streams` |
| sidecar `58c8d82e…` is 2,050,498 B = `18 + 40 × 51,262` | `npx wrangler r2 object get rbox-dev-blobs/blobs/sha256/58/58c8d82e… --remote`, then `stat -c%s`; `18 + 40*count` is `refsetByteLength` (`src/engine/refset.ts`) |
| 0 of 51,262 shas missing from `blob_refs` | decode with `parseRefsetShaSet`, left-join `SELECT sha256 FROM blob_refs WHERE account_id=?` |

### 1.4 The as-of hazard the pins were protecting

`classifyEntitlements` joins **current** `blob_refs` against membership
materialized **at pin time** and has no `else` branch, so a ref in `blob_refs`
but absent from membership is counted as neither, silently. It also pages
`blob_refs` by ascending `sha256`, so whether a mid-scan ref counts depends on
where the cursor was when it landed: the same physical state yields different
totals. That non-determinism is what the pin check rejects. *(An inference, not
a quote: design 149 §"classify_entitlements" around
`docs/design/149-storage-economics.md:940-958` specifies the keyset paging and
completion rules but does NOT say "membership and `blob_refs` describe the same
instant". Do not cite it as if it does.)* Any design keeping a long scan window
must solve this; §2.3 shrinks the window to one workspace-group and declares
the captured snapshot authoritative.

## 2. Mechanism

### 2.1 The definition — parity with `refSetAt`, not with the sidecar

The head sidecar refset is **not** the live set, for two reasons.

**(a) Inline mode — the 100% undercount.** `SIDECAR_THRESHOLD = 4000`
(`src/cli/e2ee-remote.ts:57`), tested at `:785`. Below it there is **no
sidecar**: refs ride inline in the signed body (`RefMode`,
`apps/api/src/commit-envelope.ts:73`). A 3,999-ref workspace would have
returned **zero** active bytes.

**(b) Chain and carriers sit outside `blobRefset`.** `refSetAt` unions
`mode.refShas` (or the decoded sidecar) with
`readManifestChain(cb.manifestChain, cb.encManifestSha)`
(`src/engine/manifest-chain.ts:5`, `MAX_MANIFEST_DELTA_CHAIN = 16` at `:1`; the
returned array EXCLUDES `encManifestSha` itself — `:11` rejects a chain entry
equal to it). `gc-roots.ts:101-114` roots `manifestSha`, `carrierSha`,
`inlineRefs`, `chainRefs`, and `sidecar.sha` plus every decoded ref.

```
refs(head) = ( mode.kind === "inline" ? mode.refShas : decode(sidecar) )
           ∪ chainRefs
           ∪ { encManifestSha }
           ∪ ( mode.kind === "sidecar" ? { sidecarSha } : ∅ )

active_bytes(ws) = Σ blobs.size_bytes over refs(head) ∩ blob_refs(account)
```

**This formula is CONFIRMED COMPLETE — verified twice independently** (rounds 2
and 3, neither seeing the other's search). Commit admission requires entitlement
for exactly data refs + chain refs + `encManifestSha` + the sidecar carrier:
`workspace-sync.ts:595` builds `carriers = [encManifestSha, sidecarSha]`, and
that array is admitted as `[...carriers, ...chainShas, ...dataShas]` on BOTH
sidecar branches — `:597` under `deltaMode === "off"` and `:644` under
`shadow`/`enforce`. **Production runs `enforce`**
(`apps/api/wrangler.jsonc:194`), so `:644` is the live branch; an earlier draft
of this section cited only the `off` branch at `:595-597`. The formula is
unchanged either way — the citation was the defect, not the design. `:648` is
the inline equivalent `[encManifestSha, ...chainShas, ...refShas]`. `readManifestChain`
excludes `encManifestSha` itself (`manifest-chain.ts:11`). Git sections are NOT
a miss: `blobRefsForManifest` (`src/cli/e2ee-remote.ts:141-155`) folds
`gitSectionBlobRefs` (`src/engine/git/shared.ts:531-538`) into `blobRefs`
*before* the threshold decision at `:785`, so bundle, pack-chain, git-index and
op-state blobs are already inside `refs(head)`. It all matches gap rooting at
`gc-roots.ts:101-114`. This is the single most important correctness claim in
the design.

**`blob_refs` rows are created by UPLOAD, not by commit** — the table is an
entitlement record, created only by a hash-verified upload so that referencing
a sha cannot grant access to it (`apps/api/migrations/0006_tenancy.sql:26-33`).
Intersecting `refs(head)` with it is therefore an **entitlement filter**, not a
charge event; commit admission merely *requires* the entitlement to already
exist.

Reuse `readRefMode` (`commit-envelope.ts:75`) and `readManifestChain` rather
than re-deriving either. If a future commit shape adds a carrier, `refSetAt`
and this path must change together; test 10 asserts they agree.

**`totalBytes` is NOT a cross-check and is not used.** It is
`blobRefs.reduce((n, r) => n + r.size, 0)` (`e2ee-remote.ts:788`) — exactly Σ of
the sidecar's *member* sizes — so it EXCLUDES `encManifestSha`, chain refs and
the sidecar carrier, and comparing it against full active bytes rejects valid
totals.

### 2.2 Per-workspace sums, never a cross-workspace union

Cross-workspace dedup is **impossible by construction**, so no cross-workspace
union exists. KEKs are per workspace: `generateWorkspaceKek()` is `randomBytes(32)`
(`src/engine/e2ee/keys.ts:61-63`); the wrap is bound to its workspace
(`keys.ts:34`, `src/engine/e2ee/session.ts:86-90` — the workspaceId is in the
wrap AAD precisely so another workspace's wrap cannot be substituted;
`session.ts:157-161` generates a fresh KEK per workspace); the DEK/nonce is
`hkdfSync("sha256", kek, AAD, payloadSha, 44)` (`src/engine/crypto.ts:141-143`).
Different KEK ⇒ different DEK/nonce ⇒ different ciphertext ⇒ different `encSha`
⇒ different `blob_refs` rows.

So **per-workspace ref sets are disjoint** and the account total is a plain SUM.
Convergence exists only within one KEK scope — across the projects of one
`workspace_id`, because the fair-use stream is keyed `(workspace_id,
project_id)` (`fairuse.ts:334-343`; `migrations/0029_storage_economics.sql:41-56`)
while the KEK is keyed by `workspaceId`. Call that a **workspace-group**; dedup
applies inside a group and nowhere else.

*Caveats.* (i) `kekFromPhrase` (`crypto.ts:123-134`) can reconstruct a KEK from
a recovery phrase; one phrase installed for two workspaces would converge their
ciphertexts and double-count the SUM. No such path is known, but test 4 asserts
disjointness rather than assuming it. (ii) Within a workspace, identical
plaintext deliberately converges (`crypto.ts:12-26`) — exactly the intra-group
dedup below.

### 2.3 Where the group aggregate lives, and the as-of model

The stream table is keyed `(account_id, epoch, workspace_id, project_id)`
(`0029_storage_economics.sql:41-56`), but dedup is a property of the **group**
(`workspace_id`): a per-stream total would double-count a sha shared by two
projects of one workspace. So exactly ONE aggregate is stored per
`workspace_id`.

- **Schema — a new table, one row per group:**

  ```sql
  CREATE TABLE IF NOT EXISTS fairuse_workspace_group_totals (
    account_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    workspace_id TEXT NOT NULL,
    active_bytes INTEGER NOT NULL CHECK(active_bytes>=0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(account_id,epoch,workspace_id)
  ) WITHOUT ROWID;
  ```

- **Completion marker is row existence.** A row means the group was computed;
  no row means it was not. `active_bytes = 0` is therefore a computed zero (a
  pristine or empty workspace, §2.6) and is unambiguous — there is no NULL to
  overload and no `Number(null)` trap (§2.8).
- **The unit of work is the GROUP, never the stream.** Union all K projects'
  `refs(head)` into ONE in-memory set; intersect that set ONCE against
  `blob_refs`; write the group's row ONCE; then mark all K streams `roots_done`
  (`0029_storage_economics.sql:52`) in the SAME batch. There is no per-stream
  incremental accumulation. **`ON CONFLICT DO UPDATE SET active_bytes =
  active_bytes + …` on this table is FORBIDDEN**: under it a sha shared by two
  projects of one `workspace_id` is counted twice, which is exactly the
  double count the group table exists to prevent. The row is written once and
  never added to.
- **Account total:** `SELECT COALESCE(SUM(active_bytes),0) FROM
  fairuse_workspace_group_totals WHERE account_id=? AND epoch=?` — computed in
  D1, never accumulated in the isolate, and written to
  `fairuse_scans.active_bytes` by exactly one statement, the completion UPDATE
  (§2.12). Epoch completion additionally requires a row for every distinct
  `workspace_id` in the epoch's stream set.

The as-of model, stated once:

> Each workspace-group's contribution is as-of the head envelope its
> `/roots-inspect` response captured (§2.6). **That captured response IS the
> accepted snapshot.** There is no post-computation head re-check and no
> retry-on-head-move. The next hourly scan supersedes it.

Consequences, deliberately: a group's projects are read at slightly different
instants, and each contributes as-of its own captured head — a real state of
each project, never an interference artifact, because the terms of the account
SUM are disjoint (§2.2). `samePin`'s head comparison no longer gates anything
here — which retires the verify phase entirely (§2.12) — and each stream records
the `pin_head` it actually read as provenance for the bytes it summed. The only
surviving retry is the STALE-SIDECAR case (§2.7) — a missing input, not a moved
head. Two guards must NOT be relaxed because they concern a wrong root SET
rather than a stale one: the workspace-set aborts at `fairuse.ts:961` and
`:967`.

### 2.4 Reading the refs: one whole-object validated read per stream

**Do NOT reuse `readSidecarRecords`; do NOT build an incremental digest.** It
exists and does ranged reads (`fairuse.ts:540-578`, ranged GET `:551`), but
reusing it is neither bounded nor safe: it reads `FAIRUSE_ROOT_STAGE_ROWS = 600`
records per GET (`:11`, used at `:547`), so the founder's 51,262-ref sidecar
needs **86 GETs** and a 250,000-ref sidecar **417** — against a budget of ≤1 GET
per stream. It validates range length (`:554`), header/count (`:557-558`),
strict ascending order (`:568`) and, **on the final chunk only**, total object
length (`:577`) — but **never hashes the complete object against
`descriptor.sha`**. For a billing input, undetectable end-to-end corruption is
disqualifying.

So: **one whole-object validated read per stream**, exactly as the commit-path
readers do — and specifically **`loadSidecarShaSet`** (`sidecar.ts:65`), the
same reader `refSetAt` uses (`workspace-sync.ts:852`). It gates allocation on
`obj.size !== refsetByteLength(count)` **before** buffering (`:68`) and verifies
`sha256Hex(buf) === sidecarSha` (`:70`) — identical checks to `loadSidecarRefs`
(`:52`, `:55`, `:57`) and `loadSidecarRaw` (`:32`, `:35`, `:37`) — then strict-
parses straight to a `Set<string>`. The worst-case object is
`18 + 40 × 250,000` ≈ **10.0 MB**; one stream is in flight at a time and each is
checkpointed, so peak transient allocation is bounded and trivial against a
128 MiB isolate. Trading that 10 MB for an incremental-digest-over-ranges
mechanism would add a moving part to save nothing.

**Sizes never come from the refset bytes. `blobs.size_bytes`
(`apps/api/migrations/0001_init.sql:8`) is the SOLE size authority.** Three
independent reasons, any one of which is decisive:

- The refset record layout is `32-byte sha ‖ size u64be` for **data refs only**
  (`src/engine/refset.ts:5-7`, `:25-27`). `encManifestSha`, chain refs and the
  sidecar carrier appear in no record, so their sizes would sum as **0** —
  undercounting exactly the terms §2.1 fought to include.
- Inline mode carries no sizes at all: `readRefMode`
  (`apps/api/src/commit-envelope.ts:75`) yields `refShas: string[]` (`:84-90`).
- A refset size is **client-declared**; `blobs.size_bytes` is the server's
  recorded R2 object size. For a billing input the server's number must win.

It also avoids the 250,000-element `Ref[]` that `parseRefset`
(`src/engine/refset.ts:120`) materializes — §2.5's memory arithmetic.

### 2.5 Group cardinality, budgets, and the entitlement intersection

`MAX_REFS_PER_COMMIT = 250_000` (`apps/api/src/commit-accounting.ts:52`) bounds
**one commit** (`workspace-sync.ts:577-580` sidecar, `:653-655` inline). It does
**not** bound the union of several project heads in one workspace-group. A
legitimate group can exceed it, and calling that "a corrupt descriptor" would
fail closed on valid data. So there is exactly **one** cap —
`FAIRUSE_GROUP_REF_CAP = 250,000`, a named exported constant, **checked before
any unit of work starts**, failing closed with a distinct reason plus a metric
(§2.9), never a silent truncation.

**What it bounds, and why that number.** It bounds ONE in-memory ref set: the
group's dedup `Set<string>` of 64-hex shas at ~130 B/entry ⇒ ~33 MB at the cap,
plus the ≤10.0 MB sidecar buffer ⇒ ≈ **43 MB** peak against a 128 MiB isolate.
*(Round 2 quoted 43 MB while §2.4 still specified `loadSidecarRefs`, and that
was an understatement: `parseRefset` (`src/engine/refset.ts:120`) materializes
250,000 `{encSha,size}` objects at ~200 B/entry, a further ~50 MB, so real peak
was ~80 MB. Switching to `loadSidecarShaSet` (§2.4) deletes that array and
restores the quoted figure.)* Its subrequest side is bounded by the **Workers
per-invocation subrequest ceiling**, not by any account-level ref count: a group
costs K ≤ `FAIRUSE_MAX_WORKSPACES` = 64 (`fairuse.ts:8`) DO reads, ≤ K R2 GETs
and ≤ 49 D1 statements per tick (below) — under 200 subrequests at the cap.
**Numerically equal to `MAX_REFS_PER_COMMIT` by coincidence, not derivation.**

**There is NO account-level ref cap.** Round 2's `FAIRUSE_ACCOUNT_REFS_CAP` was
tried and deleted in round 3 — §5.8; do not re-propose it.

The group cap is evaluated from the head envelopes alone — each project's
declared ref count (`mode.count` or `mode.refShas.length`) plus
`chainRefs.length` plus **2 carriers in sidecar mode, 1 inline**
(`encManifestSha` is the only carrier when there is no sidecar; the commit
path's `CARRIER_REFS = 2` is exact on the sidecar branch,
`workspace-sync.ts:577`, and a deliberate defensive over-count on the inline
*rejection* branch, `:652`) — so an over-cap group costs K cheap DO reads and
**zero** R2 bytes. Summing pre-dedup per-project counts is itself an
over-estimate, since a group's projects may share shas. Both errors are
fail-closed — they can only reject a group that would in fact have fit — which
is precisely why they must be named now that no account cap remains to absorb
them. A metric fires at 50% of the cap so the constant is raised by
configuration long before a group wedges; the founder's largest observed refset
is 51,262, i.e. 4.9× headroom.

**The entitlement intersection is CHECKPOINTED, and needs no `IN (…)`
chunking** — so no bound-parameter ceiling is involved and nothing about one
needs verifying at implementation time. Page the account's refs in sha order,
the pattern `classifyEntitlements` already uses (`fairuse.ts:862-897`;
`FAIRUSE_ENTITLEMENT_PAGE = 2_000` at `:13`) — adding `size_bytes` when the sha
is in the group's in-memory set:

```sql
SELECT r.sha256, b.size_bytes FROM blob_refs r JOIN blobs b ON b.sha256 = r.sha256
 WHERE r.account_id = ? AND r.sha256 > ? ORDER BY r.sha256 LIMIT 2000
```

`blob_refs` has no size column (`apps/api/migrations/0006_tenancy.sql:29-33` —
`(account_id, sha256)` only), hence the join.

**Paging is bounded per tick and resumes across ticks — that is what removes the
account cap.** A tick admits at most
`FAIRUSE_ENTITLEMENT_PAGES_PER_TICK = 48` page SELECTs plus one guarded UPDATE
that advances the group's cursor and its running total: 49 statements, inside
design 149's 64-statement allowance
(`docs/design/149-storage-economics.md:931-939` gives that budget to fold and
output WRITE ticks; classify is exempted there *precisely because* it
checkpoints — `classifyEntitlements` is 2 statements per tick, resuming from
`entitlement_cursor_sha` at `fairuse.ts:863-864` and writing it at `:893-895`).
So **no statement budget scales with account `blob_refs` cardinality**: an
account of any size makes progress, one tick at a time. Round 2's
125-SELECTs-in-one-tick and its `FAIRUSE_ACTIVE_STATEMENTS_PER_TICK = 128`
declaration are deleted along with the account cap.

*Implementation note (the doc named the checkpoint but not its home).* The
resource table below counts "1 cursor + 1 totals row per group", and §2.3
forbids ever adding to the totals row — so the cursor, the running partial and
the found-ref count live in their own per-group row,
`fairuse_group_progress(account_id,epoch,workspace_id,cursor_sha,partial_bytes,
found_refs,updated_at)`, deleted in the SAME batch that writes the group's
totals row. A totals row and a progress row therefore never coexist, row
existence stays the completion marker, and no anchor-row convention returns. It
is an account-scoped working relation, so it joins the abort-residue drain,
`account-delete.ts` and `ws-purge.ts` alongside the totals table.

**Resume validity (NOT a head-stability retry).** A tick that resumes a group
must re-derive that group's in-memory ref set — 1 DO head-envelope read plus 1
R2 GET per sidecar-mode project, both idempotent and both already counted above.
Compare each envelope's current head against the `pin_head` the stream recorded
when this pass started. If it moved, **restart that group from cursor 0 against
the new snapshot**: the partial sum is discarded, never merged, so a group's
bytes always describe one consistent snapshot. This is a resume-validity check,
**not** the head-stability retry deleted in round 2 (§5.6) — for a pass that
completes inside one tick's snapshot the captured response remains the accepted
snapshot and nothing re-checks it. At the founder's real size the whole
intersection is ~38 pages, i.e. one tick, so this never engages.

**Worst case for one group at the cap:**

| Resource | Worst case | Against |
|---|---|---|
| DO subrequests | K head-envelope GETs per pass, K ≤ `FAIRUSE_MAX_WORKSPACES` = 64 (`fairuse.ts:8`) | the Workers per-invocation subrequest ceiling |
| R2 GETs | ≤ K (one whole-object read per sidecar-mode project) | ≤1 per stream |
| R2 bytes | ≤ 10.0 MB for the whole group (the group cap bounds it) | design 149's 32 MiB carrier budget |
| Isolate memory | ≈ 43 MB (≈33 MB Set + ≤10.0 MB buffer) | the 128 MiB isolate |
| D1 statements / tick | ≤ 48 page SELECTs + 1 guarded UPDATE = 49, **independent of account size** | design 149's 64/tick |
| Ticks per group | ⌈account refs / 96,000⌉ | `FAIRUSE_PHASE_TICKS_PER_INVOCATION = 8` (`:19`) |
| Checkpoints | 1 cursor + 1 totals row per group, `roots_done` per stream | — |
| Retries | ≤ 2 per stream, stale sidecar only (§2.7) | `MAX_SNAPSHOT_RETRIES = 2` (`gc-roots.ts:26`) |

At the founder's real sizes (≈75,000 account refs, 51,262-ref head) a group
costs 1 DO read + 1 R2 GET + ~38 SELECTs — one tick — so four groups finish
inside one invocation. The cap-level arithmetic is the pessimistic bound, not
the expected cost; test 9 exercises the boundary.

`present=0` blobs ARE counted, deliberately: `active_bytes` is an
**entitlement** measure, not physical residency. Dropping them would make a
catalog repair silently reduce a bill.

### 2.6 New DO surface: `/roots-inspect` head-envelope mode

**Do NOT read the head envelope from D1 `commits`.** It is an explicitly
best-effort mirror (`apps/api/migrations/0011_e2ee.sql:53-54`;
`workspace-sync.ts:111-114`), written `INSERT OR IGNORE` *after* the head
advance inside a try/catch that only calls `logErr` (`:739-746`). Bytes from a
stale mirror plus a DO-read `pin_head` means the recorded provenance does not
describe the bytes summed.

**Do NOT fix it with `/latest`.** (1) It is a POSITIONAL path (parsed at
`workspace-sync.ts:177-181`, dispatched `:189`); design 37 §4f moved
server-internal callers off positional paths because a `project_id` containing
`/` mis-parses to 404 (`:163-168`, `gc-roots.ts:70-73`), and a fail-closed
billing scan would abort *forever* on such a project. (2) It sits behind
`ensureBootstrap` (`:183`), whereas `/roots-inspect` is deliberately
pre-bootstrap and strictly read-only (`:155-161`); `/latest` would have the
hourly scan bootstrapping and arming index alarms on every dormant DO.

**Correct shape:** extend `/roots-inspect` — fixed path, slash-safe `ws`/`proj`
query params, read-only, already pin-aware (`:1064-1066`), already the endpoint
`readRoots` talks to — with a head-envelope mode (`?head=1`, no cursors)
returning ONE atomic response:

```json
{ "head": 1275, "commitHash": "…", "empty": false, "encManifestSha": "…",
  "refMode": { "kind": "inline", "refShas": ["…"] }
            | { "kind": "sidecar", "sidecarSha": "…", "count": 51262 },
  "chainRefs": ["…"], "pruneFloor": 0, "indexGeneration": 7 }
```

- Reads `head` from KV and `seq:<head>` (`:1049`, `:1115`), parsing with
  `readRefMode` + `readManifestChain` exactly as `refSetAt` and the gap page do.
  One synchronous DO read; no R2, no writes, no alarms. `409 roots_incomplete`
  on an unparseable envelope, matching `:1116`. No cursors, so
  `fromSha`/`fromSeq`/`fromGapSeq` are ignored.
- **Head mode must NOT call `this.sql()`.** The DO's SQLite tables are created
  by `ensureBootstrap` (`workspace-sync.ts:217-219`); touching them from a
  deliberately pre-bootstrap, read-only endpoint would both create schema and
  make a dormant DO do work. Everything head mode needs is in KV.
- **A legacy numeric `head` is NOT damaged.** `isStoredHead` (`:1363-1369`)
  rejects a number, so the existing reader's `:1050` check would 503 forever on
  a DO whose `head` predates the `{sequence, commitHash}` shape — and since head
  mode is pre-bootstrap, `ensureBootstrap`'s `migrateNumericHead`
  (`:220-226`, `:271-282`) never runs to fix it. That healthy legacy DO would be
  `503 repair_required` permanently: fail-closed, so no undercount, but
  permanently unbillable. Head mode therefore coerces with the existing
  `readHead` helper (`:1372-1376`), reading a numeric `head` as
  `{ sequence: rawHead }` and taking `commitHash` from the `seq:<head>` envelope
  it reads anyway. The damaged/pristine discriminator below applies only when
  `head` is neither shape.
- **Not gated on `index_state === "ready"`.** The existing reader 503s unless
  the index is ready (`:1059-1062`) because its three paged streams depend on
  the index; the head envelope does not, and gating it there would make every
  lagging DO permanently unbillable.
- Returns `head`, `pruneFloor` and `indexGeneration` in the **same** response as
  the envelope, collapsing the descriptor/pin provenance race into one read.
  This response is the accepted snapshot (§2.3).

**Empty and pristine states are ordinary, not damaged.** The existing reader
503s `uninitialized` whenever `head` is unreadable (`:1050`), which would
fail-close a brand-new workspace forever. The head mode instead reuses the
discriminator `ensureBootstrap` already applies at `:234-237` —
`headWatermark`, `pruneFloor > 0`, and `hasRetainedSeqEvidence()` (`:289-300`,
a read-only `kv.list({prefix:"seq:", limit:1})`) — writing nothing:

- **Cold / pristine** — no `head`, no `headWatermark`, `pruneFloor` absent or
  `0`, no retained `seq:` evidence ⇒ `200 { head: 0, commitHash: GENESIS_HASH
  (:1356), empty: true, refMode: null, chainRefs: [], pruneFloor: 0 }`.
  Contributes **0** bytes, recorded as a *computed* total (§2.3).
- **Damaged** — no `head` but any of `headWatermark` present, `pruneFloor > 0`,
  or retained `seq:` evidence ⇒ `503 index_unavailable { reason:
  "repair_required" }`, mirroring the `repairRequired` branch at `:238-244`.
- **Initialized but empty** — `head` is `{ sequence: 0, commitHash:
  GENESIS_HASH }` (what bootstrap writes at `:245-251`) ⇒ `200 … empty: true`,
  **not** `409 roots_incomplete` for the absent `seq:0`.
- Any other unreadable-`head` shape keeps `503 … { reason: "uninitialized" }`.

### 2.7 Stale vs corrupt — a missing sidecar must not abort forever

A blanket "missing sidecar aborts" rule reproduces the exact wedge this cycle
exists to fix. Between the head read and the R2 GET, retention can move
`pruneFloor` past the old sequence, unrooting the superseded sidecar so GC may
delete it → `loadSidecar*` returns `{ ok: false, reason: "missing" }`
(`sidecar.ts:34/54/67`) → a blanket abort would wedge an *active* account
permanently. `RBOX_HISTORY_PRUNE_DISABLED=1` masks this today, but §4 declines
to touch that flag, so the design must not depend on it.

- `reason === "missing"` ⇒ **stale**: re-read the head envelope via §2.6 once
  and retry against the new head, which becomes the accepted snapshot. Bounded
  at 2 attempts, mirroring `MAX_SNAPSHOT_RETRIES = 2` (`gc-roots.ts:26`), and
  counted in the metric (§2.9). This is the **only** retry on this path (§2.3).
- `sha256 mismatch`, size mismatch, or parse failure (`sidecar.ts:35-42`,
  `:55-62`, `:68-75`) ⇒ **corrupt**: hard abort, fail closed. These cannot be
  explained by a head advance.
- Exhausting the retry budget ⇒ abort that epoch (not the account), reason
  recorded. The next hourly scan starts clean.

### 2.8 `history_bytes` becomes optional — additively, and rollout-safe

**A NULL `history_bytes` is not available.** The columns are `INTEGER NOT NULL
DEFAULT 0` (`migrations/0029_storage_economics.sql:31-33`), so NULL needs a
table rebuild — and it would not work anyway, because
`apps/api/src/billing.ts:163` does `Number(fairUseEpoch.history_bytes)` and
`Number(null)` is `0`. **One new migration** instead adds
`fairuse_scans.history_computed INTEGER NOT NULL DEFAULT 1
CHECK(history_computed IN (0,1))`,
`fairuse_scans.entitlement_missing_count INTEGER NOT NULL DEFAULT 0` (§2.9),
and the `fairuse_workspace_group_totals` table (§2.3).

**The default must be `1`, not `0` — a rollout correctness requirement.**
`DEFAULT 0` would relabel every already-completed scan as "history uncomputed".
Those scans genuinely did compute history (`classifyEntitlements`,
`fairuse.ts:862-897`) and billing selects the latest completed row
(`idx_fairuse_scans_latest`, `0029_storage_economics.sql:36-38`), so the wrong
default would blank a correct `historyBytes` on rows that earned it. Defaulting
to `1` leaves existing rows telling the truth; the new active-only path writes
`0` explicitly.

- A completed active-only scan writes `history_computed = 0`; `history_bytes`
  stays `0` and is meaningless.
- `billing.ts:163` reports `historyBytes: null` when the flag is `0`, and
  `Number(row.history_bytes)` only when it is `1`.
- **`bound_bytes` must NOT be computed when history was not.** The completion
  UPDATE at `fairuse.ts:994` currently always writes
  `bound_bytes = 5*MAX(active_bytes, ?)`. Under `history_computed = 0` it
  writes `0`, and `billing.ts:164` reports `bound: null` via the same flag. A
  bound derived from an uncomputed history is a fabricated number.

Migration filenames are append-only; **list `apps/api/migrations/` at
implementation time and re-check after any rebase** (`README.md` there; the
`vitest.config.ts` guard fails the suite on a collision). Do not hardcode a
number from this doc — the worktree's highest is `0034_key_delivery.sql` and
`docs/STATUS.md:276` records `0033`/`0034` applied in prod, so the floor is at
least `0035`.

### 2.9 Name the anomaly surface

`fairuse.ts` imports no observability module (imports are `./env.js`,
`./db.js`, `./retention.js`, `./plans.js`, `../../../src/engine/refset.js`,
`./util.js` — lines 1-6) and emits **zero metrics in 1,151 lines**. A sha in
`refs(head)` but absent from `blob_refs` is a catalog fault that today would
vanish. Two surfaces, both required: `metric(env, name, count, bytes, outcome)`
(`gc-observability.ts:159-162`) for `fairuse.active.entitlement_missing`,
`fairuse.active.sidecar_stale_retry`, the cap 50%-warning and the fail-closed
cap aborts; **and** the persisted `fairuse_scans.entitlement_missing_count`
(§2.8), because a metric alone is not evidence when a bill is disputed — the
row that produced the number must carry its own anomaly count.

### 2.10 Billing flip is NOT in this cycle

Gating quota on `active_bytes` is **both a migration and a code change**. The
migration side is the D1 cap triggers — `accounts_cap_guard`
(`migrations/0014_upload_receipts.sql:60-66`) **and** `accounts_cap_on_insert`
plus the cap backfill (`migrations/0016_cap_bytes_insert_materialize.sql:9-22`,
`:25-32`); a flip reading only `0014` would miss half the enforcement. The code
side is `grantEntitlementWithQuota` (`billing.ts:65`), `releaseUsage` (`:113`),
`commitAccounting` (`commit-accounting.ts:162`) and `reconcileUsage`
(`gc-phase1.ts:264-279`). There is no `grantUsage`.

Unsolved sequencing worth stating now: `active_bytes` is epoch-lagged by up to
an hour, so it cannot be a synchronous admission gate on its own. A gate needs
either a live delta term on top of the last completed epoch, or `used_bytes`
retained for admission with `active_bytes` driving billing only. That belongs
to the flip's design.

### 2.11 Notes so the next reviewer does not re-derive them

- **`plan_snapshot` in `guardSql` is not an as-of hazard.** Written once at
  allocation (`fairuse.ts:420-425`); every guard compares it against the value
  read from that same row (`:315-317`). It detects a concurrent epoch.
- **Account deletion already clears all seven fairuse tables**
  (`apps/api/src/account-delete.ts:411-417`). The new columns on `fairuse_scans`
  need no deletion work, but **`fairuse_workspace_group_totals` is an eighth
  table and MUST be added to that list** — one mechanical line, and the visible
  cost §2.3 accepted in exchange for dropping the anchor-row convention.
- **The WORKSPACE purge is a second teardown site the draft missed.**
  `apps/api/src/ws-purge.ts` deletes only `commits`, `manifests`,
  `device_sync_state`, `workspace_keys`, `workspaces` and `alert_state`
  (`ws-purge.ts:37-44`), so a group-totals row — keyed by `workspace_id` — would
  outlive the workspace it measures. It must be dropped there too, and its
  residue must count toward the purge's `done` and 404 predicates, or the drain
  reports finished with rows still standing.
- **The lease TTL is 10 minutes** (`FAIRUSE_LEASE_TTL_MS`, `fairuse.ts:14`;
  renew at 5 min, `:15`); a per-group computation still runs under a lease.

### 2.12 The phase machine — what each status does after

The scan is a status machine dispatched at `fairuse.ts:1104-1116`. This design
**deletes two of its four working phases**; nothing below is optional.

| Status | Today | After |
|---|---|---|
| `capture_pins` | Enumerates the workspace set, writes `workspace_set_snapshot` and one `fairuse_workspace_streams` row per `(workspace_id, project_id)` with its pins | **Unchanged in what it does**, but its pins now come from the §2.6 head mode, not from the paged reader. `readPin` used to call `/roots-inspect` without `head=1`, which 503s `uninitialized` on a cold DO and 503s unless `index_state === "ready"` — a brand-new or lagging workspace would fail closed at CAPTURE and never reach the empty-state handling §2.6 exists to provide. It remains the source of the group partition (`workspace_id`); the group pass re-reads each head and rewrites the `pin_head` provenance for the bytes it actually summed |
| `materialize_roots` | `materializeRoots` (`:806`) walks every retained sequence into `fairuse_root_membership` / `fairuse_materialize_refs` / `fairuse_sha_last` | **Replaced** by the group pass of §2.3–§2.5: per `workspace_id`, union the K projects' `refs(head)`, intersect once against `blob_refs`, write ONE `fairuse_workspace_group_totals` row and set `roots_done=1` **and `pins_verified=1`** on all K streams in the same batch. It writes none of the three membership tables. The workspace-SET aborts (`:961`, `:967`) move here and still abort the epoch |
| `classify_entitlements` | `classifyEntitlements` (`:862`) pages `blob_refs` against membership and does `SET active_bytes=active_bytes+?,history_bytes=history_bytes+?` (`:893`) | **DELETED**, phase and function. Its intersection now lives in the group pass. Leaving the incremental `active_bytes+?` in place alongside the group totals would double-count a billing input — this is not a cleanup, it is a correctness requirement |
| verify (`verifyPinsWithEnv`, `:944`) | Re-checks the workspace set, re-reads every pin in slices of `FAIRUSE_PIN_PAGE`, and sets `pins_verified=1` (`:983-987`) | **DELETED.** With head comparison retired (§2.3) the `samePin` loop at `:975-982` only ever set a flag, so the flag moves into the group's completion batch above and the phase has nothing left to do |
| `complete` | The guarded UPDATE at `:994` sets `status='complete'`, `completed_at`, `bound_bytes=5*MAX(active_bytes,?)`; its predicate requires `pins_verified=1` on every stream (`:1010-1015`) | **The single site that writes `fairuse_scans.active_bytes`** — `active_bytes=(SELECT COALESCE(SUM(active_bytes),0) FROM fairuse_workspace_group_totals WHERE account_id=… AND epoch=…)`. Predicate additionally requires a group-totals row for every distinct `workspace_id` in the epoch |

Two details the completion UPDATE must get right:

- **Billing reads `fairuse_scans.active_bytes`** (`apps/api/src/billing.ts:162`).
  If §2.3's SUM is computed but never written to that column, billing reports
  **0**. One statement, named above, is responsible for writing it.
- **`bound_bytes` is written as a literal `0`, never
  `5*MAX(active_bytes,?)`.** §2.8 already forbids a bound derived from an
  uncomputed history, and this path never computes history. That also sidesteps
  an ordering trap: all `SET` expressions in one UPDATE evaluate against the
  **old** row, so `5*MAX(active_bytes,?)` alongside a new `active_bytes` would
  silently use the pre-update value.

**`fairuse_root_membership`, `fairuse_materialize_refs` and `fairuse_sha_last`
are no longer written, and are NOT dropped.** They stay in the schema and stay
in both the abort-residue query (`:1058-1066`) and `cleanupAbortedPage`
(`:905-941`), so an epoch aborted by the pre-deploy code path still drains
after deploy. Dropping them is a separate cleanup, valid only once no
pre-deploy epoch can exist; `account-delete.ts:411-417` keeps clearing them
either way (and gains `fairuse_workspace_group_totals`, §2.11).

## 3. Tests

`apps/api/test/fairuse-scan.test.ts:186-223` ("pin churn aborts and cleans the
incomplete epoch in bounded pages") **encodes "pin churn ⇒ abort" as the
epoch-level contract and will invert.** Rewrite it deliberately: head churn no
longer aborts or retries (§2.3); churn on the *workspace set* still aborts.

1. **Completes under churn, EXACT total.** Head advances between capture and
   completion; the scan reaches `complete` with `active_bytes` equal to an
   exactly-computed expected value — **not `> 0`** — and equal to the total
   as-of the captured snapshot, not the newer head. With 0 completed scans ever
   recorded, the old path is not a correctness reference: the test must build
   the fixture and assert the arithmetic.
2. **Inline-mode workspace** (< `SIDECAR_THRESHOLD` refs, no `blobRefset`)
   returns the correct non-zero total — the missing test that let the 100%
   undercount survive to review.
3. **Chain + carrier terms counted** — a commit with `manifestChain` entries
   and (in sidecar mode) the `sidecarSha` contributes those bytes.
4. **Intra-group dedup** — a sha shared by two *projects of one `workspace_id`*
   is counted once, and the group contributes exactly one
   `fairuse_workspace_group_totals` row carrying that deduped total.
5. **Entitlement intersection** — a sha in `refs(head)` with no `blob_refs` row
   is excluded, increments `entitlement_missing_count`, and emits the metric.
6. **Workspace-set drift still aborts** (`fairuse.ts:961`/`:967` preserved).
7. **`history_computed` semantics, including rollout.** A completed active-only
   scan has `history_computed = 0`, the usage API reports `historyBytes: null`
   and `bound: null`, and `bound_bytes` is not fabricated. Separately, a row
   inserted **before** the migration keeps `history_computed = 1` and still
   reports its real `historyBytes`.
8. **Stale vs corrupt sidecar** — `missing` retries once against the re-read
   head and then succeeds (asserting it does NOT abort); `sha256 mismatch` and
   a size mismatch abort fail-closed. Assert the retry counter.
9. **Cap boundary, fail-closed** — a group at exactly `FAIRUSE_GROUP_REF_CAP`
   completes; one ref over aborts with the distinct reason having issued no R2
   GET, and the sum is never silently truncated. Assert the pre-check counts
   **2** carriers in sidecar mode and **1** inline.
10. **Parity with `refSetAt`** — assert the set this path computes is **equal**
    to `result.refs ∪ {result.manifestSha} ∪ {result.carrierSha when non-null}`.
    Equality, not containment: a containment assertion would ratify an
    undercount, the failure mode §2.1 exists to prevent. This catches a future
    carrier added to one path and not the other. Note in the test which
    admission branch the formula it encodes corresponds to: production is
    `enforce` (`workspace-sync.ts:644`), not the `deltaMode === "off"` branch at
    `:597`.
11. **Empty-workspace states** (§2.6) — a cold/uninitialized DO returns
    `empty: true, head: 0` and writes a `fairuse_workspace_group_totals` row
    with `active_bytes = 0` (present, not absent — a computed zero); an
    initialized-but-empty DO (head `{0, GENESIS_HASH}`) likewise and does not
    `409 roots_incomplete`; a DO with `headWatermark`/`seq:` evidence but no
    `head` returns `503 repair_required`; and a DO whose `head` is a legacy
    **number** returns `200` with that sequence, not `503` (§2.6).
12. **Cross-tick intersection.** An account whose `blob_refs` exceed
    `48 × FAIRUSE_ENTITLEMENT_PAGE` completes with an exact total across
    multiple ticks — the case the deleted account cap would have wedged
    forever. Separately, a head that moves between two ticks of one group
    restarts that group from cursor 0 and yields the newer snapshot's exact
    total, never a mixture of the two.
13. **`active_bytes` reaches the billing column.** After completion,
    `fairuse_scans.active_bytes` equals `SUM(fairuse_workspace_group_totals)`
    and `GET /v1/account/usage` reports that number — the assertion that fails
    if the SUM is computed but never written. Assert `bound_bytes = 0` and that
    no stream row carries an incrementally accumulated total.

Conventions to match (`fairuse-scan.test.ts`): real D1 with
`applyD1Migrations`; `beforeEach` must tombstone every other account because the
scheduler is global and takes one account per tick; the fake `WORKSPACE_SYNC`
stub with its synthetic `/roots-inspect` and 409 behaviour, which must grow the
§2.6 head mode and its empty states; `runFairUseObservation(fakeEnv, NOW)` for
clock injection. Recon also found nothing exercising `pin_floor`/
`pin_generation` drift, the workspace-set aborts, or a ref granted mid-scan.

## 4. Non-goals

- **Not flipping billing** to `active_bytes` (§2.10).
- **Not fixing the roots-inspect `limit=1` paging.** It stays slow; this design
  removes it from the critical path. If `history_bytes` is ever needed, that
  paging is the blocker to solve then.
- **Not building any new sidecar-reading mechanism** — §2.4 uses the existing
  commit-path whole-object reader `loadSidecarShaSet` (`sidecar.ts:65`).
  Neither `readSidecarRecords` nor an incremental-digest-over-ranges scheme is
  used.
- **Not touching retention or `RBOX_HISTORY_PRUNE_DISABLED`** — but §2.7 no
  longer *depends* on that flag.
- **Not addressing** the ~24,389 refs charged but never committed on the
  founder's account (30% of its refs) — a client-side leak with its own cycle.
  Those refs are correctly excluded from `active_bytes` by construction here,
  part of why the number drops from 120.96 GB to ~3.91 GB (provenance caveat as
  in §1.3).

## 5. Settled — do not re-litigate

Three adversarial rounds have run. The full ledgers, the reversals, and every
line number verified during each fold live in
`docs/design/notes/225/REVIEW-LOG.md`; read that before reopening any decision
below, because each one already cost a round.

1. **The sidecar refset is NOT the live ref set** — inline mode (below
   `SIDECAR_THRESHOLD = 4000`) has no sidecar, so a sidecar-only algorithm
   returns **zero** for every small workspace. Use `refSetAt` parity (§2.1).
2. **Cross-workspace dedup is impossible, not merely rare** — KEKs are per
   workspace, so the account total is a plain SUM and dedup applies only inside
   a workspace-group (§2.2).
3. **The head envelope comes from the `/roots-inspect` head mode** (§2.6) —
   never the best-effort D1 `commits` mirror, never positional
   bootstrap-gated `/latest`.
4. **`readSidecarRecords` must NOT be reused** — 86 ranged GETs for the
   founder's sidecar, 417 at the cap, and no whole-object sha verification. One
   validated whole-object read per stream (§2.4).
5. **The group aggregate is its own table**, not an anchor row (§2.3).
6. **The captured DO response is the accepted snapshot** — no re-check, no
   retry on head move; the only retry is the stale sidecar (§2.3, §2.7).
7. **`history_computed` defaults to `1`**, so existing completed scans keep
   reporting the history they really computed (§2.8).
8. **An account-level ref cap was tried and DELETED — do not re-propose it.**
   Round 2's `FAIRUSE_ACCOUNT_REFS_CAP = 250,000` was circular (the cap defined
   the per-tick statement budget and the budget justified the cap; neither
   derived from a platform limit) and it would permanently wedge any account
   above ~250,000 `blob_refs` at `activeBytes: null`, never billed — the
   founder is already at ~75,000 with four workspaces, roughly a year of
   growth. Its only warning was a metric from a module that has never emitted
   one. The substrate already solved this: checkpointed cross-tick paging
   (§2.5). `FAIRUSE_GROUP_REF_CAP` survives because it bounds one in-memory
   set, which is a real isolate-memory limit.
9. **Sizes come from `blobs.size_bytes`, never from refset bytes** — refset
   records size data refs only, inline mode carries no sizes, and a
   client-declared size must not be a billing input (§2.4).
10. **The group is the unit of work.** One union, one intersection, one row,
    written once — never `active_bytes = active_bytes + …` (§2.3).
