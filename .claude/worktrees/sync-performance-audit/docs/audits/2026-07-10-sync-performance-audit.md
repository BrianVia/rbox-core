# rbox API and client sync performance audit

**Date:** 2026-07-10
**Code baseline:** v1.0.0 working tree
**Scope:** API and client sync, first publish, fresh join, and large-blob transfer
**Status:** Investigation complete; recommendations only; no implementation in this audit

## Executive summary

rbox has already shipped the obvious transport and concurrency wins. The remaining
material improvements are no longer variations of “raise the pool size.” They come
from changing the amount of work done per change, overlapping phases that are
currently serialized, and reducing local filesystem amplification.

The strongest next opportunities are:

1. Make commit admission and reference accounting O(change), rather than validating
   every reference in the workspace on every commit.
2. Stop full-workspace blob-presence checks on ordinary changed pushes.
3. Finish manifest snapshot compression and delta folding, paired with the server
   admission change above.
4. Remove foreground and daemon pull rescans by consuming the daemon’s
   watcher-maintained manifest and patching it after apply.
5. Turn first publish into an overlapping encrypt → upload → receipt-redemption
   pipeline.
6. Batch and fuse small-file crypto work inside workers, avoiding most temporary-file
   passes.
7. Prefetch Git chain artifacts within each repository and remove redundant
   directory operations during cold apply.
8. Parallelize multipart parts, while separately measuring the server’s unavoidable
   whole-object finalization pass.

The highest-confidence measured poles are:

| Workload | Current measured pole |
|---|---:|
| Clean changed commit | 8.4–8.6s commit POST |
| Ordinary changed push | 3–4s full-workspace missing preflight |
| Manifest transfer | 39.2MB on every change |
| Full 105k-file first publish | 599s total; 363s encrypt |
| Wired 96k-file fresh join | 84s total |
| Fresh-join Git materialization | approximately 34s |
| Full scan on the real workspace | 6–15s each |

The steady-sync improvements are not all additive, but together they provide a
credible path from the current roughly 42-second cross-host small-change cycle into
the 12–20-second range before daemon debounce. The initial-publish work has a
hundreds-of-seconds ceiling because encryption and upload are currently serialized.

## Method and evidence policy

This audit reviewed:

- every numbered file under docs/design;
- docs/performance-architecture-proposal.md;
- docs/perf-improvements.md;
- docs/STATUS.md and CHANGELOG.md;
- the current client sync, crypto, apply, Git, and transport implementations;
- the current Worker, Durable Object, D1 accounting, blob, and batch-transfer paths.

Several design headers are stale. The changelog and current implementation were used
as the authority for what has shipped. A recommendation is included only when its
core performance change is not present in the v1.0.0 code.

Numbers labeled “measured” come from existing project gate records. Projected
savings are explicitly estimates and must be revalidated on the fleet.

## Confirmed shipped work excluded from recommendations

The following should not be proposed again:

- upload receipts and direct canonical R2 writes;
- moving large refsets into an R2 sidecar;
- grouped D1 IN-list dispatch and large-ref accounting;
- account-scoped download grants and the D1-free grant path;
- small-blob batch GET and batch PUT;
- tuned batch defaults of 48 download slots and 24 upload slots;
- compress-before-encrypt;
- the Bun crypto worker pool;
- the first-publish encryption-address cache;
- the O(files × cache entries) encryption-cache fix;
- watcher-driven incremental daemon manifests;
- recursive Git/ignore pruning;
- incremental Git pack chains;
- repository-level parallel Git materialization;
- Git-plan fingerprint caching;
- retained-root indexing and GC availability work;
- shipped client phase instrumentation, plus the server timing fields already
  present in the current working tree.

Relevant release records:

- CHANGELOG.md:159–227 for Git-plan, encryption-cache, crypto-worker, and batch-slot
  releases.
- CHANGELOG.md:234–320 for compression, batch PUT/GET, incremental Git, and
  first-publish caching.
- docs/STATUS.md:12–28 for the current design-84/85 measurement state.

## Ranked opportunity map

### Steady sync

| Priority | Opportunity | Estimated effect | Confidence |
|---|---|---:|---|
| P0 | O(change) commit admission/accounting | save approximately 6–8s per clean push | High |
| P0 | Daemon pull narrowing and foreground delegation | save 6–15s per avoided scan | High |
| P0 | O(change) blob-presence preflight | save 3–4s per changed push | High |
| P0 | Manifest compressed snapshots and deltas | save 4.3–4.5s push and 1–3s pull | High |
| P1 | Early stale-parent and epoch rejection | save most of the 8s POST on known conflicts | High |
| P2 | Parallel head-control calls | hundreds of milliseconds | Medium |

### Initial upload

| Priority | Opportunity | Estimated effect | Confidence |
|---|---|---:|---|
| P0 | Overlap encrypt, upload, and receipt redemption | potentially minutes on the 599s publish | High structural, medium magnitude |
| P0 | Multi-file fused worker jobs | at least 30% encrypt reduction is plausible | Medium-high |
| P1 | Short-lived upload capability | single-digit to low-tens seconds | Medium |
| P1 | Parallel multipart parts | at least 2x transfer for qualifying large blobs | High, workload-specific |
| P2 | Inline transfer hashing and fewer temp files | disk/RSS improvement; wall depends on corpus | Medium |

### Initial download

| Priority | Opportunity | Estimated effect | Confidence |
|---|---|---:|---|
| P0/P1 | Prefetch Git chain and side artifacts | meaningful share of the current 34s Git phase | Medium |
| P1 | Directory-trie apply plan | remove hundreds of thousands of redundant path operations | Medium |
| P1 | Size-aware apply lanes | reduce small-file IOPS contention | Medium |
| P2 | Local plaintext source | dramatic for sibling-worktree joins, none for empty hosts | High, workload-specific |
| P2 | Read-optimized small-blob pack cache | potentially large only if R2 remains critical | Medium-low |

## Finding 1: commit admission is still O(workspace refs)

### Evidence

Design 84 measured:

- commit: 13.7s Linux / 14.9s Mac;
- commit POST: 8.6s Linux / 8.4s Mac;
- POST share: 63% Linux / 56% Mac.

See docs/design/84-manifest-delta-encoding.md:1179–1226.

The server currently:

1. fetches and buffers the complete refset sidecar;
2. verifies its hash and encoding;
3. maps it into a complete SHA array;
4. queries entitlement/presence for every SHA;
5. only then checks and advances the authoritative DO head.

Relevant code:

- apps/api/src/sidecar.ts:37–47
- apps/api/src/workspace-sync.ts:367–412
- apps/api/src/commit-accounting.ts:61–109
- apps/api/src/workspace-sync.ts:437–478

At roughly 112k refs, validateCommitRefs creates approximately 1,245 SELECT
statements and awaits about 37 sequential db.batch groups.

Current shape, abbreviated:

~~~ts
const sidecar = await resolveSidecarBytes(...);
const shas = [
  encManifestSha,
  sidecarSha,
  ...sidecar.refShas,
];

const validation = await validateCommitRefs(
  env,
  db,
  accountId,
  shas,
  receipts,
  nowMs,
);

const accounting = await commitAccounting(
  db,
  accountId,
  validation.newRefs,
  nowMs,
);

// Parent conflict is discovered only after the work above.
storage.transactionSync(() => {
  const head = readHead(storage.kv.get("head"));
  if (parent !== head.sequence) throw conflict;
  advanceHead();
});
~~~

### Recommendation

Implement a server-computed parent→child reference delta:

1. Read the authoritative parent commit from the DO.
2. Resolve and strictly validate the parent and child refsets.
3. Merge their sorted fixed-width encodings to produce additions and removals.
4. Validate and account only additions plus manifest/refset carrier blobs.
5. Preserve the complete child sidecar as the retained historical root.
6. Feed the same delta into the design-96 root index.

Illustrative merge interface:

~~~ts
interface RefDelta {
  added: RefWithSize[];
  removed: RefWithSize[];
}

function diffSortedRefsets(
  parent: Iterable<RefWithSize>,
  child: Iterable<RefWithSize>,
): RefDelta {
  // Merge two sorted streams. Do not construct two 112k-entry Sets.
  // Equal SHA: carry.
  // Parent-only: removed.
  // Child-only: added.
  return mergeDiff(parent, child);
}

const delta = diffSortedRefsets(parentRefs, childRefs);

const refsToValidate = [
  manifestCarrier,
  refsetCarrier,
  ...delta.added,
  ...carriedRefsNeedingFenceRegrant,
];

await validateAndAccount(refsToValidate);
~~~

The first implementation may still parse two complete sidecars. That leaves O(N)
Worker CPU but removes the more expensive O(N) D1 admission work. A later refset
delta representation can remove most of the R2 and parse work.

### Correctness requirements

This design must explicitly preserve:

- server-priced quota and accounting;
- idempotent receipt redemption;
- account entitlement;
- blob_ref_candidates regrant behavior;
- active gc_candidates deletion fences;
- retained history roots;
- the design-96 root-index invariants;
- bounded 422 recovery;
- the final atomic parent/epoch CAS.

Do not trust a client-authored additions list by itself. The server should compute
the delta from the authoritative parent and strictly validated child representation.

### Gate

On the fixed approximately 112k-ref workspace:

- one-file clean commit POST p50 at or below 2s;
- accounting work proportional to added refs;
- no full-ref D1 statement growth;
- identical behavior under candidate/fence/quota race tests.

## Finding 2: known-stale commits pay the complete admission cost

### Evidence

The parent and epoch checks live in the final transaction after sidecar resolution
and accounting. Conflict retries in the design-84 samples added 12–42 seconds.

Relevant code:

- apps/api/src/workspace-sync.ts:437–485
- docs/design/84-manifest-delta-encoding.md:1246–1262

### Recommendation

Add a cheap preflight after the envelope is parsed:

~~~ts
const observedHead = readHead(storage.kv.get("head"));

if (parentSequence !== observedHead.sequence) {
  return conflictResponse(observedHead.sequence);
}

if (commitEpoch !== currentEpoch) {
  return epochStaleResponse(currentEpoch);
}

// Resolve sidecar and account refs only after the cheap checks.
await admitCommitRefs();

// Keep the existing transaction check. The head may have raced.
storage.transactionSync(() => {
  assertParentAndEpochAgain();
  advanceHead();
});
~~~

Preserve the same-sequence/different-hash metric when returning early.

### Expected effect

This does not improve uncontested clean commits, but a request that was already
stale when it entered the DO should avoid nearly the entire current POST cost.

## Finding 3: ordinary pushes perform a full-workspace missing check

### Evidence

The client builds encShas from every encrypted file:

~~~ts
const encShas = local.files
  .filter((file) => file.type === "file" && file.encSha)
  .map((file) => file.encSha);

const missing = new Set(
  await api.missingBlobs(encShas),
);
~~~

Source: src/cli/sync-recovery.ts:256–260.

The API uses an uncapped req.json call and scans membership across the complete
deduplicated array:

- apps/api/src/blobs.ts:119–157
- apps/api/src/d1-batch.ts:15–58

This costs a measured 3–4 seconds per changed push on the large workspace.

### Recommendation

Build a preflight set from introduced addresses, not the complete manifest:

~~~ts
function introducedCipherAddresses(
  base: Manifest,
  next: Manifest,
): string[] {
  const carried = new Set(
    base.files
      .filter(hasCipherAddress)
      .map((file) => file.encSha),
  );

  return unique(
    next.files
      .filter(hasCipherAddress)
      .map((file) => file.encSha)
      .filter((sha) => !carried.has(sha)),
  );
}
~~~

The server’s final commit validation remains the correctness backstop. If a carried
ref has been fenced, condemned, or unexpectedly lost, return 422 and use the existing
bounded repair path.

Keep a separate full-audit mode for:

- genesis/first publish when desired;
- disaster recovery;
- remote-loss repair;
- explicit integrity verification.

The API should use the existing capped body reader, enforce a maximum SHA count, and
require chunking for full audits.

### Gate

- One-file changed push: missing count proportional to the change.
- Missing phase p50 below 500ms on the real workspace.
- Candidate and deletion-fence races still force upload/regrant.
- Full-loss recovery still converges through bounded chunks.

## Finding 4: manifest delta work remains necessary but is not sufficient

### Evidence

Every measured changed commit and pull transferred exactly 39.2MB, regardless of
whether the user change was around 100 bytes or 100KB.

Design 84’s remaining phases are:

- C1: compressed full snapshots;
- C2: O(change) manifest deltas;
- D: fold against cached local state for fast pulls.

Measured/proposed effect:

- full snapshot approximately 39.2MB → 5MB;
- ordinary deltas → kilobytes;
- approximately 4.3–4.5s removed from commit;
- latest target at or below 2s.

See docs/design/84-manifest-delta-encoding.md:1197–1236.

### Recommendation

Complete C1/C2/D, but pair the release with Finding 1. Manifest deltas do not shrink
the full reference sidecar or the server’s current full-ref admission work. Shipping
only the manifest lane leaves an approximately nine-second projected commit floor.

## Finding 5: pull and foreground sync still repeat full scans

### Evidence

Current one-shot flow:

~~~ts
export async function sync(root, cfg, deps = {}) {
  const pulled = await pull(root, cfg, deps);
  const pushed = await push(root, cfg, deps);
  return { pulled, ...pushed };
}
~~~

Both pull and push call scanManifest. The daemon also maintains an incrementally
patched manifest, yet notification-driven pull can scan before reconcile and scan
again after apply.

Measured scan cost: 6–15 seconds each.

Relevant sources:

- src/cli/sync.ts:223–245
- src/cli/sync.ts:385–407
- src/cli/sync.ts:749–760
- docs/design/39-pull-apply-optimization.md:29–60
- docs/design/85-incremental-scan.md:35–80

### Recommendation

Implement the combined design-39/design-85 shape:

1. The daemon supplies its watcher-maintained local manifest to pull.
2. Pull reconciles against that manifest rather than scanning the untouched tree.
3. Apply keeps its per-target precondition checks.
4. The daemon patches its manifest from successful actions instead of rescanning.
5. Healthy foreground push/pull/sync delegates to the daemon.
6. Safety and deep scans remain authoritative backstops.

Illustrative dependency:

~~~ts
interface PullDeps {
  trustedLocalManifest?: Manifest;
  patchManifestAfterApply?: (
    current: Manifest,
    actions: Action[],
  ) => Promise<Manifest>;
}

const local = deps.trustedLocalManifest
  ?? await scanManifest(root, matcher, cache);

const actions = reconcile(local, remote, base);
await applyActions(root, actions, store, options);

if (deps.patchManifestAfterApply) {
  daemonManifest = await deps.patchManifestAfterApply(
    daemonManifest,
    actions,
  );
}
~~~

### Gate

- Notification-driven pull of k changes performs O(k) local stat/hash work.
- Foreground delegated operation adds no more than 2s over daemon cycle wall.
- Dropped watcher events remain bounded by safety/deep-scan recovery.
- All existing conflict-copy and torn-scan guarantees remain intact.

## Finding 6: first publish is phase-serialized, not pipelined

### Evidence

The current flow is:

1. await encryption of every file;
2. await the complete missing check;
3. await upload of every missing file;
4. later, redeem receipts;
5. post commit.

Relevant source:

- src/cli/sync-recovery.ts:193–260
- src/cli/sync-recovery.ts:375–397
- src/cli/remote/commits.ts:150–205

The 105k-file benchmark measured:

- full publish: 599s;
- encrypt phase: 363s;
- only 575% peak CPU on a 32-core host.

See docs/design/81-worker-pool-crypto.md:356–369.

### Recommendation

Replace phase barriers with a byte-bounded producer-consumer pipeline:

~~~ts
const uploadQueue = new AsyncBoundedQueue<ReadyBlob>({
  maxItems: 512,
  maxBytes: 256 * MiB,
});

const encryptors = runEncryptProducers({
  files: toEncrypt,
  onReady: (blob) => uploadQueue.push(blob, blob.cipherSize),
});

const uploaders = runUploadConsumers({
  queue: uploadQueue,
  onReceipt: receiptDrainer.capture,
});

await Promise.all([
  encryptors,
  uploaders,
]);

await receiptDrainer.flush();
await commit();
~~~

Detailed behavior:

- carried descriptors are applied immediately;
- cache hits can be presence-checked while misses encrypt;
- fresh cold-cache ciphertext may be uploaded optimistically because content writes
  are idempotent;
- duplicate plaintext addresses are coalesced;
- each ciphertext temp is deleted as soon as upload settles;
- receipt redemption starts during the upload rather than after it;
- the commit waits only for the residue.

### Correctness requirements

- A source must still match the scan’s expected SHA and size.
- Per-file churn must defer only that file.
- Retried uploads must recreate or retain a valid request body.
- Receipt and accounting operations remain idempotent.
- Progress totals may grow as ciphertext sizes become known.
- Queue bounds must cover bytes, not just file count.

### Gate

Record:

- encryption service and queue wait;
- first-ciphertext-ready to first-upload-start;
- upload critical-path wall;
- receipt-redemption wall and overlap;
- temporary-disk peak;
- unique vs duplicate encryptions;
- worker CPU utilization.

The success condition should be measured on full publish wall, not just the sum of
per-file lane timings.

## Finding 7: small-file crypto still has per-job and disk-pass amplification

### Evidence

One Worker message represents one file:

- src/engine/crypto-pool.ts:185–207
- src/engine/crypto-pool.ts:309–315

For each file, encryptFileToTempInline currently:

1. copies the live source to a plaintext snapshot;
2. rereads the snapshot to hash it;
3. reads/compresses it;
4. writes ciphertext;
5. rereads ciphertext to compute encSha;
6. stats ciphertext.

Source: src/engine/crypto.ts:182–257.

The design-81 tmpfs experiment did not improve the residual. That points to per-job
runtime and syscall overhead rather than aggregate disk bandwidth.

### Recommendation

For bounded small files, submit byte-bounded multi-file jobs:

~~~ts
interface SmallEncryptBatch {
  jobs: Array<{
    path: string;
    expectedSha: string;
    expectedSize: number;
  }>;
  maxInputBytes: number;
}

interface SmallEncryptResult {
  path: string;
  plaintextSha: string;
  encSha: string;
  cipherSize: number;
  ciphertext: ArrayBuffer;
  comp?: "zstd";
  payloadSha?: string;
}
~~~

Inside each worker:

~~~ts
for (const job of batch.jobs) {
  const source = await readBounded(job.path, job.expectedSize);
  assertHashAndSize(source, job.expectedSha, job.expectedSize);

  const payload = maybeCompress(source);
  const ciphertext = encryptDeterministically(payload);
  const encSha = sha256(ciphertext);

  results.push({
    ...descriptor,
    ciphertext,
    encSha,
  });
}

postMessage(results, transferableBuffers(results));
~~~

The main process can feed those buffers directly into batch PUT without creating a
ciphertext file. Keep the existing snapshot/streaming implementation for large files
and Git artifacts.

Suggested bounds:

- cap both records and aggregate bytes per Worker job;
- keep at most one or two byte batches in flight per Worker;
- retain per-file success/failure fidelity;
- preserve byte-identical crypto output.

### Gate

- At least 30% improvement over the 363s encryption phase.
- No small-push regression.
- Higher aggregate CPU utilization without memory or FD spikes.
- Worker and inline ciphertext byte-for-byte identical.
- Full-corpus receiver diff remains clean.

## Finding 8: receipt redemption runs after all uploads

### Evidence

commitSigned invokes redeemReceipts before sending the commit:

- src/cli/remote/commits.ts:150–205

The server:

1. checks which receipts are already entitled;
2. verifies new receipt HMACs;
3. performs accounting;
4. repeats for each batch of up to 5,000.

Source: apps/api/src/workspace-sync.ts:625–684.

### Recommendation

Add a single-flight background drainer:

~~~ts
class ReceiptDrainer {
  private active?: Promise<void>;

  capture(sha: string, receipt: string): void {
    receipts.set(sha, receipt);
    if (receipts.size >= REDEEM_THRESHOLD) {
      this.kick();
    }
  }

  private kick(): void {
    if (this.active) return;
    this.active = this.drainAvailable()
      .finally(() => {
        this.active = undefined;
        if (receipts.size >= REDEEM_THRESHOLD) this.kick();
      });
  }

  async flush(): Promise<void> {
    await this.active;
    await this.drainAvailable();
  }
}
~~~

Continue deleting a receipt only if the stored value still equals the snapshot sent
to the server, matching the current race-safe behavior.

Do not build batch receipt attestations until metrics show HMAC verification rather
than D1 accounting or request dispatch is the remaining pole.

## Finding 9: batch uploads repeat full bearer authentication

### Evidence

Grant-authenticated GET and batch GET have a D1-free pre-auth path. Batch PUT does
not. Ordinary authentication performs:

- token hashing;
- directory-plane device/membership read;
- account-plane tombstone read;
- occasional last_seen write.

Source: apps/api/src/auth/authenticate.ts:25–56.

With 32 records per request, 100k unique blobs can imply approximately 3,300
authenticated batch requests. The duplicate-heavy current corpus will require fewer,
but the count remains large.

### Recommendation

Mint a short-lived HMAC upload capability at an authenticated sync/preflight call.
Bind it to:

- account ID;
- upload-receipts protocol version;
- expiry;
- strict per-request object count;
- strict per-request bytes;
- allowed route family.

Accept it only for receipt-mode batch PUT and multipart parts. Keep the delete-fence
check, receipt minting, quota, and commit accounting unchanged.

### Gate

Instrument authentication critical-path time separately from R2 write time. Build
this only if eliminating auth projects to at least several seconds on the fixed cold
publish corpus.

## Finding 10: multipart upload is serial and completion rereads the object

### Evidence

Client parts are uploaded one at a time:

~~~ts
for (let part = 1; part <= totalParts; part++) {
  if (completed.has(part)) continue;
  await uploadPart(part);
}
~~~

Source: src/cli/remote/multipart.ts:104–131.

Part size begins at 8MiB. A 2GiB object can therefore incur 256 serialized part
requests.

After assembly, the API:

1. completes the multipart object under a staging key;
2. GETs the complete staged object;
3. streams it through the Worker into the canonical key;
4. asks R2 to verify the complete SHA;
5. deletes staging.

Source: apps/api/src/blobs.ts:435–482.

### Recommendation

Run missing part numbers through a bounded pool:

~~~ts
await poolMap(
  missingPartNumbers,
  perFilePartConcurrency,
  async (partNumber) => {
    await globalMultipartSemaphore.acquire();
    try {
      await uploadPartWithRetry(partNumber);
      progress.complete(partNumber);
    } finally {
      globalMultipartSemaphore.release();
    }
  },
);
~~~

Keep:

- server-authoritative completed-parts status;
- per-part body ranges;
- idempotent retry;
- resumable token format;
- one final complete call;
- whole-object server-authoritative integrity.

Instrument part-transfer wall and complete wall independently. Parallel parts may
simply expose finalization as the next pole.

For large downloads, separately test parallel Range GETs into a sparse ciphertext
temp followed by ordered GCM/hash verification. Do not assume the ordinary
small-file corpus benefits.

## Finding 11: cold Git artifact processing is serial within each repository

### Evidence

Repository-level concurrency already shipped and reduced the Git phase to about 34s.
Inside a repository, each pack-chain link is still:

1. downloaded;
2. decrypted;
3. bundle-verified;
4. imported;
5. followed by the next link.

Source: src/engine/git/shared.ts:275–312.

Index and operation-state artifacts are fetched serially before import:

- src/engine/git/apply.ts:237–258

The design-53 chain bound permits up to roughly eight links per repository.

### Recommendation

Split acquisition from ordered import:

~~~ts
const artifacts = await boundedMap(
  links,
  artifactPrefetchConcurrency,
  (link, index) => fetchAndDecryptLink(link, index),
);

const [indexArtifact, operationArtifacts] = await Promise.all([
  fetchIndexArtifact(),
  fetchOperationArtifacts(),
]);

for (const artifact of artifacts.inChainOrder()) {
  await verifyBundle(artifact);
  await importBundle(artifact);
}
~~~

Use a global artifact semaphore across the existing repository pool so six
repositories cannot each start eight unbounded downloads/decryptions.

### Gate

First add:

- chain-length distribution;
- artifact fetch/decrypt wall;
- bundle verify wall;
- Git import wall;
- index/op-state wall.

Proceed only if fetch/decrypt is a meaningful share of the current 34s phase. If Git
import dominates, prefetch has little ceiling.

## Finding 12: fresh apply repeats directory work

### Evidence

An encrypted batch-delivered file can call recursive mkdir at three layers:

1. writeEntry before staging — src/engine/apply.ts:205–207;
2. writePayload before writing — src/cli/remote/blob-batch.ts:545–551;
3. publishAttempt before rename — src/cli/remote/blob-batch.ts:535–542.

applyActions also serially lstats every unique required ancestor before it starts the
write pool:

- src/engine/apply.ts:79–159

The previous approximately 500k per-file ancestor probe problem is already fixed.
This finding concerns the residual unique-ancestor pass and duplicate mkdir calls.

### Recommendation

Build a directory plan:

~~~ts
interface DirectoryPlan {
  prepared: Set<string>;
  obstructions: Array<{
    path: string;
    kind: "file" | "symlink";
  }>;
}

async function prepareDirectories(
  root: string,
  targetPaths: string[],
): Promise<DirectoryPlan> {
  const trie = buildDirectoryTrie(targetPaths);

  // Traverse shallowest-first.
  // If a node is absent, descendants are also absent: do not lstat them.
  // Resolve actual obstructions using the existing stage-before-displace rule.
  // Create each required directory once.

  return executeDirectoryPlan(root, trie);
}
~~~

After preparation, propagate a parentPrepared contract so writeEntry, writePayload,
and publishAttempt do not repeat mkdir.

Combine this with design 39’s size-aware scheduler:

- wide, bounded small-file lane;
- narrow streaming large-file lane;
- common overall FD/RSS budget.

### Gate

Split apply metrics into:

- ancestor preflight;
- directory creation;
- network fetch;
- ciphertext settlement;
- decrypt/write;
- target precondition;
- atomic publish.

Report mkdir/lstat/open/rename counts as well as wall time.

## Finding 13: encrypted pull still performs avoidable disk passes

### Evidence

The encrypted file path currently:

1. downloads ciphertext into a .ct temporary file;
2. hashes the ciphertext while landing it;
3. rereads the .ct file to decrypt into the plaintext staging temp;
4. rereads the plaintext staging temp to verify plaintextSha;
5. removes the .ct file.

Sources:

- src/engine/apply.ts:264–288
- src/engine/crypto.ts:283–335
- docs/design/36-blob-transfer-pipeline.md:28–69

Abbreviated current shape:

~~~ts
await store.getToFile(entry.encSha, ciphertextTemp);
await decryptFileToPath(
  ciphertextTemp,
  kek,
  entry.sha256,
  plaintextTemp,
);
await remove(ciphertextTemp);
~~~

### Recommendation

Stream network ciphertext through one deep staging primitive:

~~~ts
async function stageEncryptedBlob(
  responseBody: ReadableStream<Uint8Array>,
  expectedEncSha: string,
  expectedPlainSha: string,
  destinationTemp: string,
): Promise<void> {
  const cipherHash = createHash("sha256");
  const plainHash = createHash("sha256");
  const tagTail = new RollingTailBuffer(16);

  for await (const networkChunk of responseBody) {
    cipherHash.update(networkChunk);

    for (const bodyChunk of tagTail.push(networkChunk)) {
      const plaintext = decipher.update(bodyChunk);
      plainHash.update(plaintext);
      await destination.write(plaintext);
    }
  }

  decipher.setAuthTag(tagTail.final());
  const finalPlaintext = decipher.final();
  plainHash.update(finalPlaintext);
  await destination.write(finalPlaintext);

  assertDigest(cipherHash, expectedEncSha);
  assertDigest(plainHash, expectedPlainSha);
}
~~~

Compressed files insert bounded zstd decompression between decipher output and the
plaintext hash/write. The primitive still returns a verified plaintext temp; apply
retains ownership of preconditions, conflict preservation, and atomic publication.

This removes the ciphertext temp and the final plaintext reread. It should be folded
into the same deep transfer module as the upload pipeline.

### Priority caveat

Design 81’s current full-join gate put decrypt+write near 1% of wall after the Worker
pool shipped. Therefore this is not a top speed project for the present source-heavy
corpus. It is more valuable for:

- very large blobs;
- disk-constrained agents;
- reducing temporary-disk peak;
- future paths where network/Git poles have already fallen.

Build it after measuring the current lane again, or as part of the larger upload
pipeline where the module consolidation already pays for itself.

## Finding 14: local plaintext can satisfy some “initial” joins

### Evidence

Design 52 identifies a common new-worktree case where thousands of intended remote
files already exist byte-identically in sibling worktrees. Current pull still GETs and
decrypts them.

Source: docs/design/52-local-blob-source.md.

### Recommendation

For a matching plaintext SHA:

1. reflink/copy the local source to the normal staging temp;
2. hash the temp;
3. publish atomically only on a match;
4. fall back per-file to GET+decrypt on any error.

This is a hint, never a trust source. It does not help a truly empty host. Rebenchmark
under the current batch transport rather than relying on the old request model.

## Finding 15: a read-optimized pack cache is conditional, not the next default

### Evidence

Batch GET reduced a fresh join from roughly 93k HTTP requests to about 3k, and tuning
48 download slots produced an 84s wired join. The API still performs one R2 GET and
body read per SHA:

- apps/api/src/blob-batch.ts:181–241

A small-blob pack mirror could collapse many R2 reads, but it introduces duplicate
storage, indexing, lifecycle, repair, and GC complexity.

### Recommendation

Before designing packs, measure:

- server R2 critical-path wall, not additive storeMs across parallel requests;
- client network wait;
- filesystem apply;
- Git phase;
- effective wire throughput.

The pack cache prize is bounded by the measured R2 portion of the approximately 50s
remaining outside the current 34s Git phase. If R2 is not dominant, packs are the
wrong next project.

## Smaller code-level improvements

### Reuse one HashCache across a one-shot sync

runSyncCommand supplies no cache. sync calls pull then push, and each withCache call
loads and potentially saves the approximately 22MB JSON cache independently.

Sources:

- src/cli/sync-cmd.ts:55–76
- src/cli/sync.ts:180–188
- src/cli/sync.ts:223–245
- src/cli/sync.ts:385–407
- src/cli/sync.ts:749–760

Illustrative wrapper:

~~~ts
export async function sync(root, cfg, deps = {}) {
  if (deps.cache) return syncWithProvidedCache(root, cfg, deps);

  const cache = await HashCache.load(root);
  try {
    return await syncWithProvidedCache(
      root,
      cfg,
      { ...deps, cache },
    );
  } finally {
    await cache.save(root);
  }
}
~~~

This does not remove the second scan, but it removes duplicate JSON parsing and
persistence.

### Parallelize account refresh and latest-head fetch

verifiedHead currently waits for complete account-key refresh and verification before
requesting the latest commit:

- src/cli/e2ee-remote.ts:227–258

The calls are independent until their results are verified:

~~~ts
const pinPromise = pins.load();
const keysPromise = api.getAccountKeys();
const latestPromise = api.latestCommit();

const [pin, keys, latest] = await Promise.all([
  pinPromise,
  keysPromise,
  latestPromise,
]);

const account = await verifyAccountAgainstPin(keys, pin);
~~~

Expected benefit is probably below one second, so keep this behind the P0 work.

### Bound batch-client transient memory

Upload batching currently:

1. readFiles every payload in a batch;
2. allocates a second combined Uint8Array;
3. copies all payload bytes into it.

Source: src/cli/remote/blob-batch.ts:725–754.

At 24 slots and an 8MiB body cap, transient payload plus output copies can reach
hundreds of megabytes. Stream framing, transferable crypto results, or a bounded
buffer pool would reduce RSS and GC pressure.

Download settlements retain up to one body’s payload promises per active slot:

- src/cli/remote/blob-batch.ts:447–481

Use a bounded per-slot settlement queue if RSS/GC telemetry shows pressure.

### Move best-effort mirror work off the commit response

After authoritative DO CAS, the commit path awaits alarm arming and the explicitly
best-effort D1 commit mirror:

- apps/api/src/workspace-sync.ts:487–506

If immediate D1 versions-list consistency is not required, run at least the mirror
under ctx.waitUntil. Expected benefit is tens to hundreds of milliseconds.

### JSON-table validation is an interim experiment only

Replacing hundreds of prepared IN-list statements with a small number of json_each
queries can reduce D1 dispatch and binding overhead. Local SQLite experiments showed
only modest CPU improvement, and a bad join order can be catastrophic.

If tested:

- pin the intended query plan;
- use EXPLAIN QUERY PLAN;
- benchmark remote D1, not only local SQLite;
- do not let this delay O(change) admission.

## Explicit non-opportunities

Do not prioritize:

- increasing download slots beyond the measured 48-slot knee;
- raising batch record count above 32 without body/count telemetry;
- adding more same-isolate encryption promises;
- reintroducing staging→canonical promotion for ordinary small blobs;
- generic D1 sharding or PlanetScale for this single-account critical path;
- queueing acceptance-critical commit work;
- server-side compression of ciphertext;
- direct R2 paths that weaken whole-object integrity or revocation;
- chunk sync without evidence of frequently mutated large files;
- pack storage before measuring the post-batch R2 critical path.

## Recommended execution sequence

### Track A: steady sync

1. Confirm design-97 server timing fields are deployed and collected.
2. Ship early parent/epoch rejection.
3. Ship change-only blobs/check plus request caps and full-audit chunking.
4. Design and implement O(change) ref admission with GC/root-index proofs.
5. Complete design-84 C1/C2/D.
6. Complete daemon pull narrowing and foreground delegation from designs 39/85.

### Track B: cold transfer

1. Add encrypt-ready, upload-critical-path, receipt, auth, and temp-disk metrics.
2. Build the producer-consumer encrypt/upload pipeline.
3. Add fused byte-bounded small-file Worker jobs.
4. Redeem receipts during upload.
5. Add cold Git artifact prefetch if its measurement gate passes.
6. Add directory-trie preparation and size-aware apply lanes.
7. Parallelize multipart parts and benchmark ranged large-file download.
8. Consider a pack cache only if R2 is still the measured join pole.

## Benchmark protocol

Use fixed corpora and run one mechanism at a time.

### Workload A: steady one-file change

- approximately 112k-ref workspace;
- one clean push;
- one deliberately stale-parent push;
- one epoch-stale push;
- one receiver pull;
- one complete cross-host write→publish→apply measurement.

Capture:

- client phase walls;
- design-97 server timing fields;
- D1 calls/statements;
- R2 critical-path calls;
- ref counts processed;
- 409 and 422 recovery count.

### Workload B: cold first publish

- fixed approximately 100k-file corpus;
- empty encryption cache;
- duplicate-content ratio recorded;
- one clean run;
- one interrupted-and-resumed run.

Capture:

- unique and duplicate encryption count;
- Worker service/queue wall;
- first ready ciphertext and first upload;
- upload critical path;
- auth calls and wall;
- receipt redemption batches and wall;
- peak CPU, RSS, FDs, and temporary bytes.

### Workload C: cold join

Run both:

- truly empty destination;
- new sibling worktree with high local duplicate coverage.

Capture:

- manifest/latest;
- batch R2 critical path;
- filesystem directory/precondition/publish phases;
- decrypt/write;
- Git fetch/decrypt/verify/import;
- total requests and transferred bytes.

### Workload D: large object

- one 2GiB incompressible blob;
- one 2GiB compressible blob;
- upload and download;
- Wi-Fi and wired where practical.

Capture:

- part transfer wall;
- completion wall;
- range transfer wall;
- final hash/GCM/decrypt wall;
- retry/resume behavior.

### Statistical discipline

- 10 warm and 5 cold samples where meaningful;
- report p50, p95, range, and raw counts;
- serialize WAN benchmarks across hosts;
- distinguish critical-path time from sums of concurrent task durations;
- keep old release as the A/B control;
- rerun corruption, quota, GC fence, 409, churn, and E2EE determinism suites.

## Suggested success targets

These are gates to falsify, not promises:

| Area | Suggested gate |
|---|---:|
| Clean one-file commit POST | p50 at or below 2s |
| Known-stale commit response | p50 at or below 1s |
| Ordinary missing preflight | p50 below 500ms and O(changed refs) |
| Manifest latest after delta folding | p50 at or below 2s |
| Full first-publish encrypt phase | at least 30% below 363s |
| Full first-publish wall | materially closer to max(encrypt, upload) than their sum |
| Daemon pull local work | O(actions), no broad post-apply scan |
| Git prefetch | ship only if it reduces the measured 34s Git phase |
| Multipart | at least 2x large-object transfer with no resume regression |

## Final assessment

rbox’s current performance is strong because the shipped work attacked the correct
first-order limits: D1 per blob, HTTP request count, compression, real CPU workers,
incremental Git, and accidental O(N²) behavior.

The next performance generation should use one governing rule:

> A small change must perform work proportional to the change, and a cold transfer
> must overlap independent CPU, network, accounting, and filesystem stages.

The first rule points to O(change) commit admission, change-only preflight, manifest
deltas, and daemon-owned local truth. The second points to the fused upload pipeline,
Git artifact prefetch, directory planning, and parallel large-object transfer.

That is the highest-confidence route to meaningfully faster sync and initial
upload/download without reopening work that v1.0.0 has already solved.
