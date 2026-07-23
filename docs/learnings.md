# rbox Build Learnings (append-only)

## 2026-06-30 — §23 direct-write: the 6× win, and why the "elegant" design lost to the simple one

The headline: §23 (move per-blob D1 accounting off the upload hot path) became a **6× faster
push that scales** — but ONLY after throwing away the elaborate staging→promote→present design
that 10 codex rounds had hardened. Lessons:

- **MEASURE end-to-end before believing a design.** §23 with the codex-PASSED staging/promote
  architecture was a **2.4× REGRESSION** on a real 500-file savvy-core push (41s vs 17s legacy).
  The "D1 calls 7→0" win was real but the staging→canonical **promote** (an R2 copy per new blob
  at commit) added a SERIAL O(N) phase that legacy didn't have. A synthetic 100-file test hid it
  (fixed cost dominated); the real-repo head-to-head exposed it. Unit tests + "codex PASS on the
  design" do NOT substitute for a measured head-to-head on the real corpus.
- **The promote's cost was structural, not tunable.** R2's Workers binding has no server-side
  copy, so get→put streams every byte through the worker (~560ms/blob, ~8× concurrency-capped).
  R2 S3 CopyObject (server-side, SigV4 from the worker) helped (~217ms/op, ~22× conc) — enough to
  beat legacy at 500 files (19s, 1.24×) but it STILL lost at 2000 files (137s, 0.6×) because the
  commit-promote is O(N) and serial while legacy overlaps its per-PUT D1 with the pooled uploads.
- **A second opinion reframed the whole thing.** Asked codex "how do I fix the scaling regression"
  with the measured numbers. Its answer: **stop promoting. Direct-write.** PUT writes the CANONICAL
  key directly (no staging); commit is a pure D1 batch (catalog present=1 + charge + grant). No
  copy, no serial phase. Result: **500 files 23.6s→4.6s (5.1×), 2000 files 83.6s→14.0s (6.0×) —
  the win GROWS with N.** The entire staging/promote/present/S3/reconcile apparatus existed to make
  orphan GC race-free; for a single-user system that bought nothing the existing reachability GC
  (kept quiescent) doesn't already cover. The 10-round-hardened design was **over-engineered for a
  threat model (multi-user abuse) that didn't apply**. Simpler won decisively.
- **When the user says "we're the only users," believe it.** The staging design's whole reason for
  being was bounding adversarial orphan-parking. Single-user ⇒ moot ⇒ delete the machinery.
- **Process: spend the adversarial reviewer on the PERF DECISION, not just correctness.** Codex
  caught two real data-loss bugs in the shipped §23 (promote-failure not failing the commit; cron
  canonical-GC racing the promote) when reviewed against §24, AND gave the decisive
  direct-write recommendation. Ask it "what's the best architecture given THIS measured data,"
  not only "is this correct."
- **Pre-existing bug surfaced (not §23):** a full 4294-file savvy-core round-trip is blocked by a
  shared-engine duplicate/empty/edge-content bug — `main`'s binary `sha_mismatch`es on the same
  fileset and the pull 404s a few unique-content blobs. Independent of §23 (legacy path identical).
  The duplicate-content/0-byte class from the v0.1.1 learnings, re-exposed at scale. Track + fix
  separately before claiming a clean full-savvy round-trip.

## 2026-06-30 — §23 implementation: measured the D1-off-PUT win + found the promote cost

Implemented §23 server + client, deployed to dev, measured via §25 AE. Lessons:

- **The win is real and measured: `blob.put` D1 round-trips 7 → 0, wall p50 956 ms → 126 ms
  (7.6×).** Moving accounting to commit collapsed ~539 per-blob D1 calls (100-file push) into
  ~6 batched calls. Verify server perf changes by deploying to dev + querying the §25 AE SQL API
  (`POST /accounts/{id}/analytics_engine/sql`, `CLOUDFLARE_API_TOKEN` in env) — `avg(double8)` is
  dbCalls, `quantileWeighted(0.5)(double1,_sample_interval)` is p50 ms. Unit tests can't measure this.
- **The staging→canonical promote (R2 get→put through the Worker) is the new commit bottleneck**
  (~5.5 s for ~80 blobs), and it offsets the PUT win at the total-push level for a cold first push.
  The Workers R2 binding has **no server-side copy**, so get→put streams every byte through the
  Worker. The design-noted fix (R2 **S3 `CopyObject`**, server-side, no Worker round-trip) is
  needed for the net end-to-end speedup — don't claim a total-push win until it lands. Incremental
  pushes (few new blobs) already win fully.
- **R2 get→put copy hits the Workers simultaneous-connection limit** ("Response closed due to
  connection limit") when you hold a source stream AND a dest stream open per blob at high
  concurrency. Fix: **buffer each blob (`await src.arrayBuffer()`) BEFORE the put** — the get
  stream closes first, so each task holds ONE connection at a time, letting you raise concurrency.
  (Only safe because receipts-path blobs are the small-file hot path; large files go multipart.)
- **SQLite/D1 can't `ALTER TABLE … ADD CHECK` on an existing wide table** (`accounts` has ~12
  migrated columns). Use a **`BEFORE UPDATE … WHEN … RAISE(ABORT)` trigger** instead — same
  "statement fails → `batch()` rolls back" semantics as a CHECK. Guard only INCREASES past a SET
  cap (`NEW.used > OLD.used AND NEW.cap_bytes > 0 AND NEW.used > NEW.cap`) so no-op/refund/legacy
  (cap unset) updates don't wedge. An `AFTER UPDATE OF plan` trigger auto-materializes `cap_bytes`
  so billing code needs no edits.
- **A new column with a DEFAULT only backfills EXISTING rows in the migration's explicit UPDATE;
  rows INSERTed later by app code get the column DEFAULT.** `accounts.cap_bytes` defaulted to 0 for
  new test/prod accounts → the cap trigger wedged legacy grants until account-creation set
  `cap_bytes` explicitly (+ the `cap_bytes > 0` guard as defense). Always set a new not-defaulted-
  by-plan column at every INSERT site, not just in the migration backfill.
- **Decouple "charged" from "present" with a flag, set only after the side effect lands.**
  `blob_refs` = billing (granted at the D1 batch), `blobs.present=1` = canonical confirmed (set
  after promote). Reuse/missingBlobs/head-validate gate on `present=1`. Legacy paths that write
  canonical directly must set `present=1` on their INSERT, else their blobs look absent to the new
  present-gated validation.

## 2026-06-30 — §23 upload-receipts: a 10-round adversarial design loop (codex PASS)

Designing the "move per-blob D1 accounting off the PUT hot path to commit-time" change took **ten
codex adversarial passes** to reach PASS. The value wasn't any single fix — it was that each pass
surfaced the *next* facet of one hard problem: **atomically charging + dedup-promoting a
content-addressed blob across D1 and R2, with no cross-system 2PC, while R2 has no conditional
delete.** Distilled, reusable lessons:

- **The killer constraint: R2 has no conditional delete; same-key PUT/DELETE is last-writer-wins.**
  So you can NEVER safely delete a content-addressed object that a commit might concurrently
  re-reference. Every "delete the orphan, but re-check first" scheme is a TOCTOU you can't win with
  another observation (an R2 `head` is an observation, not a lock). The fix is *structural*: a
  **staging/canonical split** — PUT writes a per-account `staging/{acct}/{sha}` key; commit
  promotes (server-side R2 copy) to the shared canonical `blobKey(sha)`; **GC deletes ONLY staging**
  (never head-reachable), and canonical is *never* deleted in-scope (dedup-GC is a separate
  quiescent sweep). Don't narrow a delete race — remove the delete from the reachable namespace.
- **Don't conflate two facts in one row.** `blob_refs` meaning both "charged" AND "bytes present"
  was the source of a whole class of bugs (entitled-but-absent reuse → dangling head; unsafe
  refunds). Split them: `blob_refs.granted_at` = billing/charged; **`blobs.present` = canonical
  confirmed (set only after promote)**. Reuse / `missingBlobs` / head-validate gate on `present=1`,
  never on entitlement alone. A `present=0` ref is *missing to every consumer*, so it can never
  enter a published head — which is exactly what makes its cleanup (revoke/refund) safe without an
  expensive head-reachability proof.
- **Ordering across the two systems is forced by two invariants you must hold simultaneously:**
  *committed head ⟹ canonical present* (so catalog/promote before head-advance) and *canonical
  present ⟹ charged* (so charge before promote). The resolution: **charge+grant in one D1 batch
  (under `CHECK(used_bytes<=cap_bytes)`, NOT-EXISTS sum for exactly-once) → promote → set
  `present=1` → advance head.** Charge-before-promote means no uncharged canonical ever exists
  (abandon-after-charge just spends the attacker's own quota, self-limiting at cap).
- **D1 batch rolls back on statement *failure*, NOT on a 0-row UPDATE.** A `CHECK` constraint is the
  right hard-quota gate (an over-cap charge *fails* the statement → whole batch rolls back); a
  conditional `WHERE used+n<=cap` that matches 0 rows does NOT abort. This single fact killed two
  earlier quota designs. (Confirm against real dev D1 in the impl spike — local SQLite isn't enough.)
- **D1 is single-threaded per database** → two same-account batches are *serialized*, so an in-SQL
  `UPDATE … WHERE NOT EXISTS(blob_refs)` charge is exactly-once without leases, RETURNING, or a DO.
  But that only bounds *concurrent* work — it does NOT bound *cumulative* abuse across crash cycles.
- **Crash-recovery reconcile must check canonical existence BEFORE refunding, and revoke atomically
  with a timestamp lease.** The textbook closure for the final TOCTOU: reconcile R2-`head`s canonical
  first (exists → adopt `present=1`, keep charge; never refund existing bytes); the grant refreshes
  `granted_at` on every reference; revoke is ONE conditional statement (`DELETE … WHERE present=0 AND
  granted_at < now-GRACE RETURNING …`) with the refund derived from *rows actually deleted*. D1
  serialization then gives grant-refresh and reconcile-delete a total order → no in-flight ref is
  ever revoked.
- **Process: spend the adversarial reviewer on the DESIGN, not just the diff.** Ten cheap design
  rounds (no code written) converged on an architecture whose invariants hold *before* implementing —
  vastly cheaper than discovering the R2-no-conditional-delete wall mid-implementation. Give the
  reviewer web access: codex grounding the D1/R2 claims in live Cloudflare docs (lifecycle ~24h
  granularity, incomplete-MPU 7-day abort, read-replication) corrected real constants — `RECEIPT_TTL`
  went from a made-up 30m to 12h (`< STAGING_GC_GRACE` ≈ 24h lifecycle floor).

## 2026-06-29 — §25 server observability: how to measure the D1 cost (and what it is)

- **Count/time D1 without threading a span through business logic: wrap the D1 *binding* in a Proxy.** `OpSpan.db(d1)` returns a Proxy where every `prepare().bind().run()/first()/all()` and `batch()` is timed + counted into the span — including calls buried inside `billing.ts`/`authz.ts` helpers. Inject it per-op via a shallow env clone (`{...env, rbox_dev_db: span.db(env.rbox_dev_db)}`, exposed as `op.env` from a `startOp()` factory). The fragile alternative (per-call-site `span.d1(() => stmt.run())`) misses the hidden helper calls — which is exactly where the cost hides. Proxy overhead is µs vs the ms-scale D1 round-trip, so it's free in practice.
- **The measured server cost (the whole reason for §25): a single `blob.put` = ~7 D1 round-trips, ~89% of its wall time.** Not the ~5 we estimated — the proxy caught the hidden `account()` SELECTs inside `wouldExceedCap`/`grantEntitlementWithQuota`. R2 is ~120ms, the DO `transactionSync` is ~0ms. So the bottleneck is **D1, not R2 and not the DO sequencer** — which is precisely what §23 (upload-receipts, move accounting to commit-time) removes. This is the before-number §23 must beat.
- **Workers Analytics Engine specifics:** `writeDataPoint` is synchronous-but-non-blocking (runtime buffers + flushes out-of-band — no `waitUntil`), never throws into the request path when wrapped, and is a **no-op when the binding is absent** (local `bun test` → nothing to mock). Columns are POSITIONAL (`doubles[]`/`blobs[]`) — keep the emitter, the schema doc, and the dashboard SQL in lock-step. Datasets **auto-create on first write** (no provisioning). Query via the SQL API: `POST https://api.cloudflare.com/client/v4/accounts/{acct}/analytics_engine/sql` with the SQL as the body + the wrangler token (it has Analytics read).
- **Unit tests CANNOT verify AE emit correctness** (the binding no-ops in tests, so a wrong op-name or a dropped emit passes green). Verify instrumentation by **deploying to dev and querying the dataset** after a real push — that's the only check that the metric actually fires with the right dimensions.
- **Privacy is a per-emit gate, not a slogan:** templated routes only (`routeTemplate` masks every id/sha/uuid via a `default: ":x"` fallthrough), coarse outcomes, and `logErr(event, e)` for error logs (never the raw `Error` — its message/stack can carry workspace/commit/device metadata). Raw error messages were also dropped from 4xx/5xx response bodies on the blob/multipart paths.

## 2026-06-29 — Dogfooding a real repo (savvy-core, 4287 files): sync perf + correctness

First real-repo test (vs the tiny e2e fixtures) exposed five issues the fixtures never could. Lesson up front: **fixtures with a handful of distinct small files hide latency-bound sequential I/O, duplicate-content collisions, and 0-byte edges. Test against a real repo early.**

- **Sequential per-blob transfer was THE bottleneck.** push uploaded blobs in a `for`-loop (one HTTP round-trip each) → ~3 blobs/sec → a 4287-file first push ≈ 20 min. pull (`applyActions`) did the same on the download side. Fix: a shared bounded worker-pool (`src/engine/pool.ts` `poolMap`, mirroring the manifest hasher) for upload (16), encrypt (8), and download (16). Fail-fast on first error; blob transfer is idempotent+resumable so a partial run just resumes. Push/pull dropped to ~tens of seconds. The lever is concurrency, NOT a queue — a Cloudflare Queue can't speed up a download the client is synchronously waiting on (Queues fit server-side async: GC of superseded blobs, usage aggregation off the commit hot path, webhook retry).
- **Content-addressed temp files collide under concurrency.** `encryptFileToTemp` named the ciphertext temp `${plaintextSha}.ct` — by CONTENT. Once encryption ran in a pool, two identical-content files (same sha — empty files, boilerplate are everywhere) wrote the SAME temp path at once → interleaved writes → upload `sha_mismatch`. Fix: unique-per-call temp name (`${sha}.${randomBytes(8)}.ct`). Any temp path keyed by content (not call) is a latent concurrency bug.
- **Duplicate-content files → duplicate blobRefs → server reject.** The commit's blobRef list was built 1:1 from files, so two files with identical content (same convergent encSha) produced a duplicate blobRef and the server's `normalizeBlobRefs` threw. blobRefs are the UNIQUE SET of blobs a commit needs (GC/billing); the file→blob mapping lives in the manifest. Dedup by encSha at build.
- **Empty (0-byte) files silently never synced.** `decryptFileToPath` computed the body range as `[0, total-TAG_BYTES-1]` = `[0,-1]` for a tag-only ciphertext, so `createReadStream` threw → `.gitkeep`/`__init__.py`/`py.typed` vanished. Fix: when content length is 0, verify the GCM tag over zero bytes and write the empty file. **Always test the 0-byte case for any encode/transform.**
- **Commit body inlines blobRefs → doesn't scale.** Each blobRef (`{encSha,size}`) is ~85B in the signed body, so a ~4k-file repo is ~350KB and blew the 256KB `MAX_COMMIT_BODY` cap. Interim: raised to 1MB (≈12k blobs, fits D1's ~2MB row limit). Real fix (scaling pass): move blobRefs OUT of the signed body (a side R2 object referenced by hash).
- **Durable Objects serve STALE code until they recycle.** After bumping `MAX_COMMIT_BODY` and `wrangler deploy`, the commit STILL failed at the old 256KB — the live DO instance kept running old code. It only picked up the new constant after ~60–75s idle (hibernation). After deploying DO code, the active instance may serve old logic briefly; force a recycle or wait before testing.
- **`login --bootstrap ""` (empty secret) blocked 10 min.** Empty string is falsy, so `if (bootstrapSecret)` fell through to the device-approval flow which waits 600s — looks hung. Guard value-less flags: `--bootstrap` with no real value now errors fast.
- **chokidar v5 `ignored` (function form) PRUNES directories — verified.** A tiny watcher test confirmed `node_modules/`+`dist/` produce ZERO events (never descended) while real files fire. So passive/watch mode scales without watching regenerable trees; the matcher must return true for the DIR form (trailing slash) which our `ignored` fn does via `stats.isDirectory()`.
- **Process win:** dogfooding found these in minutes by `diff -rq` of a real clone vs source. The first non-empty-content diff would have been a real bug; the only legitimate diffs are builtin-ignored dotfiles (`.env`, `.DS_Store`). Keep a "pull into fresh dir, diff vs source" smoke for sync work.

## 2026-06-29 — Addendum: dogfood confirms the blob/journal split

The savvy-core run rhymes with Dropbox, Git, Syncthing, and rsync: **content should stay immutable + content-addressed; mutable ordering, reachability, quota, and access accounting belong in metadata.** The fixes above should reinforce that boundary, not rewrite the design.

- **R2 blobs stay dumb and stable.** Duplicate-content files, 0-byte files, and canonical upload verification all point to the same rule: the blob address is a hash of verified bytes, never a path, sequence, owner, or temp/upload attempt.
- **Metadata carries mutability.** File path→blob mapping lives in the manifest; commit order/head lives in the DO; entitlement/quota/GC state lives in D1. Keep blobRefs as the unique blob set a commit needs, then move bulky ref lists to a hash-referenced sidecar instead of bloating the signed commit body.
- **No-oracle boundaries still hold.** Cross-account "missing" must remain indistinguishable from absent content; upload/receipt/commit-time accounting can batch work, but it cannot turn global content-addressing into a presence oracle or let metadata advance without account-scoped possession.
- **Streaming overlap and block/delta work are follow-ups, not a redesign.** Current whole-file blob sync is now viable with bounded transfer concurrency. Later prefetch/overlap, small-block batching, or rsync-style deltas should be measured protocol additions on top of the blob/journal split, not a replacement for it.

## 2026-06-27 — Billing (Stripe) + web auth (Clerk), provisioned via Stripe Projects

- **Stripe Projects (`projects.dev`) provisions OTHER services (auth/db/hosting), NOT Stripe payments for your own product.** Payments = the regular `stripe` CLI authed to your account (`stripe config --list` shows test+live keys). Don't confuse the two.
- **`stripe login` binds whatever account is ACTIVE in the dashboard, and won't cleanly bind a Sandbox.** After 3 failed attempts, the reliable path was: drop the sandbox **secret** key in a file (`/tmp/...`, never chat) and `--api-key "$(cat file)"`. `stripe sandbox create` only works no-browser when logged OUT.
- **Stripe products create JSON by default — `--json` is an unsupported flag that silently errors** (empty output under `2>/dev/null`). Resolve prices by **lookup_key** (stable across test/live), never hardcoded ids → same worker code works in both modes.
- **Stripe webhook security (codex):** parse ALL `v1` sigs (rotation), verify over raw `${t}.${body}` with the raw `t` string, **success-based idempotency** (record only after apply, so failed applies retry), and bind plan flips to the stored **customer** (an account bound to a different customer can't be hijacked). `customer_creation:always` is payment-mode-only — omit it in subscription mode.
- **Clerk session JWT verify in a Worker (raw WebCrypto):** RS256 only; JWKS host is base64-decoded from the publishable key; verify over raw `${h}.${p}` (decode only the sig); claims: exact `iss` vs a server constant, non-empty `sub`, numeric `exp`/`nbf` + 5s leeway, `azp` present AND allowlisted (reject absent for browser routes); throttle unknown-`kid` refetch; ignore token-supplied `jku`/`x5u`; guard `JSON.parse`→non-object → 401 not 500.
- **Web sessions ≠ durable device tokens.** Give web a SHORT-lived token (`devices.expires_at`, enforced in `authenticate`); the browser re-exchanges on 401. CLI tokens keep `expires_at` NULL.
- **Provisioning an account from a verified external identity (Clerk) must be race-safe + fail-closed:** run the email-verified gate BEFORE the `clerk_users` INSERT-OR-IGNORE claim, for every not-yet-mapped sub (idempotent read → no "loser skips gate" bypass); a mapping row only exists post-gate; **fail closed if the verification secret is unconfigured** (don't silently skip). Same conditional-INSERT-as-gate primitive as M7b quota / pairing.
- Process: keep secrets out of git+chat — publishable keys are public (safe to embed/record in a gitignored file); secret/live keys go via `wrangler secret put` (piped from a file, never echoed). The stripe-projects vault + `.env` are gitignored; verify `git ls-files | grep -E 'sk_|rk_live|whsec_'` is empty.


> **Process:** at the END of each milestone (after verify+commit), run an **antislop pass** (`/antislop-codebase`) — scan for AI-slop/bad patterns (oversized files, duplicated helpers, type escape-hatches, dead code) and clean them up while green, then commit separately. Keep it proportional (this is a small, modular codebase). First pass after M6 deduped the apps/api helpers into `util.ts`.


Hard-won, reusable facts discovered while building rbox. **Append only** — never rewrite history; add a new dated entry. Read this before grinding on something that smells familiar.

Format: `## YYYY-MM-DD — <short title>` then the learning + why it matters.

---

## 2026-06-26 — Autonomous build loop kickoff: tooling facts

- **Codex adversarial review is `coy exec "<prompt>"`.** `coy` is aliased to `codex --dangerously-bypass-approvals-and-sandbox`; the non-interactive subcommand is `exec` (not `--exec`). Codex emits a banner (sandbox/reasoning/session id), then hook lines, then the real answer after a `codex` marker, then a `tokens used` footer. Parse the answer from the body, not the banner. A line like `ERROR rmcp::transport::worker ... AuthorizationRequired` is just a side MCP server failing to load — harmless, ignore it.
- **Prod host `flat-meadow-prod-main-01`: bun is NOT on the non-interactive SSH PATH.** `ssh host 'which bun'` → "bun not found", but it exists at `/home/via/.bun/bin/bun` (login shells only). Always invoke bun on the host by full path, or `source ~/.bashrc`/`~/.profile` first. Same caution applies to any tool installed via a user-level installer.
- **macOS has no `timeout` command.** Use `ssh -o ConnectTimeout=N` for SSH; for general timeouts install coreutils (`gtimeout`) or rely on the tool's own flags.
- **Safety rails (carry forward every milestone):** prod host writes are confined to `~/rbox-lab`; code lives in `~/rbox-app`. Never point rbox at arbitrary prod paths. Cloudflare resources stay namespaced `rbox-dev-*`. `.env`/secrets excluded by default; opt-in sync is E2EE-only. The cleartext dev token must die at milestone 4.

## 2026-06-26 — WebSocket subprotocol facts (M1)

- **Bun's WebSocket *client* supports subprotocols** (`new WebSocket(url, ["a","b"])`) and negotiates per-RFC: it constructs fine, and on handshake **rejects with close code 1002 "Mismatch client protocol" if the server does not echo back one of the offered subprotocols.** Implication for the DO: on a successful auth it MUST respond with `Sec-WebSocket-Protocol: rbox.v1` (a value the client offered); on auth failure it must reject the upgrade outright (401, no 101) — it must NOT complete the 101 without echoing a matching protocol, or the client tears down with 1002.
- **Bun's WebSocket *server* (`server.upgrade(req, {headers:{"Sec-WebSocket-Protocol":...}})`) does NOT reliably echo the selected subprotocol** — a Bun-client↔Bun-server subprotocol handshake fails with 1002. This is a Bun-server limitation and is irrelevant to rbox (server is a Cloudflare DO, which echoes correctly), but don't waste time trying to repro the auth scheme with a Bun test server — it will mislead you. Verify against a real deployed DO instead.
- **chokidar@5.0.0 imports and runs under Bun** (`import chokidar from "chokidar"; chokidar.watch` is a function). No shim needed. NOTE: import working ≠ behavior verified — still must test add/change/unlink/atomic-save events under Bun on Linux+macOS, and set `followSymlinks:false` (chokidar defaults to true, but `scanManifest` records symlinks without following — mismatch) and `ignoreInitial:true`.
- **Bun's WebSocket client supports a custom `Authorization` header** via `new WebSocket(url, { headers: { Authorization: "Bearer ..." } })` — verified the server receives it. Because rbox's daemon is ALWAYS Bun (never a browser), this is the auth path for the `/connect` WebSocket: same bearer token as HTTP, no subprotocol echo dance, no 1002 risk. The subprotocol scheme (previous entry) is the fallback only if a browser client ever needs WS. The CF DO reads `Authorization` off the upgrade request like any header.
- **chokidar behavioral test under Bun (macOS) PASSES:** with `{followSymlinks:false, ignoreInitial:true, awaitWriteFinish:{stabilityThreshold:120,pollInterval:20}}`, add/change/unlink and atomic-save (write-temp + rename-over) all surface correctly (atomic-save shows as `change`). `awaitWriteFinish` matters — it coalesces chunked writes. Linux (prod host) confirmation still pending via remote test. This clears the M1 chokidar gate on macOS.
- **DO commit critical section must contain NO `await` on external I/O** (R2/D1). Cloudflare DO single-threading does NOT make a read-head→write-head sequence atomic if there's an `await` between them — another request interleaves at the yield. Pattern: upload manifest to R2 *first* (outside the section), then do the head re-read + parent-check + advance with synchronous SQLite-backed storage. Pre-commit R2 manifest blobs that lose the race become GC-able orphans (fine; content-addressed). **Confirmed APIs (codex, CF docs):** `ctx.storage.transactionSync(fn)` is real on SQLite-backed DOs and gives an atomic synchronous multi-key write (use it for head+seq together — not two `put`s). `ctx.storage.kv.get/put` are the synchronous KV ops. Sync ops need NO `blockConcurrencyWhile`; reserve `blockConcurrencyWhile` for ASYNC state-sensitive init — e.g. the one-time D1→DO bootstrap, run in the DO constructor so it gates all requests and two first-touch requests can't both import.

## 2026-06-26 — M3 (large-blob path) DONE & verified

- Shipped + verified live: streaming single-PUT (R2-native `{sha256}` verify, ≤90MiB), resumable R2 multipart (>90MiB), streamed download into apply. The 25MB cap is gone; a 40MB file synced Mac↔prod through the daemon. M2 is unblocked.
- **Key implementation pattern (codex code review):** multipart must assemble into a **per-upload staging key**, then publish to the canonical content-address via `bucket.put(canonicalKey, stagedObj.body, { sha256 })`. R2 verifies on that publish, so (a) the canonical object is NEVER written with unverified bytes, (b) a bad/losing/concurrent upload can't delete a good canonical blob, and (c) no JS hashing is needed at all (R2 does it both for single-PUT and the multipart republish). This replaced an unsafe "complete into canonical then verify then delete-on-mismatch" design.
- **Key the `uploads` table by `upload_id`, not by content sha** — two devices uploading the same content-addressed blob concurrently must not clobber each other's in-flight MPU. Index sha separately. Client also re-checks `missingBlobs` on a complete failure (another uploader may have finished it) and retries once from a fresh init on resume failure.
- **R2 multipart expiry doesn't surface as 404 from your own status endpoint** (which only knows D1) — add a `created_at` epoch-ms column + expiry check returning 410, GC stale rows before R2's 7-day TTL, and catch `uploadPart`/`complete` throwing (dead MPU) → 410 so the client re-inits instead of wedging.
- **R2 binding APIs that worked:** `bucket.put(key, stream, { sha256: hex })`, `bucket.createMultipartUpload(key)` → `mpu.uploadId`, `bucket.resumeMultipartUpload(key, uploadId)` (synchronous handle) → `mpu.uploadPart(n, body)` → `R2UploadedPart{partNumber, etag}`, `mpu.complete(parts)`. Streaming a file as a fetch body in Bun: `Readable.toWeb(fs.createReadStream(path, {start, end}))` + `duplex:"half"` (cast RequestInit). Stays tsc-clean under node types (no bun-types needed).

## 2026-06-26 — Cloudflare account facts + R2/Worker blob constraints (M3)

- **Account is Workers Paid** (`default_usage_model: "standard"`, Queues present incl. an existing `annotated-clip-dlq`). So: Worker CPU up to 30s (raisable to 5min), Queues available, post-complete in-Worker hashing viable for moderate sizes. (Free would be 10ms CPU — infeasible for any Worker-side hashing.)
- **Cloudflare caps inbound request body** independent of any app cap: ~100MB Pro/standard, 200 Business, 500 Ent. So `bucket.put(key, request.body)` streaming removes OUR 25MB cap but NOT CF's body cap → **multipart is mandatory for large files**, single-PUT only below ~90MB (margin under 100MB).
- **WebCrypto has no streaming digest** (confirmed) — `crypto.subtle.digest` needs the whole buffer. Avoid buffering 100s of MB. Two clean outs: (1) **R2 native integrity** — `bucket.put(key, stream, { sha256: <hex/bytes> })` makes R2 verify server-side, no JS hashing, plan-agnostic — use for single PUT; (2) for multipart, **post-complete verify** by `bucket.get` streaming the assembled object through a JS streaming SHA-256 before marking the blob present (SHA-256 is NOT composable from per-part hashes, so per-part shas can't prove the whole — this was an M3 design blocker).
- **Don't `ReadableStream.tee()` to hash+store** — the slower branch buffers unboundedly → recreates OOM. Use a single pass-through hashing TransformStream, or R2 native sha256 (preferred).
- **R2 multipart constraints:** 5 MiB min part (except last), 5 GiB max part, 10,000 max parts, uniform non-final part sizes, incomplete uploads abort after 7 days. `resumeMultipartUpload(key, uploadId)` re-instantiates an MPU across Worker invocations but does NOT validate existence — server must persist authoritative part state (`upload_parts` table), client token is just a cache. Multipart final ETag is composite/MD5-derived — never use it as the content-address; use `R2UploadedPart.etag` for `complete` only.

## 2026-06-26 — M2 (git state sync) DONE & verified cross-machine

Git-native bundle approach shipped + verified 8/8 cross-machine. Hard-won implementation lessons beyond the earlier PoC notes:
- **`git stash create` rewrites `.git/index` stat info** → the raw index-file hash is NOT a stable identity (causes phantom "changed" → echo + false conflicts). Use **`git write-tree`** (content sha of staging, ignores stat) as the staging identity; still ship the actual index file bytes for exact restore. Capture: stage the index COPY before stash-create, hash+upload the copy (TOCTOU-free).
- **macOS `/var/folders` symlinks to `/private/...`** → `git rev-parse --show-toplevel` (realpath'd) never lexically equals an un-resolved sync root. Compare `fs.realpath` of both. (Bites any user with a symlink in their root path.)
- **Only sync refs/heads, refs/tags, refs/stash** — NEVER refs/remotes (machine-local origins), refs/notes, refs/replace. Mirroring "all refs" would delete a user's local remotes on the other machine.
- **Receiver apply must be transactional:** snapshot local refs+HEAD+index+op-state BEFORE mutating; on any error or post-apply `git fsck --connectivity-only` failure, ROLL BACK. Quarantine local via `git bundle --all` first and FAIL CLOSED if quarantine fails. Restore index/HEAD/op-state via temp→rename (never a torn live `.git` file).
- **Validate the git section before applying** (HEAD format, ref names in safe namespaces, op-state paths no `..`, shas hex) — never trust a manifest off the wire to drive git commands / file writes.
- **Don't gate the RECEIVER apply on gitPreflight** — a fresh machine has no `.git` yet (applyGitState `git init`s it); preflight is a SENDER-side eligibility check.
- **Conflict = don't auto-clobber local:** import remote into `refs/rbox-conflict/<ts>/*` + a recovery bundle, keep local intact, log loudly, checkpoint base to remote to stop the pull-loop. Last-writer-wins canonical on the server, both sides recoverable.
- The whole `.git` dir stays ignore-listed for the `files` manifest; git state rides the separate `git` section orchestrated entirely in sync.ts (push capture / pull apply) so reconcile/diff/scan (M1/M3 core) are untouched.

## 2026-06-26 — Reordered M2 (.git mirroring) behind M3 (large blobs)

- Codex review of the M2 `.git`-atomic-mirroring design returned 6 BLOCKERS; the decisive one: **M2 hard-depends on M3**. Real `.git/objects/pack/*.pack` files routinely exceed the current 25MB Worker blob cap, so `.git` mirroring cannot work until the production large-blob path (presigned/multipart/streaming) exists. **Decision: build M3 first, then return to M2 with a narrowed scope.** Full blocker list + narrowed M2 scope preserved in `docs/design/02-git-mirroring.md` §10.
- Other M2 lessons banked for the redo: quiescence (`*.lock`+stability) is NOT a safety boundary (gc/repack/tmp_*/gc.pid/MIDX/commit-graph/fsmonitor/hooks hold no lock); integrity needs real `git fsck` not magic-byte checks; must upload from an immutable staged snapshot (live packs get repacked mid-upload); receiver swap needs receiver-side git quiescence + quarantine (never `rm -rf` old, a live `index.lock` op can write into it); NO hybrid carry-forward (stale `.git` + fresh tree = `git reset --hard` data loss); `.git` can be a FILE (worktrees/submodules); hooks/config are a code-exec/credential hazard → `syncGit` is a trust decision; bypass hashcache for `.git`.

## 2026-06-26 — Git-state sync mechanics (M2 v3 PoC, empirically verified)

Pivoted M2 from file-mirroring `.git` (copying a live `.git` is never atomic) to git-native capture. PoC proved the round-trip; the working recipe:
- **History:** `git bundle create out.bundle --all refs/stash` on the LIVE repo — git guarantees object/ref consistency even during concurrent writes (no quiescence needed for the object DB). `git bundle verify` on the receiver.
- **Staged/index blobs are NOT ref-reachable, so `--all` omits them** → receiver gets "missing blob" when restoring `.git/index`. FIX: `WIP=$(git stash create)` captures the full dirty+staged state as a reachable commit WITHOUT touching the stash list; `git update-ref refs/rbox-wip $WIP` then include `refs/rbox-wip` in the bundle so the index's blobs ship. Delete the temp ref after bundling.
- **Receiver can't `git fetch` into the checked-out branch** ("refusing to fetch into branch ... checked out"). FIX: `git fetch <bundle> 'refs/*:refs/rbox-incoming/*'` into a non-checked-out namespace, then publish each with `git update-ref refs/heads/<n> <sha>` (update-ref CAN move the checked-out branch's ref), then delete the incoming namespace. Restore `.git/index` and `.git/HEAD` by atomic file copy (git writes these via rename, so a copy is never torn).
- **`git stash list` reads the `refs/stash` REFLOG (`logs/refs/stash`), not just the ref** — update-ref'ing refs/stash preserves the stash COMMIT (recoverable) but leaves `git stash list` empty. Full stash fidelity needs shipping the stash reflog file too. Same for branch reflogs if wanted.
- Result with the recipe: branches + staged state identical across machines, `git fsck --connectivity-only` clean.
- Working-tree files (tracked edits + untracked) sync as NORMAL rbox files — they are NOT part of the git artifacts. The git section adds history/refs/index/HEAD/op-state only.

## 2026-06-27 — M10 (pairing tokens) — low-friction "connect a new machine"

- **A pairing token is a transferable bearer that's sufficient by itself** — so it
  needs more care than the M4 device-code (which is a two-party flow where the
  visible user_code alone can't mint). Codex security review caught the core risk:
  a create-time snapshot of account/user is NOT enough.
- **Live-revalidate authority at REDEEM, not create.** After the atomic single-use
  consume, re-check (fail-closed) that the creating device is still non-revoked AND
  the user still has a membership. Otherwise a compromised-then-revoked device's
  outstanding tokens keep minting for the TTL — defeating "revoke cuts off this
  device." Verified live: revoke creator → its token is dead at redeem.
- **Atomic single-use via `UPDATE … RETURNING`** (D1/SQLite supports it): one
  statement consumes (`WHERE consumed_at IS NULL AND expires_at > now`) and returns
  the snapshot — only the row-winning redeem proceeds. The live-authority check
  runs AFTER and fails closed (burning a token whose source is revoked is correct).
  Mint-failure-after-consume = logged availability loss, never escalation; validate
  token/label format BEFORE consuming.
- **Original rule (superseded for pairing tokens by design 184): never put a
  bearer in argv.** The canonical onboarding path now accepts the short-lived,
  single-use token in `rbox connect <pairing-token>` because setup completion is
  the higher product priority. Bare `rbox connect` retains interactive/stdin
  input. Long-lived credentials, recovery phrases, and workspace keys remain
  forbidden in argv, and pairing redemption still redacts the token from
  logs/errors.
- **Caps aren't optional for an auth-minting path:** per-account active-token cap
  (≤5 → 429) bounds a create-spam foothold even before request-rate limiting.
- **`user_id` NOT NULL + require a real membership at create** — the auth layer
  defaults a membership-less device to `viewer` (which can still READ same-account
  workspaces), so a removed user must NOT be able to mint read-capable devices.
- Pattern echo: the consume→revalidate→mint(rollback-on-fail) shape mirrors M7b's
  quota reserve and M4's one-time poll-claim — conditional-UPDATE-as-the-gate is
  the reusable D1 concurrency primitive across this codebase.

## 2026-06-27 — M9 (hardening & scale) DONE — roadmap complete

- **A benchmark earns its keep by finding the bug you didn't look for.** The
  cold-scan bench (built to "measure before optimizing") exposed an
  O(per-file-stream) cost: a 50k-file tree took >2 MINUTES. Two fixes → 2.4s
  cold / 0.76s warm: (a) `hashFile` reads files ≤1MiB whole instead of streaming
  (stream setup per tiny file dominated); (b) `walk` defers cache-miss hashing to
  a bounded-parallel batch (HASH_CONCURRENCY=16) instead of sequential awaits.
  The "do we need incremental scan?" question answered itself: no — fix the
  constant factor first.
- **Make the remote injectable to test the client's hardest logic offline.** The
  conflict-retry control flow (409→pull+rescan+retry, 422→reupload, echo-storm
  no-op) was untestable because `sync.ts` built `RboxApi` internally. A narrow
  `SyncRemote` interface + a `SyncDeps` object threaded through EVERY helper +
  the recursive retry (+ injectable no-op backoff) made it testable.
- **A fake must be a stateful SIMULATOR, not a scripted mock** (codex). `FakeRemote`
  mirrors the real DO invariants (monotonic head, parent-sequence 409, blob-
  existence 422, byte-verifying upload). Then tests assert ORACLES: "removing the
  rescan must lose the remote change," "exhausted retries never commit nor lose
  our change," "no-op makes zero commits" — these fail on real regressions, not
  on call-order.
- **Metrics go in their OWN file, never the correctness-critical state** (codex):
  `metrics.json` separate from `state.json`; a metrics write can't corrupt the
  sync base. Two distinct conflict signals: commit-level 409 retry pressure (via
  a hook, invisible to reconcile) vs reconcile file-conflicts.
- **vitest-pool-workers versions are tightly coupled to a bundled workerd.** The
  newest (0.16.x) needs vitest 4 + moved the config export; older (0.8.x) works
  with vitest 2.0.5 but bundles a workerd capped at compat 2025-07-30 that LACKS
  `ctx.storage.kv`/`transactionSync` — so the DO commit-sequencer tests 500 in
  the test runtime though they work live. Pin vitest EXACTLY (2.0.5) for 0.8.x;
  set `isolatedStorage:false`+`singleWorker:true` to dodge the D1+DO stacked-
  storage teardown assert. Net: automated the worker's auth/entitlement/quota
  paths; the DO-storage paths stay live-verified until a newer runtime lands.
- **Keep two test runners cleanly separated:** `bun test src` (bun:test, engine+
  client) vs `vitest run` in apps/api (workerd). Scope bun test to `src` so it
  never tries to run the `cloudflare:test`-importing files.

## 2026-06-26 — M8 (hydration brain) DONE — the dev-aware wedge

- **The wedge:** don't sync regenerable dep dirs (node_modules/target/.venv —
  builtin-ignored); sync the lockfile and reconstruct via the package manager.
  `detect` (pure) / `hydrate` (executor) / `doctor` (pure advisory).
- **Trust boundary (the whole milestone, per codex):** "trusted = the ARGV we
  run, untrusted = everything the synced tree supplies." We run a FIXED in-binary
  argv keyed by detected lockfile — never a string from synced content, never a
  shell. But `npm ci`/`pnpm install` themselves execute repo-controlled lifecycle
  scripts, and pip/poetry/bundler/cargo-build compile sdists/native ext = repo
  code that CAN'T be disabled. So: **lifecycle scripts off by default**
  (`--ignore-scripts` where supported), and ecosystems whose dep step inherently
  runs code (`fetchRunsCode`) are **blocked behind `--allow-build`**. `cargo
  fetch`/`go mod download`/bun-default run no repo code → auto-runnable.
- **The package-manager binary is itself an attack surface.** A synced tree can
  ship `./pnpm`, or a PATH entry can point inside the workspace. Resolve tools
  from PATH with **realpath containment**: reject the binary if its realpath — or
  the PATH dir's realpath — is inside the workspace (defeats symlinks). Verified:
  a planted malicious `./npm` first on PATH did NOT run.
- **The package manager has MORE repo-code vectors than lifecycle scripts** (codex
  v2 P1s): yarn `.yarnrc.yml` carries `yarnPath` (repo-shipped binary) AND
  `plugins` (repo .js loaded at startup) — no flag fully neutralizes plugins, so
  its presence GATES auto-run behind `--allow-build` (+ `YARN_IGNORE_PATH=1` when
  it does run). pnpm runs `.pnpmfile.cjs` even with `--ignore-scripts` → must also
  pass `--ignore-pnpmfile`. Lesson: per-manager, enumerate EVERY repo-controlled
  config/hook, not just lifecycle scripts. corepack-DOWNLOADED pinned versions
  (npm-registry-signed) are an accepted residual.
- **Containment must be checked at the moment of use:** realpath the spawn cwd and
  assert it's inside the workspace IMMEDIATELY before spawn, not via lexical
  path.join — a symlinked project dir could otherwise escape.
- **Probe versions from a NEUTRAL cwd** (`os.tmpdir`), never the project dir, so
  project-local version-manager shims (.nvmrc/.tool-versions/.npmrc) can't steer
  the probe.
- **Never silently pick among multiple lockfiles.** Multiple node lockfiles in
  one dir = `ambiguous`; resolve only via `package.json#packageManager` or
  `--manager`, else refuse. Picking one could hydrate a graph the project doesn't
  use. (Workspaces are NOT this case — they keep ONE lockfile at the root, so
  lockfile-location-driven detection is workspace-correct for free.)
- **Prefetch ≠ reconstruction:** cargo/go populate a GLOBAL cache, not `target/`/
  a workspace dir (`installDir: null`). Don't promise dir reconstruction for them.
- **Doctor stays advisory:** hard-fail missing tools / incompatible majors; WARN
  (never fail) on semver ranges too complex to cheaply decide (`minMajor → null`).
  Full semver-range satisfaction is a rabbit hole; major/minimum is the pragmatic
  line.
- Generated artifacts hydrate creates (`.pnpm-store/`, `vendor/bundle/`) must be
  added to `BUILTIN_IGNORE` or the daemon re-uploads them. (Yarn PnP `.yarn/` is
  intentionally committed by some projects → left syncable.)
- Recipes (`rbox.yml` custom commands) deliberately NOT implemented — the safest
  default is "only the inferred allowlist runs."

## 2026-06-26 — M7c (onboarding UX) DONE; zero-dep, OpenTUI deferred

- **Defer the heavy runtime; ship the pure core.** Codex confirmed OpenTUI isn't
  worth a terminal-React runtime for a 5-step linear wizard. The deliverable that
  makes a rich UI "slot in later" is NOT the readline layer — it's a **pure
  `resolveInitPlan(input) → InitPlan | InitError`** that any front-end (flags,
  readline, OpenTUI) drives. That purity is also the tight feedback loop: 12
  unit tests over the TTY×flags×creds matrix with zero process I/O.
- **A pure planner must take cwd as input, not read `process.cwd()`.** A unit
  test caught `path.resolve(flags.root)` resolving against the real cwd →
  impure. Fix: `path.resolve(input.cwd, flags.root ?? input.cwd)`. Purity is
  testable purity.
- **Headless contract (the Host-B/CI rule):** non-TTY must NEVER block on a
  prompt. `interactive = stdin.isTTY && !--no-interactive`. Auth resolution:
  creds → have; `--bootstrap <secret>` → headless one-shot login (the CI path);
  else TTY → device-code; else → `InitError` exit 2 with a copy-pasteable hint.
  **Never start a device-code wait in CI.** Verified: exit 2, no hang.
- **First-sync is new-vs-join, not "always push":** new workspace → push
  (publish); join `--workspace <id>` → SYNC (pull-first, surface conflicts) so we
  never blind-upload an arbitrary local tree over someone else's workspace.
- **chalk is unnecessary:** a ~40-line `style.ts` with one TTY/`NO_COLOR`/
  `FORCE_COLOR` gate (NO_COLOR wins; FORCE_COLOR=0 off; FORCE_COLOR is the *only*
  ANSI-when-piped exception) + separate stdout/stderr instances. Spinner writes
  to stderr, `unref()`s its interval, and `stop()` must clear the line (`\r\x1b[K`)
  or pull/sync leave a stale frame before their summary.
- **Unify device identity:** `link` used to mint a throwaway `dev_<rand>` unrelated
  to the auth device id. `init` sets the workspace deviceId = the credential's
  server-issued id (falling back to generated only for the `RBOX_TOKEN` env
  placeholder). One device, one id.
- M7b's workspace quota (free cap 1) blocked the smoke until I bootstrapped a
  FRESH account — incidental live proof that M7b enforcement works.
- Process: a v2 "NEEDS-PASS" can be pure doc-lag — codex reviews the DOC; if the
  implementation already embodies the fix (it did: `ResolvedDeviceId` union,
  shell-loads-creds), sync the doc to the code rather than re-architecting.

## 2026-06-26 — PROCESS: root cause of the recurring "codex review hangs at 0 bytes"

Two distinct causes, both now fixed — apply to EVERY `coy exec` review going forward:
1. **stdin not closed (the big one).** A backgrounded `coy exec "<prompt>"` prints
   `Reading additional input from stdin...` and blocks forever waiting for stdin
   EOF → the 0-byte hang we kept killing. **Fix: always append `< /dev/null`.**
   This is the real reason past reviews "hung," not slowness.
2. **Stale zombies serialize behind the Codex app-server.** A killed-but-unreaped
   prior `codex exec` (even one from a much earlier milestone) keeps the
   app-server busy so the new review never starts. Before launching:
   `ps aux | grep 'codex.*exec'` and `pkill -f "<old-doc-name>"` leftovers.
Canonical launch: `coy exec --dangerously-bypass-approvals-and-sandbox "$PROMPT" < /dev/null > out.txt 2>&1` (run_in_background), then poll out.txt for a LINE-START `^VERDICT:` (matching bare `VERDICT:` also matches the prompt echo). Keep prompts bounded + "Do NOT web search".

## 2026-06-26 — M7b (quotas/accounting) autonomous core DONE; Stripe needs user keys

- Built+verified (12/12) the autonomous billing core; Stripe deferred (needs the user's Stripe account + API keys → the human-intervention point).
- **Atomic, race-safe quota grant (codex review):** `INSERT OR IGNORE blob_refs` (dedups concurrent grants of the same (account,sha)); only if newly inserted, a conditional `UPDATE accounts SET used_bytes = used_bytes + size WHERE used_bytes + size <= cap` — D1 serializes per-row writes so concurrent uploads can't jointly exceed the cap (no soft overage). Over cap → delete the just-inserted blob_ref (roll back) + 402; the canonical R2 blob is left as a GC-reclaimable orphan, NEVER deleted on over-quota.
- **Charge the ACTUAL staged size** at multipart complete (`staged.size`), not the client-declared size — under-declaring would otherwise bypass quota.
- Usage is the maintained `accounts.used_bytes` counter (fast, consistent with the reserve); GC purge decrements it per entitled account before dropping blob_refs. `SUM(blob_refs ⋈ blobs)` is the reconciler.
- Quota defined as **entitlement-based** (charged for blobs you uploaded/possess, deduped within your account, freed on GC). Per-account-reachability pruning of entitlements is a follow-up.
- Avoided a circular import: `authz` does NOT import `billing` (billing imports authz's audit/Principal); the workspace-COUNT quota check lives in the worker route, not in `authz.createWorkspace`.
- Plan control until Stripe: `POST /v1/admin/account/:id/plan` (platform secret), same pattern as GC.

## 2026-06-26 — M7 (multi-tenancy & isolation) DONE

- Real accounts with enforced isolation; verified 16/16 cross-tenant + 5/5 happy-path. 3 security-review rounds.
- **The isolation primitive: blob entitlement created ONLY by hash-verified upload.** `blob_refs(account, sha)` is written on a verified `blobPut`/multipart-complete; the commit blob-existence check is **account-scoped against `blob_refs`** (not global `blobs`). So account B referencing A's sha in a manifest → 422 (unentitled) → B must upload the bytes (which it can't without possessing them). This is what makes content-addressed cross-account dedup-at-rest safe. `blobsCheck` also reports an unentitled sha as "missing" → no cross-account existence oracle.
- **Ownership at workspace CREATION, not first-commit** — `POST /v1/workspaces` assigns a high-entropy id + records `(ws, account_id)` in D1. First-commit-sets-owner was a hijack vector. `rbox link` (no `--workspace`) creates; `--workspace <id>` joins (account must own it). The DO no longer writes the workspace registry on commit.
- **Cross-account = 404 everywhere** (indistinguishable, no enumeration leak), checked BEFORE any R2/DO access; 403 reserved for same-account role failures (viewer write).
- **Platform vs tenant authz:** GC/admin require `RBOX_PLATFORM_SECRET` (header), NOT a tenant device token; roots/prune are internal-only (the public Worker router never forwards them — GC calls the DO via its binding). A tenant device hitting `/v1/admin/gc` → 404.
- **DO trusts a Worker-set `X-Rbox-Account` header** for commit's account-scoped check: safe because the DO is only reachable via the Worker (env binding, no public route) and the Worker overrides any client-supplied value after authorizing. Constructed via `new Request(req, { headers })` to clone the commit with a clean header.
- authenticate() now returns a full `Principal {deviceId, accountId, userId, role}` (joins memberships); legacy/membership-less devices get least-privilege `viewer`. Every route threads the principal; account ops (device list/revoke) are account-scoped.

## 2026-06-26 — M6 (versions + reachability GC) DONE

- Version history/restore = exposing the DO's existing per-commit `seq:<n>` pointers; restore decrypts encrypted blobs + can recover deleted files. Verified 3/3.
- **Reachability GC without a cross-DO write barrier (the key insight):** make the blob-existence check (`blobsCheck` + the DO's `missingBlobs`) treat a GC-candidate sha as **MISSING**. Then any new dedup reference is told to re-upload, and the (re)upload path deletes the candidate row → resurrects the blob BEFORE any commit can reference it. This closes the dedup/GC race that grace+recheck alone can't, with no DO coordination. Verified 9/9.
- GC rules that matter: (1) **mark from AUTHORITATIVE DO roots** (a `workspaces` D1 registry written on commit lets GC enumerate which DOs to ask; each DO returns its retained `seq→manifestSha`); **fail closed** if any DO is unreadable. (2) reachability is **GLOBAL** (blobs dedup across workspaces) and includes file `encSha??sha256` + git bundle/index/opState shas + the manifest blob shas (NOT symlink shas / git refs). (3) **never move or delete canonical R2 keys during mark** — only tag candidates; delete only at purge after grace + a fresh re-mark. (4) retention prune runs in the DO (authoritative), never prunes head.
- GC enumerates only REGISTERED workspaces → pre-registry/unregistered blobs are collectible (it self-cleaned 207 leftover test orphans — also knocks out the "wipe dev test data" housekeeping item).

## 2026-06-26 — M5 (blob-content E2EE) DONE

- Shipped opt-in convergent blob-content encryption; verified 8/8 e2e (server stores only ciphertext, keyed device decrypts, keyless locked out, dedup survives). User chose content-only scope; full-E2EE (encrypted manifest) is the documented follow-up.
- **Encryption must be self-describing from the manifest, not a local config flag.** The receiver detects encryption by `entry.encSha` in the remote manifest and loads the KEK from the keystore — relying on the device's local `encrypted` config flag fails (a device that only pulled never set the flag → skips the key → tries the plaintext-sha blob → 404). Lesson: protocol state that the other side must act on belongs IN the synced data, not in per-device local config.
- **Server blob-existence check must validate the STORED address** (`encSha ?? sha256`), not the plaintext sha — encrypted blobs live under `encSha`; checking plaintext sha would 422 every encrypted commit.
- `encSha` (ciphertext addr) is in `FileEntry` alongside `sha256` (plaintext identity); reconcile/diff/dedup still key off `sha256` (unchanged) so M1/M3 logic is untouched.
- Secrets never persisted to config: token→credential (M4), KEK→keystore (M5); `saveConfig` strips both; `loadAuthedConfig` injects at runtime.

## 2026-06-26 — M5 convergent-encryption primitive validated (PoC)

- Convergent AES-256-GCM with **HKDF-derived key AND nonce** from (KEK, plaintext_sha256) works: same plaintext+KEK → byte-identical ciphertext (so the ciphertext sha is a stable dedup address), round-trips, tampering a byte → GCM tag rejects, wrong KEK → fails, 50MB fine. Node: `hkdfSync("sha256", kek, salt, infoBytes, len)` + `createCipheriv("aes-256-gcm", dek, nonce)` + `getAuthTag()`; store `ciphertext||tag` (nonce is derived, not stored). GCM nonce-reuse is safe ONLY because distinct plaintext → distinct (DEK,nonce); never reuse a (key,nonce) across different plaintexts.
- **Large files:** GCM needs the whole input for the tag, but `createCipheriv` is a STREAM — pipe plaintext file → cipher → ciphertext temp file (append tag), then upload the temp via M3's file-based `putFile`/multipart. Decrypt: download to temp, stream through decipher holding back the last 16 bytes as the tag. Integrates with M3's file-based blob path; no whole-file buffer.
- **OPEN architecture decision (for review):** the manifest carries file PATHS + plaintext shas + sizes. The server stores the manifest → it learns that metadata even if blob *contents* are encrypted. So blob-content-encryption ≠ true E2EE. Full E2EE requires encrypting the manifest too (server stores opaque manifest blobs; DO sequences by number; blob-existence validation moves client-side). Pending codex review #4.

## 2026-06-26 — M4 (self-hosted device auth) DONE

- Replaced the shared cleartext bearer token with per-device tokens. Verified 15/15 auth-flow live + 7/7 daemon e2e via credential. Cleartext token now 401 server-side.
- **Token handoff pattern (codex security review):** `approve` ONLY marks the pending auth `approved`; the **first poll** atomically mints+returns the token via a conditional `UPDATE ... WHERE status='approved'` (→ `claimed`); `meta.changes===1` means this poll won the one-time claim. Plaintext token never stored (only sha256), returned exactly once, only to the polling (new) device.
- Tokens: CSPRNG 32-byte hex; `sha256(token)` at rest is fine for high-entropy random bearer tokens (bcrypt/argon are for human passwords). Reject malformed token length before hashing. Constant-time compare for the bootstrap secret (Workers lack node `timingSafeEqual` → hand-roll XOR-accumulate over equal-length encoded buffers).
- `last_seen_at` updated only when stale (>~10min) — avoid a D1 write per request; always READ for immediate revocation.
- Public routes must be EXACT (`/health`, `/v1/auth/device/start|poll|bootstrap`), never a wildcard `/v1/auth/device/*` (would expose `approve`). Everything else requires a valid device token.
- Client credential: `~/.rbox/credentials.json` mode 600, dir 700, per-machine (one device token for all workspaces). `RBOX_TOKEN` env overrides for CI/headless. Token is NEVER persisted in the workspace `.rbox/workspace.json` (saveConfig forces token:""); injected at runtime by `loadAuthedConfig`.
- Known M4 limitation: revoking a device doesn't force-close its live `/connect` WebSocket (notification-only, no data; all real ops re-auth per request) — hardened in M7.

## 2026-06-26 — M1 (daemon) DONE & verified cross-machine

- The full daemon shipped and is verified Mac ↔ flat-meadow-prod-main-01 against the live `rbox-dev-api` (DO deployed with `new_sqlite_classes` migration v1). Test artifacts in scratchpad (smoke.ts, e2e-local.sh, xm-e2e.sh). Results: 11/11 live control-plane, 7/7 local 2-daemon, 6/6 cross-machine, 16/16 unit.
- **Content-addressed blobs persist globally across workspaces/runs** — a smoke test asserting "commit with missing blob → 422" FALSELY failed because a prior run had already uploaded that exact content (same sha). Lesson: any test needing a genuinely-absent blob must use per-run-unique content (e.g. embed the random workspace id in the bytes). Fresh workspace ≠ fresh blobs.
- **Codex `exec` running in background saturates CPU** (xhigh, 90k–250k tokens) and made an unrelated `bun test` flake with a 5000ms timeout on the round-trip test. Isolated/idle runs are 100% stable. If tests flake with exactly-the-timeout durations while a heavy background job runs, suspect CPU starvation, not a logic bug.
- **prod host code lives in `~/rbox-app`** (rsync'd, NOT a git clone). Update it with `rsync -az --delete --exclude '._*' src/ HOST:rbox-app/src/` + `bun install`. The daemon's detached child uses `process.argv[1]` as the entry, so starting via `cd ~/rbox-app && bun src/cli/index.ts daemon start <root>` makes the child resolve `src/cli/index.ts` relative to the inherited cwd — works. chokidar confirmed working under Bun on the prod **Linux** host too (clears the Linux watcher gate).

## 2026-06-26 — DO bootstrap can't run in the constructor (name not recoverable)

- A Durable Object created via `idFromName(`${ws}/${proj}`)` **cannot recover its ws/proj string inside the DO** — the name is hashed into the id and not exposed. So the design's "bootstrap from D1 in the constructor under blockConcurrencyWhile" is impossible: the constructor doesn't know which workspace it is. Resolution that keeps the same guarantee: **lazy single-flight bootstrap** — `ensureBootstrap(ws, proj)` called at the top of each request; a memoized `bootstrapPromise` (created with no `await` between the `if (!promise)` check and the assignment, so atomic under the DO's single thread) ensures `doBootstrap` runs exactly once and all concurrent first-touch requests await the same promise. Same effect as constructor-gating (one import, requests wait), achieved where ws/proj are actually known. Pass ws/proj to the DO by keeping the original `/v1/ws/:ws/proj/:proj/...` path on the forwarded request and parsing it in the DO.

## 2026-06-26 — Build/types setup gap

- Root `tsconfig.json` has `include: ["src"]`, so `apps/api/` (the Worker/DO) was NOT typechecked by `bunx tsc --noEmit`, and `@cloudflare/workers-types` wasn't installed — the Worker had zero type coverage (wrangler/esbuild bundles without typechecking). Fixed: installed `@cloudflare/workers-types`, added `apps/api/tsconfig.json` (types: workers-types; includes `../../src/engine/manifest-validate.ts` for the shared validator). Typecheck the API with `bunx tsc -p apps/api --noEmit`. The Worker must import `manifest-validate.ts` DIRECTLY (not via the engine barrel `index.ts`) so node:fs-using modules don't get pulled into the Worker bundle.

## 2026-06-26 — Daemon performance is paramount (user directive)

- **The daemon must be invisible: O(changed) work, not O(repo) work, and always lose the scheduler race to the developer's tools.** Concrete failure to avoid: getting pegged by `npm ci`, a 50k-file `git clone` into the watched root, or bulk copies. Architecture (see design 01 §6.0):
  1. **Ignore-first watching** — watcher uses the SAME ignore matcher as the scanner, so `node_modules/`/`.git/`/`dist/` etc. emit zero events & consume zero watches. `npm ci` → no events at all. Biggest lever, free.
  2. **Event-driven incremental manifest** — hash only the changed paths the watcher reported, patch the in-memory manifest; never full-rescan on the hot path.
  3. **Periodic full scan = cheap safety net** (hashcache makes it stat-only), reconciles dropped events; rate-limited (~60s±jitter), never per-event.
  4. **Bounded-concurrency hashing/upload pools** (`min(cores,8)`) — never open 50k fds; flat memory (streaming hash, one blob at a time).
  5. **Low process priority** — `os.setPriority` (CPU) + best-effort `ionice` on Linux; the daemon never makes the laptop feel slow.
  6. **Adaptive coalescing debounce** — extend settle window during a burst (capped), don't scan a moving target.
  - This ELEVATED "scan only changed subtrees" from M9 into M1 (delivered via event-driven patching); monorepo-scale tuning of the *full* scan stays M9.

## 2026-06-30 — §24 blobRef sidecar: implement-it-anyway, and the dual-mode rollout

**Context.** After §23 shipped, a measurement pass concluded §24/§26/§27 were diminishing
returns and I recommended stopping. The directive was explicit: take EVERY backend-perf doc
through the full cycle. Lesson: when the user says "all of them," a defensible ROI argument is
worth *recording* (it's real engineering signal) but is NOT a substitute for doing the work. I
recorded the ROI finding in `perf-improvements.md` AND implemented §24. Both are valuable.

**The design predated the §23 pivot.** §24's doc was written against §23's *staging/promote*
architecture, which §23 later replaced with direct-write. The codex impl-review caught that the
sidecar resolver still described staging. Lesson: a design doc reviewed-and-passed months ago is
stale the moment a dependency pivots — re-review the design against the SHIPPED code right before
implementing, not against the code as it was when the design was written.

**Dual-mode is the safe way to change a signed, immutable, hash-chained body.** You cannot
migrate old commits (they're signed + chained). The body became a discriminated union
(`blobRefs` inline XOR `blobRefset` sidecar); `parseCommit` runs `verifyRoundTrip` (canonical
re-serialize) BEFORE the discriminator so a duplicate JSON key can't collapse two modes into one.
Old bodies are byte-unchanged → old hashes/sigs still verify. New bodies sign `sidecarSha`
explicitly — no implied/default ref set ever floats under a signature.

**Threshold-gate the new wire format to make a fail-closed rollout look transparent.** Emit the
sidecar ONLY above `SIDECAR_THRESHOLD` (4000) refs. A repo big enough to need it already exceeds
what a pre-§24 client could commit (it would blow the 1 MB body cap → 400), so "new format for
big repos only" regresses no currently-working case. Deploy server dual-mode FIRST, then ship the
client that emits it — the server understands the format before any client speaks it.

**Share the security-critical codec, duplicate nothing.** The `rbox-refset-v1` parser validates
untrusted bytes; a second copy in the Worker would drift. Put it in `src/engine/refset.ts` —
dependency-free (pure byte ops, no hashing/crypto) so it bundles into BOTH the Bun client and the
workerd Worker (added to the Worker tsconfig `include`). `import type` for any engine *type* the
Worker needs, so esbuild never drags the e2ee crypto graph into the Worker bundle.

**Parser hygiene for binary formats on the trust boundary:** bound allocation by the R2-REPORTED
object size (and the exact `18 + 40·count` length) BEFORE buffering — never by the self-declared
count; parse u64 sizes via `BigInt` and reject `> Number.MAX_SAFE_INTEGER`; `new DataView(bytes
.buffer, bytes.byteOffset, bytes.byteLength)` (NOT `new DataView(bytes.buffer)`) so a subarray
view into a larger ArrayBuffer reads the right window. GC `roots()` over sidecars must fail CLOSED
— a missing/corrupt sidecar OR a retained-seq gap aborts the WHOLE pass (condemn nothing), and
the sidecarSha is itself a GC root.

## 2026-06-30 — §26: a perf "feature" whose real win was a constant, and a knee that MOVED

Took §26 (batch-upload endpoint) through review+measurement; the answer was DON'T build it — but
the investigation surfaced a real win. Two lessons:

**A shipped tuning constant can silently go stale when a dependency changes.** The upload
concurrency default (32) was the correct knee BEFORE §23 — back then each PUT did ~7 D1 round-trips
and pushing past 32 just multiplied D1 contention. §23 moved D1 off the PUT, so the bottleneck that
PINNED the knee at 32 disappeared, and the real knee moved to ~64 (measured ~25% faster on
savvy-core). Lesson: when you remove a bottleneck, re-measure every constant that was tuned against
it. The comment even *said* "32 is the knee / risks D1 contention" — that rationale died with §23.

**Run a feature's own measurement gate before building it, and check the cheap lever first.** §26's
doc said "don't build if R2 bytes dominate"; they do (120/126 ms). A new streaming-parser endpoint
for ≤13% — when a one-line concurrency bump gets ~25% — is the §23 lesson again. Worker-side
overhead (~6 ms/PUT) is NOT the same as client-observed per-blob cost (~19 ms incl. RTT); but the
fix for the latter was more connections, not fewer requests.

## 2026-06-30 — §27 deferred; and "swept by analogy" is not swept

§27 (per-blob download capabilities to drop the entitlement D1 read on clone) — deferred again,
now by DIRECT measurement. A download-concurrency sweep on a savvy-core clone falls monotonically
32→128 (~25%) with no D1 plateau: the per-blob read §27 removes isn't the bottleneck, download
throughput is. Lesson: before building a feature to remove a cost, prove that cost is on the
critical path — a sweep of the cheap knob is far cheaper than a Merkle-inclusion-proof protocol.

The download concurrency default was 32 "by analogy with the measured upload knee, download not
yet directly swept" (literally in the comment). It had never been measured. When you tune one knob
by analogy to another, write down that it's unverified — and actually sweep it before trusting it.
Both concurrency defaults (upload AND download) turned out to be stale-low; the upload one because
§23 moved its bottleneck, the download one because it was never measured at all.

## 2026-06-30 — §28 git-sync under E2EE: the dormant feature, and where the config actually lived

Lifted the M5 "encryption + git-sync unsupported" refusal by encrypting git artifacts
(bundle/index/op-state) as convergent E2EE blobs — git-sync now works zero-knowledge + defaults on.

**The feature was DORMANT, not missing.** git-native sync (M2) shipped, then the full-E2EE
milestone made E2EE the only mode but never wired git artifacts into the encryption — so a core,
built feature was unreachable (every push threw). Lesson: when a milestone changes a global
invariant (here: "everything is encrypted"), grep for features that silently became unreachable
under it. design 05 §6 had even flagged this exact follow-up; it just never got done.

**The default lived in a different place than I first edited.** `init` routes to
`runInit`→`executeInitPlan` (init-cmd.ts), NOT the `link` case (index.ts) where I first set
`syncGit` default-on. The symptom: `workspace.json` had no `syncGit` field and git-sync silently
no-op'd despite a green typecheck + passing tests. Lesson: when a setting "doesn't take," verify
which code path actually constructs the persisted artifact (here: `executeInitPlan`, fed by
`init-plan.ts` where "all decision logic lives") — a passing build doesn't prove the right path ran.

**Verify E2EE features by grepping the SERVER's stored bytes, not just by round-trip.** A clone
succeeding proves decryption works, but the zero-knowledge claim needs the inverse: fetch every
blob the server stored and grep for known plaintext markers (commit message, branch name, file
content, filenames, `refs/heads`, git-bundle magic) — all must be ABSENT. On a real repo
(savvy-core: 762 commits, 246 tags, 17MB .git) the clone reproduced all 247 syncable refs + 585
reachable commits byte-identically, while the 5 server blobs held only ciphertext.

**Decrypt-before-mutate is the apply-atomicity rule.** Fetch+decrypt+verify ALL git artifacts into
temp files BEFORE touching `.git`; a wrong-key/corrupt/swapped blob then aborts with the local repo
untouched (proven: wrong-KEK apply → applied:false, HEAD unchanged). Inserting decryption ahead of
the existing quarantine/fsck/rollback preserves those guarantees.

**git-remote-gcrypt validates the model + names the scaling limit.** Encrypt-by-ciphertext-hash +
refs-in-the-signed-encrypted-manifest is exactly gcrypt's format. gcrypt also warns the full-bundle-
per-push model (which §28 v1 uses) re-uploads all history each git change → the future optimization
is incremental encrypted packs (gcrypt's `L:` list). Deferred until measured.

## 2026-06-30 — §28 post-impl scrutiny: two bugs my macOS e2e structurally could not catch

Adversarial scrutiny of the §28 implementation found two real bugs invisible to a green test suite
AND a passing macOS end-to-end:

**EXDEV: stage temp files on the REPO's filesystem, not os.tmpdir().** `applyGitState` decrypted
git artifacts into `os.tmpdir()` then `fs.rename`d them into `.git`. `fs.rename` throws `EXDEV`
across filesystems — and on Linux/containers `/tmp` is usually a separate mount (tmpfs) from the
repo. So git-sync would fail on EVERY pull on Linux, while passing on macOS (where `$TMPDIR` and
`/Users` share one APFS volume) — a platform-shaped blind spot. The pre-§28 code deliberately used
a temp SIBLING inside `.git`; §28 lost that. Fix: `mkdtemp` under `<root>/.rbox`. Verified on a
Linux host with the repo on a ZFS mount and TMPDIR on ext4: old mechanism = `EXDEV`, fixed = clean
clone. **Lesson: any decrypt-to-temp-then-rename-into-place must stage on the destination's fs, and
a same-fs dev box (macOS APFS) will never surface the cross-fs bug — test on a real separate mount.**

**A recovery path that's overwritten before it's used is dead code.** My 422 git-recapture set
`local.git` in the retry branch, but the recursive `pushManifest` recomputes `local.git` at the top
of every call — so the recapture was discarded (wasteful always; still looped in its target case).
Fix: thread a `forceGitRecapture` flag through the recursion so the single capture site honors it.
**Lesson: when a function recomputes state X at entry, setting X right before re-calling it is a
no-op — pass intent (a flag), not the recomputed value.**

## 2026-06-30 — §30: a feature that "fixed scaling" hid a second cap; D1 limits are about subrequests, not statements

Dogfooding a real 65k-file workspace (`~/conductor/workspaces`, 11,925 unique blobs) surfaced
`413 too_many_refs, max 6002` at COMMIT — after §24 had already made the commit body O(1). Two
distinct scaling axes wore one feature's name: §24 fixed body SIZE; the per-commit ref-ACCOUNTING
cost (one atomic D1 `batch()`, soft-capped ~6000) was untouched. **Lesson: "we fixed the scaling
problem" usually means we fixed ONE of them. Push a real workload end-to-end before believing it.**

**D1 platform limits, corrected:** codex framed the ceiling as "1000 D1 queries/invocation." The CF
docs say `batch()` is **one subrequest** (executes N statements as one txn), and the limit is ~1000
**subrequests**/invocation; the per-`batch()` ceiling is the D1 **isolate CPU/memory**. So the hog
was `validateCommitRefs` doing one round-trip per 90 refs — not the accounting batch. Fix: loop
**super-batches** (≤3000 refs, each one subrequest, cap-guarded) + **batch the validate SELECTs**.
**Lesson: verify a platform limit against the vendor docs before designing around it — "queries"
vs "subrequests" inverted which line was actually the bottleneck.**

**Scope the edge to its blast radius.** I designed an over-cap "compensation" (nonce-stamped grants
+ rollback). Codex's two BLOCKERs were BOTH in that compensation; its endorsed fix was the SIMPLE
one I'd over-engineered past — keep completed super-batches charged, idempotent retry, no rollback.
The founder's "someone pushing 250 GB of dev files has a different problem" killed the gold-plating.
**Lesson: a correctness edge (concurrent over-cap on a near-full account) deserves effort
proportional to who actually hits it. The simplest correct path is often the one the reviewer
already endorsed.** Also caught in passing: `cap_bytes=0` disabled the quota guard entirely
(`unlinkAccount` created web shells without it) — a latent quota bypass.

## 2026-06-30 — §31 (P0): a liveness bound re-checked on immutable-history replay bricks the system

THE catch of the session. Every push/pull replays the roster chain from genesis and re-checked an
admission grant's `notAfter < now` (`roster.ts`). `notAfter` is a one-time *liveness* bound
(pair_time + 10min), but replaying IMMUTABLE history has **no trustworthy append timestamp**, so it
was compared to the verifier's CURRENT clock — every time. Result: **every multi-device account
bricked ~10 minutes after pairing** (all sync threw "admission grant expired" forever). A 55-min-old
dogfood account failed in 1 second.

**Why no test caught it:** unit tests pass a fixed `now`; a fresh-account benchmark never waits
10min mid-run; the macOS same-session e2e can't age a grant past its TTL. **Only a real, AGED,
multi-device account exposes it — exactly what dogfooding provides and synthetic tests structurally
cannot.** A perf task (§30) surfaced a P0 only by trying to USE the system end-to-end.

**The fix + the model:** drop the replay-time `notAfter` check (codex: "the right fix"). Freshness
is gated where a trusted clock exists — the **pairing-token TTL at redeem** (it gates MK delivery;
a useful admission needs the master key, delivered only by the in-window single-use token), and
reuse by the single-use `grantId`. **Lesson: a liveness/expiry bound belongs at the point of
APPLICATION (where a real clock exists), never re-evaluated on replay of already-accepted immutable
history.**

**Removing a wrong check audits what it masked.** Un-bricking made a no-MK rogue-admin residual
*persist* (before, it also bricked, so it was moot). Codex MAJOR1: `epoch.ts` authorized a rotation's
signer against the roster the new state ITSELF pins (so a just-admitted device could self-authorize
its own rotation → strong DoS) — the code contradicted its own doc comment, which said "epoch e-1's
roster." Fixed to `states[e-1].rosterVersion`. **Lesson: when you delete a (wrong) guard, audit what
it was incidentally covering — the brick was hiding a latent epoch-authorization bug.** Also
hardened: scrub `mk_wrap`/`admission_grant` on redeem (TTL is an API gate, not crypto expiry).
