/** Never: raw HTTP, crypto primitives, or pure contract ownership. */
import {
  buildCommit,
  createWorkspaceKey,
  GENESIS_PARENT_HASH,
  openCommit,
  openCommitHistorical,
  openManifestChainBlob,
  openWorkspaceKey,
  parseCommit,
  serializeRefset,
  verifyAccount,
  verifyCommitSig,
  verifyCommitChain,
  verifyHistorySegment,
  type BlobRefset,
  type SignedCommit,
  type SignedKeyState,
  type SignedRoster,
  type VerifiedAccount,
  type Wrap,
} from "../engine/e2ee/index.js";
import { activeSigners } from "../engine/e2ee/roster.js";
import type { ByteProgressCallback } from "../engine/blobstore.js";
import { hashBytes } from "../engine/hash.js";
import { canonicalManifestHash, canonicalManifestHashStreaming, decodeEnvelope, encodeDeltaEnvelope, encodeSnapshotEnvelope, foldDelta, hasEnvelopePrefix, ManifestChainError, MAX_MANIFEST_DELTA_CHAIN, poolMap, type BlobStore, type Manifest } from "../engine/index.js";
import { gitSectionBlobRefs } from "./sync-git/git-state.js";
import type { GlobalManifestMeta } from "./config.js";
import type { CommitChainResult, CurrentWriteKek, E2eeApi, E2eeContext, HeadPin, PinStore, VerifiedSuffixEntry, VersionInfo } from "./e2ee-remote-types.js";
import type { ReceiptPort } from "./publish-pipeline/receipt-drainer.js";
import { CommitRejectedError, NeedsRebaselineError, type CommitOptions, type CommitResult, type CommitTimings, type LatestManifest, type LatestOptions, type LatestTimings, type SyncRemote } from "./remote.js";

export type { AccountKeysDTO, GenesisAccountObservation, GenesisPresence, CommitChainResult, CurrentWriteKek, E2eeApi, E2eeContext, HeadPin, PinStore, VerifiedSuffixEntry, VersionInfo, WsKeyDTO } from "./e2ee-remote-types.js";

/** Bounded concurrency for the per-commit manifest fetch+decrypt in `pathHistory`
 *  (each is one blob round-trip + an AEAD open — latency-bound on a real server). */
const HISTORY_DECRYPT_CONCURRENCY = 8;

/** #818: how long a prefetched account refresh may sit before `commit()` refuses to
 *  sign against it. C4 wants the epoch read immediately before signing; overlapping
 *  one upload's round-trip is the whole point, an abandoned push's leftover is not. */
const ACCOUNT_PREFETCH_MAX_AGE_MS = 60_000;

/** §24: emit a sidecar (refs out of the signed body) once the unique ref set is large
 *  enough that the inline body would approach the server's 1 MB commit-body cap. At ~85 B
 *  JSON/ref, 4000 refs ≈ 340 KB — comfortably inline; above this we switch to the sidecar
 *  so the body stays O(1). A repo big enough to need this already exceeds what a pre-§24
 *  client could commit (it would hit the 1 MB cap), so sidecar-for-large-only regresses no
 *  currently-working case. Below the threshold, inline keeps full old/new-client interop. */
export const SIDECAR_THRESHOLD = 4000;

/**
 * E2EE sync transport (design 12 §13). Implements the SAME `SyncRemote` seam
 * `sync.ts` already depends on, but transparently encrypts: `latest()` fetches +
 * verifies the signed commit chain from the pinned head, then decrypts the
 * manifest; `commit()` encrypts the manifest, builds a signed commit, uploads the
 * opaque encrypted-manifest blob, and posts the envelope. `sync.ts`'s reconcile +
 * convergent blob encryption (by `encSha`) are unchanged — they sit above this.
 *
 * The CLI constructs this and passes it as `deps.remote`, so the encryption is a
 * transport layer beneath the plaintext-manifest reconcile logic.
 */

const EMPTY_MANIFEST: Manifest = { generatedAt: "", files: [] };

/** A manifest read back off the chain, with the KEK it decrypted under and — when
 *  the caller asked for it — the wire identity the delta writer needs. */
interface DecodedManifest {
  manifest: Manifest;
  kek: Uint8Array;
  manifestMeta?: GlobalManifestMeta;
}

/** Why a commit did NOT emit a delta (design 204 §7). The burn-in failure
 *  discriminator: a persistent `economic`/`no-base`/`integrity` wall is a bug
 *  signature, `chain-cap` at ~1/17 cadence is healthy compaction. */
export type MdeNonDeltaCause = "policy" | "no-base" | "integrity" | "force" | "economic" | "chain-cap";

type DeltaDisposition =
  | { ok: true; base: NonNullable<CommitOptions["deltaBase"]> }
  | { ok: false; cause: MdeNonDeltaCause };

function deltaDisposition(
  deltaEnabled: boolean,
  options: CommitOptions | undefined,
  keyEpoch: number,
  accountEpoch: number,
): DeltaDisposition {
  if (!deltaEnabled) return { ok: false, cause: "policy" };
  if (options?.forceSnapshot) return { ok: false, cause: "force" };
  const base = options?.deltaBase;
  if (!base) return { ok: false, cause: options?.deltaBaseRejection ?? "no-base" };
  if (base.meta.keyEpoch !== keyEpoch || base.meta.accountEpoch !== accountEpoch) {
    return { ok: false, cause: "integrity" };
  }
  if (base.meta.chain.length + 1 > MAX_MANIFEST_DELTA_CHAIN) {
    return { ok: false, cause: "chain-cap" };
  }
  return { ok: true, base };
}

/** Design 204 §4.2 — the manifest-encoding write LATTICE, inverted.
 *
 *  Design 84 shipped `delta ⟹ snapshot` with delta opt-in. Since design 204
 *  both are default-on and the lattice reads `snapshot ⟹ delta-eligible`:
 *  `RBOX_MDE_SNAPSHOT=0` is the MASTER kill (adopting design 149 §A3's
 *  precedence early) and forces chain-free raw-v0 on EVERY arm, including
 *  repair's `forceSnapshot` — which means "do not emit a delta", never
 *  "override the master kill". `RBOX_MDE_DELTA=0` kills only deltas.
 *
 *  Phase B readers have shipped in every release since v1.1.0 (fold path
 *  verified against the live device inventory on 2026-07-17); design 149's
 *  minReaderVersion gate replaces this manual floor check later.
 *
 *  ONE policy, consumed at BOTH write seams: here (the writer) and push's
 *  deltaBase selection. The push seam must never re-read the raw env vars —
 *  a seam divergence is invisible to any behavioral wire assertion. */
/** Which manifest-delta-encoding writes design 204 allows this process to make. */
export interface MdeWritePolicy {
  delta: boolean;
  snapshot: boolean;
}

export function mdeWritePolicy(): MdeWritePolicy {
  const snapshot = process.env.RBOX_MDE_SNAPSHOT !== "0";
  const delta = snapshot && process.env.RBOX_MDE_DELTA !== "0";
  if (!snapshot && process.env.RBOX_MDE_DELTA === "1") warnDeltaIgnoredOnce();
  return { delta, snapshot };
}

/** The contradictory pair (`RBOX_MDE_SNAPSHOT=0` + `RBOX_MDE_DELTA=1`) is an
 *  operator misconfiguration, not a per-operation event — but `mdeWritePolicy`
 *  runs per operation, so the latch must live at module scope (REVIEW-204 O12). */
let warnedDeltaIgnoredUnderSnapshotKill = false;
function warnDeltaIgnoredOnce(): void {
  if (warnedDeltaIgnoredUnderSnapshotKill) return;
  warnedDeltaIgnoredUnderSnapshotKill = true;
  process.stderr.write(
    "rbox: mde_delta_ignored_snapshot_kill_switch — RBOX_MDE_SNAPSHOT=0 forces raw-v0 manifests, so RBOX_MDE_DELTA=1 is ignored\n"
  );
}

/** Test-only: clear the module-scope warn-once latch so a suite can assert it. */
export function resetMdeWritePolicyWarnOnceForTests(): void {
  warnedDeltaIgnoredUnderSnapshotKill = false;
}

export function blobRefsForManifest(manifest: Manifest): Array<{ encSha: string; size: number }> | null {
  const refByEnc = new Map<string, { encSha: string; size: number }>();
  for (const f of manifest.files) {
    if (f.type !== "file") continue;
    if (!f.encSha) return null;
    if (!refByEnc.has(f.encSha)) refByEnc.set(f.encSha, { encSha: f.encSha, size: f.comp && f.cipherSize !== undefined ? f.cipherSize : f.size });
  }
  const addGit = (encSha: string, size: number) => {
    if (!refByEnc.has(encSha)) refByEnc.set(encSha, { encSha, size });
  };
  for (const g of Object.values(manifest.gitRepos ?? {})) {
    for (const ref of gitSectionBlobRefs(g)) addGit(ref.encSha, ref.size);
  }
  return [...refByEnc.values()];
}

export class E2eeRemote implements SyncRemote {
  private readonly kekByEpoch = new Map<number, Uint8Array>();
  /** Tiny process-local history fold cache. Entries are authenticated by their
   * signed content address before insertion; newest entry is last. */
  private readonly manifestFoldLru: Array<{ encManifestSha: string; keyEpoch: number; signedChain: string[]; manifest: Manifest }> = [];
  /** The keyEpoch the KEK handed to `currentKek()` belongs to — blobs are
   *  encrypted under it, so a commit MUST be signed under the same epoch (D1). */
  private writeEpoch?: number;

  /** #818: an account refresh started early so its round-trip overlaps the blob
   *  upload instead of stalling in front of the signature. Consumed once, by the
   *  next `commit()`, and only while still fresh enough to honor C4. */
  private accountPrefetch?: { promise: Promise<VerifiedAccount>; at: number };

  constructor(private readonly api: E2eeApi, private readonly ctx: E2eeContext, private readonly pins: PinStore) {}

  /**
   * #818: issue the account-keys GET concurrently with the upload lane. Nothing
   * before signing depends on the result, so a push paid its full round-trip
   * serially in front of `commit()`.
   *
   * Not fire-and-forget: the promise is parked, `commit()` awaits it, and a
   * rejection therefore fails the push with exactly the error it does today. The
   * local `catch` only marks it handled so a push that never reaches `commit()`
   * cannot raise an unhandled rejection.
   */
  prefetchAccount(): void {
    const promise = this.refreshAccount();
    promise.catch(() => {});
    this.accountPrefetch = { promise, at: this.ctx.now() };
  }

  /** C4 wants a fresh epoch immediately before signing. A prefetch older than one
   *  upload's worth of staleness is discarded rather than signed against. */
  private freshAccount(): Promise<VerifiedAccount> {
    const parked = this.accountPrefetch;
    this.accountPrefetch = undefined;
    if (parked && this.ctx.now() - parked.at < ACCOUNT_PREFETCH_MAX_AGE_MS) return parked.promise;
    return this.refreshAccount();
  }

  /** The current-epoch workspace KEK — also used by sync.ts to encrypt blobs.
   *  Snapshots the write epoch so `commit()` can reject a stale-KEK sign (D1). */
  async currentKek(): Promise<CurrentWriteKek> {
    const account = await this.refreshAccount();
    this.writeEpoch = account.currentKeyEpoch;
    const kek = await this.kekFor(account.currentKeyEpoch, account, true);
    return {
      kek,
      accountId: this.ctx.accountId,
      accountEpoch: account.currentEpoch,
      keyEpoch: account.currentKeyEpoch,
    };
  }

  // ---- SyncRemote ----------------------------------------------------------

  async latest(options?: LatestOptions): Promise<LatestManifest> {
    const vh = await this.verifiedHead();
    // Empty heads have no manifest blob decode substeps to time.
    if (!vh) return { sequence: 0, manifest: EMPTY_MANIFEST };
    const collectMeta = mdeWritePolicy().snapshot || options?.recordEvidence === true || options?.fastFoldBase !== undefined;
    const decoded = await this.decodeManifestAt(vh.commit, vh.account, false, options?.onLatestTimings, collectMeta, options?.fastFoldBase);
    const latest: LatestManifest = { sequence: vh.sequence, manifest: decoded.manifest };
    if (decoded.manifestMeta) latest.manifestMeta = decoded.manifestMeta;
    return latest;
  }

  /** Doctor's authenticated chain report; decoding here is the same reader path as
   * latest(), with metadata collection forced on for reporting. */
  async chainDiagnostic(): Promise<{ sequence: number; links: number; chainBytes: number; snapshotBytes: number; snapshotFetched?: boolean }> {
    const vh = await this.verifiedHead();
    if (!vh) return { sequence: 0, links: 0, chainBytes: 0, snapshotBytes: 0 };
    const body = parseCommit(vh.commit);
    if ((body.manifestChain?.length ?? 0) === 0) {
      return { sequence: vh.sequence, links: 0, chainBytes: 0, snapshotBytes: 0, snapshotFetched: false };
    }
    const decoded = await this.decodeManifestAt(vh.commit, vh.account, false, undefined, true);
    const meta = decoded.manifestMeta!;
    return { sequence: vh.sequence, links: meta.chain.length, chainBytes: meta.chainBytes, snapshotBytes: meta.snapshotBytes };
  }

  /** Fetch + decrypt ONE commit's manifest, returning it plus the per-epoch KEK (so
   *  the caller can also decrypt that commit's file blobs). `historical=false` applies
   *  the C4 head gate (`openCommit`); `true` opens an ancestor already authenticated by
   *  `verifyHistorySegment` (`openCommitHistorical`, no current-epoch gate). Both openers
   *  share one args shape, so the only difference is which gate runs. */
  private async decodeManifestAt(
    commit: SignedCommit,
    account: VerifiedAccount,
    historical: boolean,
    onLatestTimings?: LatestOptions["onLatestTimings"],
    collectMeta = false,
    fastFoldBase?: LatestOptions["fastFoldBase"]
  ): Promise<DecodedManifest> {
    const body = parseCommit(commit);
    const signedChain = body.manifestChain ?? [];
    const kek = await this.kekFor(body.keyEpoch, account, false);
    const head = { seq: body.seq, hash: commit.commitHash };
    // Error classification (§3.6.2): chain-walk failures — a missing/corrupt LINK,
    // a linkage/list mismatch, a bad fold — are ManifestChainError (the §3.6.3
    // repair trigger). The chain-free head path (every pre-84 commit) keeps
    // today's plain error surface: a raw-v0 manifest that fails JSON.parse or
    // validateManifest throws exactly what it threw before this design.
    if (signedChain.length > MAX_MANIFEST_DELTA_CHAIN) {
      throw new ManifestChainError("signed chain exceeds maximum length", { head });
    }
    if (signedChain.includes(body.encManifestSha)) {
      throw new ManifestChainError("signed chain includes its head", { head, failingLink: body.encManifestSha });
    }
    // Only authenticated historical reads may return before opening the blob.
    // A current-head read must always run openCommit's current account/signer gate;
    // persisted fast-fold evidence is the sole latest() shortcut.
    const cached = historical ? this.getCachedManifest(body.encManifestSha, body.keyEpoch, signedChain) : undefined;
    if (cached && !collectMeta) return { manifest: cached, kek };
    if (!historical && fastFoldBase &&
      body.keyEpoch === fastFoldBase.meta.keyEpoch &&
      body.accountEpoch === fastFoldBase.meta.accountEpoch &&
      body.encManifestSha === fastFoldBase.meta.encManifestSha &&
      signedChain.length === fastFoldBase.meta.chain.length &&
      fastFoldBase.meta.chain.every((sha, index) => signedChain[index] === sha)) {
      // Current-head cache returns are banned when they would bypass
      // openCommit's account/roster gates. Here verifiedHead() has re-run those
      // gates this pull, the signed address/chain/epochs exactly equal
      // §3.4-verified persisted evidence, and no bytes exist for openCommit to
      // bind. Evidence meta remains the trust anchor; an LRU hit only avoids
      // re-hashing content this process already fully verified.
      const cachedEvidence = this.getCachedManifest(body.encManifestSha, body.keyEpoch, signedChain);
      const evidenceManifest = cachedEvidence ??
        (canonicalManifestHashStreaming(fastFoldBase.manifest) === fastFoldBase.meta.manifestHash
          ? fastFoldBase.manifest
          : undefined);
      if (evidenceManifest) {
        if (!cachedEvidence) this.cacheManifest(body.encManifestSha, body.keyEpoch, signedChain, evidenceManifest);
        onLatestTimings?.({ downloadMs: 0, decryptMs: 0, parseMs: 0, encBytes: 0, fold: "evidence", foldLinks: 0 });
        return { manifest: evidenceManifest, kek, manifestMeta: fastFoldBase.meta };
      }
      // A carried-state hash mismatch is only a guard miss: the normal cold
      // walk self-heals from the authenticated head and signed chain.
    }
    // An uncached fold owns at most its input and output manifests. Drop stale
    // history entries before fetching a new large manifest; the completed result
    // is cached again below. A cached hit returned above remains unaffected.
    this.manifestFoldLru.length = 0;
    const downloadStart = Date.now();
    const encManifest = await this.api.blobStore().get(body.encManifestSha).catch((cause: unknown) => {
        // The head blob is not a chain link; with no chain in play this is
        // today's plain fetch failure. Under a chain it wedges the same walk.
        if (signedChain.length === 0) throw cause;
        throw new ManifestChainError("head manifest blob is missing", { head, failingLink: body.encManifestSha, cause });
      });
    const headDownloadMs = Date.now() - downloadStart;

    const decryptStart = Date.now();
    const open = historical ? openCommitHistorical : openCommit;
    const plaintext = await open({ secrets: this.ctx.secrets, kek, account, commit, encManifest, workspaceId: this.ctx.workspaceId });
    const headDecryptMs = Date.now() - decryptStart;
    const headParseStart = Date.now();
    // Head envelope: raw-v0 decode failures propagate plain (today's surface);
    // an envelope-v1 head that fails to decode is a chain-class failure the
    // §3.6.3 repair must see, chain or no chain.
    const headEnvelope = await decodeEnvelope(plaintext).catch((cause: unknown) => {
      if (!hasEnvelopePrefix(plaintext) && signedChain.length === 0) throw cause;
      throw new ManifestChainError("head manifest envelope failed to decode", { head, failingLink: body.encManifestSha, cause });
    });
    const headParseMs = Date.now() - headParseStart;
    const parseStart = Date.now();
    // Shared exit plumbing for the fast-fold and cold-walk returns: the timings
    // report differs only by the chain download/decrypt terms, and the meta
    // differs only by hash + the two §3.3.4 byte fields.
    const emitLatestTimings = (chainDownloadMs: number, chainDecryptMs: number, fold: LatestTimings["fold"], foldLinks: number): void => {
      if (!onLatestTimings) return;
      onLatestTimings({
        downloadMs: headDownloadMs + chainDownloadMs,
        decryptMs: headDecryptMs + chainDecryptMs,
        parseMs: headParseMs + Date.now() - parseStart,
        encBytes: encManifest.byteLength,
        fold,
        foldLinks,
      });
    };
    const makeMeta = (manifestHash: string, chainBytes: number, snapshotBytes: number, manifest: Manifest): GlobalManifestMeta => ({
      encManifestSha: body.encManifestSha,
      manifestHash,
      accountEpoch: body.accountEpoch,
      keyEpoch: body.keyEpoch,
      chain: [...signedChain],
      chainBytes,
      snapshotBytes,
      gitRepos: manifest.gitRepos ?? {},
    });
    const evidenceChainLength = fastFoldBase?.meta.chain.length ?? -1;
    if (headEnvelope.kind === "delta" && fastFoldBase &&
      body.keyEpoch === fastFoldBase.meta.keyEpoch &&
      body.accountEpoch === fastFoldBase.meta.accountEpoch &&
      signedChain.length >= evidenceChainLength + 1 &&
      fastFoldBase.meta.chain.every((sha, index) => signedChain[index] === sha) &&
      signedChain[evidenceChainLength] === fastFoldBase.meta.encManifestSha &&
      (signedChain.length > evidenceChainLength + 1 ||
        (headEnvelope.header.baseEncSha === fastFoldBase.meta.encManifestSha &&
          headEnvelope.header.baseManifestHash === fastFoldBase.meta.manifestHash))) {
      // Design 204 §4.3 (serial-gate HIGH): the suffix path trusts the PERSISTED
      // `manifestHash` as `trustedBaseHash` without re-hashing the persisted
      // manifest, so locally corrupted persisted state would surface as a
      // ManifestChainError — and the daemon's one-level repair catch would retry
      // with the SAME corrupt evidence, wedging an otherwise healthy chain. Any
      // evidence-fold failure is therefore a cold-walk MISS within this same
      // operation: fall through and retry without evidence. The cold walk is
      // authenticated and self-heals the persisted state (exactly what
      // FAST_PULL-off does today); only ITS failure raises ManifestChainError.
      // Steady state pays nothing; the corrupt-evidence case pays one slow pull.
      try {
        const suffix = signedChain.slice(evidenceChainLength + 1);
        const suffixWalk = await this.walkAndFoldManifestLinks({
          links: suffix,
          kek,
          keyEpoch: body.keyEpoch,
          head,
          initial: {
            manifest: fastFoldBase.manifest,
            trustedBaseHash: fastFoldBase.meta.manifestHash,
            predecessorSha: fastFoldBase.meta.encManifestSha,
          },
        });
        let manifest = suffixWalk.manifest!;
        if (headEnvelope.header.baseEncSha !== suffixWalk.predecessorSha) {
          throw new ManifestChainError("head linkage does not match signed chain", { head, failingLink: body.encManifestSha });
        }
        try {
          manifest = foldDelta(manifest, headEnvelope.ops, headEnvelope.header, suffixWalk.trustedBaseHash);
        } catch (cause) {
          throw this.foldChainError(cause, head, body.encManifestSha);
        }
        this.cacheManifest(body.encManifestSha, body.keyEpoch, signedChain, manifest);
        emitLatestTimings(suffixWalk.downloadMs, suffixWalk.decryptMs, "evidence", suffix.length + 1);
        return {
          manifest,
          kek,
          // Fast path never refetches the terminal snapshot: propagate its bytes
          // and accumulate only the fetched suffix + head ciphertexts (§3.4).
          manifestMeta: makeMeta(headEnvelope.header.resultHash, fastFoldBase.meta.chainBytes + suffixWalk.deltaCipherBytes + encManifest.byteLength, fastFoldBase.meta.snapshotBytes, manifest),
        };
      } catch {
        // Deliberately unclassified: ANY evidence-path failure degrades to the
        // cold walk below, which re-decides the same question authentically.
      }
    }

    const chainWalk = await this.walkAndFoldManifestLinks({ links: signedChain, kek, keyEpoch: body.keyEpoch, head });
    let manifest = chainWalk.manifest;
    let foldKind: LatestTimings["fold"];
    if (signedChain.length === 0) {
      if (headEnvelope.kind === "delta") throw new ManifestChainError("signed and walked chain lengths differ", { head });
      manifest = headEnvelope.manifest;
      foldKind = headEnvelope.kind === "snapshot" ? "snapshot" : "raw";
    } else {
      if (headEnvelope.kind !== "delta") throw new ManifestChainError("snapshot/raw head has a non-empty signed chain", { head });
      if (headEnvelope.header.baseEncSha !== signedChain[signedChain.length - 1]) {
        throw new ManifestChainError("head linkage does not match signed chain", { head, failingLink: body.encManifestSha });
      }
      try {
        manifest = foldDelta(manifest!, headEnvelope.ops, headEnvelope.header, chainWalk.trustedBaseHash);
      } catch (cause) {
        throw this.foldChainError(cause, head, body.encManifestSha);
      }
      foldKind = "coldwalk";
    }
    this.cacheManifest(body.encManifestSha, body.keyEpoch, signedChain, manifest!);
    emitLatestTimings(chainWalk.downloadMs, chainWalk.decryptMs, foldKind, signedChain.length);
    let manifestMeta: GlobalManifestMeta | undefined;
    if (collectMeta) {
      const manifestHash = headEnvelope.kind === "delta"
        ? headEnvelope.header.resultHash
        : headEnvelope.kind === "snapshot"
          ? headEnvelope.header.manifestHash
          : await canonicalManifestHash(manifest!);
      // §3.3.4 accumulator: cumulative DELTA ciphertext bytes since chain[0] —
      // the intermediate delta links (chain[1..]) plus the delta head itself,
      // NEVER the terminal snapshot (chain[0]); a snapshot/raw head resets to 0.
      // (A non-empty chain implies a delta head — foldManifestChain rejects a
      // snapshot head with a non-empty signed chain.)
      manifestMeta = makeMeta(
        manifestHash,
        signedChain.length === 0 ? 0 : chainWalk.deltaCipherBytes + encManifest.byteLength,
        signedChain.length === 0 ? encManifest.byteLength : chainWalk.snapshotCipherBytes,
        manifest!,
      );
    }
    const decoded: DecodedManifest = { manifest: manifest!, kek };
    if (manifestMeta) decoded.manifestMeta = manifestMeta;
    return decoded;
  }

  /** Consume already-fetched signed links serially. With no initial state link 0
   * is the terminal snapshot/raw base; with evidence every link is a delta. */
  private async walkAndFoldManifestLinks(args: {
    links: readonly string[];
    kek: Uint8Array;
    keyEpoch: number;
    head: { seq: number; hash: string };
    initial?: { manifest: Manifest; trustedBaseHash: string; predecessorSha: string };
  }): Promise<{ manifest: Manifest | undefined; trustedBaseHash: string | undefined; predecessorSha: string | undefined; downloadMs: number; decryptMs: number; snapshotCipherBytes: number; deltaCipherBytes: number }> {
    const downloadStart = Date.now();
    const ciphertexts: Array<Uint8Array | null> = await Promise.all(args.links.map(async (sha) =>
      this.api.blobStore().get(sha).catch((cause: unknown) => {
        throw new ManifestChainError("manifest chain link is missing", { head: args.head, failingLink: sha, cause });
      })
    ));
    const downloadMs = Date.now() - downloadStart;
    let manifest = args.initial?.manifest;
    let trustedBaseHash = args.initial?.trustedBaseHash;
    let predecessorSha = args.initial?.predecessorSha;
    let decryptMs = 0;
    let snapshotCipherBytes = 0;
    let deltaCipherBytes = 0;
    for (let index = 0; index < args.links.length; index++) {
      const sha = args.links[index]!;
      const bytes = ciphertexts[index]!;
      ciphertexts[index] = null;
      const terminalBase = args.initial === undefined && index === 0;
      if (terminalBase) snapshotCipherBytes = bytes.byteLength;
      else deltaCipherBytes += bytes.byteLength;
      const decryptStart = Date.now();
      let plaintext: Uint8Array;
      try {
        plaintext = await openManifestChainBlob({ kek: args.kek, accountId: this.ctx.accountId, workspaceId: this.ctx.workspaceId, keyEpoch: args.keyEpoch, expectedEncSha: sha, bytes });
      } catch (cause) {
        throw new ManifestChainError("manifest chain link failed address or epoch authentication", { head: args.head, failingLink: sha, cause });
      }
      decryptMs += Date.now() - decryptStart;
      const envelope = await decodeEnvelope(plaintext).catch((cause: unknown) => {
        throw new ManifestChainError("manifest chain link envelope failed to decode", { head: args.head, failingLink: sha, cause });
      });
      if (terminalBase) {
        if (envelope.kind === "delta") throw new ManifestChainError("terminal chain link is not a snapshot", { head: args.head, failingLink: sha });
        manifest = envelope.manifest;
        trustedBaseHash = envelope.kind === "snapshot" ? envelope.header.manifestHash : canonicalManifestHashStreaming(envelope.manifest);
        predecessorSha = sha;
        continue;
      }
      if (envelope.kind !== "delta") throw new ManifestChainError("non-terminal chain link is not a delta", { head: args.head, failingLink: sha });
      if (envelope.header.baseEncSha !== predecessorSha) {
        throw new ManifestChainError("walked linkage does not match signed chain order", { head: args.head, failingLink: sha });
      }
      try {
        manifest = foldDelta(manifest!, envelope.ops, envelope.header, trustedBaseHash);
      } catch (cause) {
        throw this.foldChainError(cause, args.head, sha);
      }
      trustedBaseHash = envelope.header.resultHash;
      predecessorSha = sha;
    }
    return { manifest, trustedBaseHash, predecessorSha, downloadMs, decryptMs, snapshotCipherBytes, deltaCipherBytes };
  }

  private getCachedManifest(encManifestSha: string, keyEpoch: number, signedChain: readonly string[]): Manifest | undefined {
    const index = this.manifestFoldLru.findIndex((entry) => entry.encManifestSha === encManifestSha && entry.keyEpoch === keyEpoch &&
      entry.signedChain.length === signedChain.length && entry.signedChain.every((sha, i) => sha === signedChain[i]));
    if (index < 0) return undefined;
    const [entry] = this.manifestFoldLru.splice(index, 1);
    this.manifestFoldLru.push(entry!);
    return entry!.manifest;
  }

  private cacheManifest(encManifestSha: string, keyEpoch: number, signedChain: readonly string[], manifest: Manifest): void {
    const index = this.manifestFoldLru.findIndex((entry) => entry.encManifestSha === encManifestSha);
    if (index >= 0) this.manifestFoldLru.splice(index, 1);
    this.manifestFoldLru.push({ encManifestSha, keyEpoch, signedChain: [...signedChain], manifest });
    if (this.manifestFoldLru.length > 2) this.manifestFoldLru.shift();
  }

  private foldChainError(
    cause: unknown,
    head: { seq: number; hash: string },
    failingLink: string
  ): ManifestChainError {
    const reason = cause instanceof Error && cause.message.includes("baseManifestHash")
      ? "baseManifestHash mismatch"
      : cause instanceof Error && cause.message.includes("resultHash")
        ? "resultHash mismatch"
        : "manifest delta fold failed";
    return new ManifestChainError(reason, { head, failingLink, cause });
  }

  /**
   * Establish the TRUSTED HEAD (shared anti-rollback anchor for pull + versions +
   * restore, C1/C2): verify the account roster/key-state chains, then verify the
   * commit chain forward from the pin to `latest`, advance the pin, and return the
   * verified head commit. Fail-closed/terminal-bound: the verified chain's terminal
   * commit MUST equal what `latest()` reported (hash) — a server can't have us
   * verify one chain while claiming a different head. Returns null only when the
   * workspace genuinely has no commits yet.
   */
  private async verifiedHead(): Promise<{ account: VerifiedAccount; sequence: number; commit: SignedCommit } | null> {
    const account = await this.refreshAccount();
    const { sequence, commit } = await this.api.latestCommit();
    if (!commit || sequence === 0) return null;

    const pin = await this.pins.load();
    const pinnedSeq = pin?.commitSeq ?? 0;
    if (sequence < pinnedSeq) throw new Error("head rolled back below the pinned sequence (rollback evident) — refusing to sync");

    let head: SignedCommit;
    if (pin && sequence === pinnedSeq) {
      // No new commits: the head IS the already-verified pinned commit. Trust the
      // pin; a different hash at the pinned seq is a fork.
      if (commit.commitHash !== pin.commitHash) throw new Error("server returned a different commit at the pinned sequence (fork/equivocation)");
      head = commit;
    } else {
      // Verify the whole chain from the pin (or genesis) forward to the head (C1).
      const chain = await this.api.commitsSince(pinnedSeq);
      const verified = await verifyCommitChain(chain, pin ? { commitSeq: pin.commitSeq, commitHash: pin.commitHash } : null, account);
      // /latest reported a non-zero head, so the chain MUST be non-empty AND its
      // terminal commit MUST be that head — else the server is equivocating. Fail closed.
      if (!verified) throw new Error("server reported a head but returned no commit chain to verify (inconsistent) — refusing");
      if (verified.commitHash !== commit.commitHash) throw new Error("verified chain head does not match latest() (fork/equivocation) — refusing");
      head = verified;
    }
    // Bind to the SIGNED sequence, not the server's unsigned `latest.sequence` — a
    // server could otherwise pair a valid signed commit with a bogus sequence and
    // skew history bounds. The signed seq is authoritative (it's inside commitHash).
    const signedSeq = parseCommit(head).seq;
    if (signedSeq !== sequence) throw new Error("server's reported head sequence does not match the signed commit seq (equivocation) — refusing");
    await this.pinFrom(head, account);
    return { account, sequence: signedSeq, commit: head };
  }

  // ---- version history + restore (design 12 §15, D11) ----------------------

  /**
   * `rbox versions`: the verified commit history within the retained window,
   * newest-first. Each entry is metadata only (no decrypt) — `seq`/`deviceId`/
   * `keyEpoch` from the SIGNED commit body, authenticated as the true ancestry of
   * the verified head (`verifyHistorySegment`). Empty when the workspace has no
   * history yet.
   */
  async history(limit: number): Promise<VersionInfo[]> {
    const win = await this.retainedWindow(limit);
    if (!win) return [];
    return win.seg
      .map((c) => {
        const b = parseCommit(c);
        return { seq: b.seq, deviceId: b.deviceId, keyEpoch: b.keyEpoch };
      })
      .reverse(); // newest-first
  }

  /** Advisory, server-reported commit timestamps (seq → epoch-ms) for display only.
   *  Best-effort + UNVERIFIED (the D1 mirror; commit cadence is a documented residual)
   *  — kept OUT of the signed `VersionInfo` so advisory data never rides a verified
   *  field. The CLI joins it by sequence; a lag/miss just shows no time. */
  advisoryTimes(limit: number): Promise<Map<number, number>> {
    return this.api.commitTimes(limit);
  }

  /**
   * The verified + decrypted manifest at a historical sequence, plus the per-epoch
   * KEK bytes for decrypting that commit's file blobs (design 12 §15). Authenticates
   * `[seq..head]` as the true ancestry of the verified head, then decrypts under the
   * commit's OWN `keyEpoch` (`openCommitHistorical` — no current-epoch gate, since a
   * historical commit may predate a rotation). Throws (fail closed) on an out-of-range
   * seq, a tampered/non-terminating chain, or a `seq` pruned past retention
   * (`NeedsRebaselineError` from `commitsSince`).
   */
  async manifestAtSeq(seq: number): Promise<{ manifest: Manifest; kek: Uint8Array; keyEpoch: number }> {
    const vh = await this.verifiedHead();
    if (!vh) throw new Error("this workspace has no version history yet");
    const { account, sequence: head, commit: headCommit } = vh;
    if (!Number.isInteger(seq) || seq < 1 || seq > head) throw new Error(`no such version: ${seq} (history is 1..${head})`);

    let target: SignedCommit;
    if (seq === head) {
      target = headCommit; // already verified by verifiedHead()
    } else {
      const chain = await this.api.commitsSince(seq - 1); // (seq-1, head] = seq..head
      target = await verifyHistorySegment(chain, seq, headCommit.commitHash, account);
    }
    const decoded = await this.decodeManifestAt(target, account, true);
    return { manifest: decoded.manifest, kek: decoded.kek, keyEpoch: parseCommit(target).keyEpoch };
  }

  /** Authenticated signed-commit metadata for the complete suffix `(fromSeq, head]`.
   * This is a consent/reporting surface only; it reuses the normal verified-head and
   * history-segment checks and exposes no manifest paths or unverified server data. */
  async verifiedSuffix(fromSeq: number): Promise<VerifiedSuffixEntry[]> {
    const vh = await this.verifiedHead();
    if (!vh) return [];
    if (!Number.isInteger(fromSeq) || fromSeq < 0 || fromSeq > vh.sequence) {
      throw new Error(`invalid verified suffix start: ${fromSeq}`);
    }
    if (fromSeq === vh.sequence) return [];
    const segment = await this.api.commitsSince(fromSeq);
    await verifyHistorySegment(segment, fromSeq + 1, vh.commit.commitHash, vh.account);
    return segment.map((commit) => {
      const body = parseCommit(commit);
      return { seq: body.seq, deviceId: body.deviceId };
    });
  }

  /** Return the current anti-rollback pin. Repair uses this verified authority as
   * its ordinary commit parent; the commit layer still enforces parent == pin. */
  loadVerifiedPin(): Promise<HeadPin | undefined> {
    return this.pins.load();
  }

  /** Explicit recover ceremony for a workspace whose commit prefix was pruned.
   * The previous pin remains installed throughout verification. Only the longest
   * retained, signature-verified segment ending at /latest may replace it, and the
   * replacement must satisfy the anti-rollback/equivocation floor. */
  async rebaselinePinToRetainedHead(): Promise<{ sequence: number }> {
    const priorPin = await this.pins.load();
    const account = await this.refreshAccount();
    const { sequence, commit } = await this.api.latestCommit();
    if (!commit || sequence === 0) throw new Error("recover refused: pruned workspace has no replacement head");

    const body = parseCommit(commit);
    if (body.seq !== sequence) throw new Error("recover refused: server head sequence does not match its signed commit");
    const roster = account.rosters[body.rosterVersion];
    const signer = roster && activeSigners(roster).get(body.deviceId);
    if (!signer || !(await verifyCommitSig(commit, signer))) {
      throw new Error("recover refused: replacement head is not signed by an active member of its own verified roster");
    }

    await this.retainedSegmentEndingAtHead(0, sequence, commit.commitHash, account);
    if (priorPin && (sequence < priorPin.commitSeq ||
      (sequence === priorPin.commitSeq && commit.commitHash !== priorPin.commitHash))) {
      throw new Error(sequence === priorPin.commitSeq
        ? "recover refused: replacement head differs at the pinned sequence (fork/equivocation)"
        : `recover refused: server head sequence ${sequence} is below the local verified pin ${priorPin.commitSeq} (rollback evident)`);
    }
    await this.pinFrom(commit, account);
    return { sequence };
  }

  /**
   * `rbox versions <path>`: the versions in which `relPath`'s CONTENT changed,
   * newest-first (design 06 §2). Single-pass over the verified retained window —
   * decrypt each commit's manifest (`openCommitHistorical`) and emit a change-point
   * whenever the path's plaintext `sha256` differs from the previous (older) version
   * (first appearance and deletion-within-window included; `sha256: null` = absent).
   */
  async pathHistory(relPath: string, limit: number): Promise<Array<{ seq: number; deviceId: string; sha256: string | null }>> {
    const win = await this.retainedWindow(limit);
    if (!win) return [];
    const { account, seg } = win;
    // Fetch + decrypt each commit's manifest through a bounded pool (each is one blob
    // round-trip + an AEAD open); record this path's content sha per commit, indexed by
    // position so the result stays in ascending-seq order for the change-detection pass.
    const perSeq = new Array<{ seq: number; deviceId: string; sha256: string | null }>(seg.length);
    await poolMap(seg, HISTORY_DECRYPT_CONCURRENCY, async (c, i) => {
      const body = parseCommit(c);
      const { manifest } = await this.decodeManifestAt(c, account, true);
      perSeq[i] = { seq: body.seq, deviceId: body.deviceId, sha256: manifest.files.find((f) => f.path === relPath)?.sha256 ?? null };
    });
    // Emit a change-point whenever the path's content sha differs from the previous
    // (older) version — first appearance and deletion-within-window included.
    const changes: Array<{ seq: number; deviceId: string; sha256: string | null }> = [];
    let lastSha: string | null | undefined; // undefined = nothing emitted yet
    for (const e of perSeq) {
      if (lastSha === undefined || e.sha256 !== lastSha) changes.push(e);
      lastSha = e.sha256;
    }
    return changes.reverse(); // newest-first
  }

  /** The verified retained window ending at the trusted head (the shared prefix of
   *  `history`/`pathHistory`): establish the head, then fetch + verify the last
   *  `limit` commits. Null when there's no history yet. */
  private async retainedWindow(limit: number): Promise<{ account: VerifiedAccount; seg: SignedCommit[] } | null> {
    const vh = await this.verifiedHead();
    if (!vh) return null;
    const seg = await this.retainedSegmentEndingAtHead(Math.max(0, vh.sequence - limit), vh.sequence, vh.commit.commitHash, vh.account);
    return { account: vh.account, seg };
  }

  /**
   * Fetch the verified contiguous commit segment ending at the trusted head,
   * starting as low as retention allows (≥ `desiredSince`). The common case (nothing
   * pruned) is a SINGLE optimistic fetch at `desiredSince`; only when that 409s
   * (`NeedsRebaselineError` — the window dips below the prune floor) do we binary-search
   * the smallest `since` the server can still serve (bounded by log2(window)). Then
   * verify the segment terminates at the trusted head. Never returns unverified commits.
   */
  private async retainedSegmentEndingAtHead(desiredSince: number, head: number, headHash: string, account: VerifiedAccount): Promise<SignedCommit[]> {
    let best: SignedCommit[] | null = null;
    try {
      best = await this.api.commitsSince(desiredSince); // optimistic: unpruned → one round-trip, done
    } catch (e) {
      if (!(e instanceof NeedsRebaselineError)) throw e;
      // Below the prune floor: binary-search the lowest serveable `since` in (desiredSince, head-1].
      let lo = desiredSince + 1;
      let hi = head - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        try {
          best = await this.api.commitsSince(mid); // success: try to reach lower (more history)
          hi = mid - 1;
        } catch (err) {
          if (err instanceof NeedsRebaselineError) {
            lo = mid + 1; // `mid` is still below the floor → raise it
            continue;
          }
          throw err;
        }
      }
    }
    if (!best) throw new Error("no retained version history available (pruned past the retention window)");
    const fromSeq = head - best.length + 1;
    await verifyHistorySegment(best, fromSeq, headHash, account);
    return best;
  }

  async commit(parentSequence: number, _deviceId: string, manifest: Manifest, options?: CommitOptions): Promise<CommitResult> {
    const onCommitTimings = options?.onCommitTimings;
    let refreshMs = 0;
    let account: VerifiedAccount;
    if (onCommitTimings) {
      const t0 = Date.now();
      account = await this.freshAccount(); // C4: refresh immediately before signing
      refreshMs = Date.now() - t0;
    } else {
      account = await this.freshAccount(); // C4: refresh immediately before signing
    }
    // D1: if the epoch rotated between blob encryption (currentKek) and now, the
    // blobs are under the old KEK — force a re-scan/re-encrypt rather than sign a
    // commit whose keyEpoch ≠ the blobs' epoch. (v1 has no rotation; never fires.)
    if (this.writeEpoch !== undefined && this.writeEpoch !== account.currentKeyEpoch) {
      return { epochStale: account.currentEpoch };
    }
    const epoch = account.currentKeyEpoch;
    const kek = await this.kekFor(epoch, account, true);
    const pin = await this.pins.load();
    // The parent sequence and hash must describe the same applied head. A verified
    // but unapplied head advances the anti-rollback pin only, so it must pull first.
    if ((pin?.commitSeq ?? 0) !== parentSequence) {
      // Distinguish local apply lag before reusing the conflict retry path.
      (this.ctx.warningSink ?? ((line) => process.stderr.write(`${line}\n`)))(
        `rbox: local state lags the verified head (applied ${parentSequence}, seen ${pin?.commitSeq ?? 0}) — pulling before push`
      );
      return { conflict: true, head: pin?.commitSeq ?? 0 };
    }
    const parentCommitHash = pin?.commitHash ?? GENESIS_PARENT_HASH;

    // The blobRef list is the UNIQUE set of blobs this commit references — many
    // files can share one blob (identical content → same convergent encSha, e.g.
    // empty files or repeated boilerplate). Dedup by encSha; the file→blob mapping
    // lives in the manifest's file entries. (size advisory; server bills actual R2 bytes.)
    // §28: git artifact blobs (bundle/index/op-state) live in manifest.gitRepos, NOT
    // manifest.files, so they must be added to blobRefs explicitly — else they're uploaded but
    // never granted/charged and GC could reclaim a live bundle. Union across repos (design 43
    // §6.5): two repos referencing the same convergent encSha contribute ONE ref. Use the
    // CIPHERTEXT size: the `size` is advisory (server bills measured R2 bytes) and
    // the ciphertext size is what the server sees anyway, so no plaintext git size (≈ repo
    // size) enters a server-visible ref/sidecar.
    const blobRefs = blobRefsForManifest(manifest);
    if (!blobRefs) throw new Error("E2EE commit requires every file entry to have an encrypted blob address");
    // §24: for a large ref set, move refs OUT of the signed body into a content-addressed
    // sidecar blob (canonical rbox-refset-v1 bytes). The body then carries only the descriptor
    // {sidecarSha,count,totalBytes}; the signature still commits to sidecarSha. Upload the
    // sidecar like any blob FIRST (so it's resolvable at commit), then sign the descriptor.
    let blobRefset: BlobRefset | undefined;
    let sidecarMs = 0;
    if (blobRefs.length >= SIDECAR_THRESHOLD) {
      const t0 = onCommitTimings ? Date.now() : 0;
      const sidecarBytes = serializeRefset(blobRefs);
      const sidecarSha = hashBytes(sidecarBytes);
      blobRefset = { sidecarSha, count: blobRefs.length, totalBytes: blobRefs.reduce((n, r) => n + r.size, 0) };
      if (sidecarSha === options?.blockedFingerprint) {
        throw new CommitRejectedError("too_many_refs", undefined, undefined, sidecarSha, true);
      }
      await this.api.putBlobBytes(sidecarSha, sidecarBytes);
      if (onCommitTimings) sidecarMs = Date.now() - t0;
    }
    let encodeMs = 0;
    let encryptMs = 0;
    let uploadMs = 0;
    const { delta: deltaEnabled, snapshot: snapshotEnabled } = mdeWritePolicy();
    const baseBuildArgs = {
      secrets: this.ctx.secrets,
      workspaceId: this.ctx.workspaceId,
      kek,
      keyEpoch: epoch,
      accountEpoch: account.currentEpoch,
      rosterVersion: account.currentRoster.version,
      seq: parentSequence + 1,
      parentSeq: parentSequence,
      parentCommitHash,
      blobRefs,
      blobRefset,
    };
    const buildEncoded = async (manifestJson: Uint8Array, manifestChain?: string[]) => {
      const buildArgs: Parameters<typeof buildCommit>[0] = { ...baseBuildArgs, manifestJson };
      if (manifestChain?.length) buildArgs.manifestChain = manifestChain;
      if (onCommitTimings) buildArgs.onEncryptMs = (ms: number) => (encryptMs += ms);
      return buildCommit(buildArgs);
    };
    // encodeSnapshotEnvelope returns the canonical hash it already computed —
    // reusing it for the meta below avoids a second O(N) canonicalize+hash of
    // the full manifest per snapshot commit (the commit's dominant CPU).
    const encodeSnapshot = async () => {
      const snapshot = await encodeSnapshotEnvelope(manifest, { compress: true });
      resultManifestHash = snapshot.manifestHash;
      return buildEncoded(snapshot.bytes);
    };
    const t0 = onCommitTimings ? Date.now() : 0;
    let built: Awaited<ReturnType<typeof buildCommit>>;
    let resultManifestHash: string | undefined;
    let emittedChain: string[] | undefined;
    let emittedDelta = false;
    let emittedDeltaOpCount: number | undefined;
    const disposition = deltaDisposition(deltaEnabled, options, epoch, account.currentEpoch);
    let nonDeltaCause: MdeNonDeltaCause | undefined;
    if (!snapshotEnabled) {
      // MASTER KILL (§4.2): every arm — including repair — emits chain-free
      // raw-v0. This branch must precede forceSnapshot, or the emergency raw
      // window would silently leak envelope-v1 snapshots on the repair path.
      nonDeltaCause = disposition.ok ? undefined : disposition.cause;
      built = await buildEncoded(new TextEncoder().encode(JSON.stringify(manifest)));
    } else if (disposition.ok) {
      const deltaBase = disposition.base;
      const chain = [...deltaBase.meta.chain, deltaBase.meta.encManifestSha];
      const candidate = await encodeDeltaEnvelope(deltaBase.manifest, manifest, {
        baseEncSha: deltaBase.meta.encManifestSha,
        baseManifestHash: deltaBase.meta.manifestHash,
        compress: true,
        baseValidated: deltaBase.validated === true,
      });
      const candidateBuilt = await buildEncoded(candidate.bytes, chain);
      if (deltaBase.meta.chainBytes + candidateBuilt.encManifest.byteLength < deltaBase.meta.snapshotBytes) {
        built = candidateBuilt;
        resultManifestHash = candidate.resultHash;
        emittedChain = chain;
        emittedDelta = true;
        emittedDeltaOpCount = candidate.opCount;
      } else {
        nonDeltaCause = "economic";
        built = await encodeSnapshot(); // §3.3.4: candidate discarded, re-emit as snapshot
      }
    } else {
      nonDeltaCause = disposition.cause;
      built = await encodeSnapshot();
    }
    // §7 per-commit discriminator. The selected envelope's encoded byte length
    // attributes economic fallbacks to the emitted snapshot, not the discarded delta.
    if (emittedDeltaOpCount !== undefined) {
      this.ctx.warningSink?.(`rbox: mde delta ops=${emittedDeltaOpCount} bytes=${built.encManifest.byteLength}`);
    } else if (nonDeltaCause) {
      this.ctx.warningSink?.(`rbox: mde non_delta cause=${nonDeltaCause} bytes=${built.encManifest.byteLength}`);
    }
    if (onCommitTimings) encodeMs = Math.max(0, Date.now() - t0 - encryptMs);
    if (onCommitTimings) {
      const t0 = Date.now();
      await this.api.putBlobBytes(built.encManifestSha, built.encManifest);
      uploadMs = Date.now() - t0;
    } else {
      await this.api.putBlobBytes(built.encManifestSha, built.encManifest);
    }

    let res: CommitChainResult;
    let postMs = 0;
    try {
      if (onCommitTimings) {
        const t0 = Date.now();
        res = await this.api.commitSigned(parentSequence, built.commit, options?.beforeCommitSend);
        postMs = Date.now() - t0;
      } else {
        res = await this.api.commitSigned(parentSequence, built.commit, options?.beforeCommitSend);
      }
    } catch (e) {
      if (e instanceof CommitRejectedError && blobRefset) e.fingerprint = blobRefset.sidecarSha;
      throw e;
    }
    if (onCommitTimings) {
      const timings: CommitTimings = {
        refreshMs,
        sidecarMs,
        encodeMs,
        encryptMs,
        uploadMs,
        postMs,
        encBytes: built.encManifest.byteLength,
      };
      if (res.serverTimings) timings.serverTimings = res.serverTimings;
      onCommitTimings(timings);
    }
    if (res.conflict) return { conflict: true, head: res.head };
    if (res.unsatisfiedBlobs) {
      const unsatisfied: CommitResult = {
        unsatisfiedBlobs: res.unsatisfiedBlobs,
        unsatisfiedTotal: res.unsatisfiedTotal,
      };
      if (emittedChain) unsatisfied.attemptedManifestChain = emittedChain;
      return unsatisfied;
    }
    if (res.epochStale !== undefined) return { epochStale: res.epochStale }; // rotated under us -> refresh write context + retry
    // The server's returned sequence MUST equal the seq we signed (parentSequence+1) —
    // otherwise it's labelling our commit with a different number (equivocation). Fail closed.
    if (res.sequence !== parentSequence + 1) throw new Error("server returned a sequence that does not match the signed commit seq — refusing to pin");
    await this.pinFrom(built.commit, account);
    const committed: CommitResult = { sequence: res.sequence };
    if (snapshotEnabled) {
      committed.manifestMeta = {
        encManifestSha: built.encManifestSha,
        manifestHash: resultManifestHash ?? await canonicalManifestHash(manifest),
        accountEpoch: account.currentEpoch,
        keyEpoch: epoch,
        chain: emittedChain ?? [],
        chainBytes: emittedDelta && disposition.ok ? disposition.base.meta.chainBytes + built.encManifest.byteLength : 0,
        snapshotBytes: emittedDelta && disposition.ok ? disposition.base.meta.snapshotBytes : built.encManifest.byteLength,
        gitRepos: manifest.gitRepos ?? {},
      };
    }
    return committed;
  }

  missingBlobs(shas: string[]): Promise<string[]> {
    return this.api.missingBlobs(shas);
  }
  putBlobFile(
    sha256: string,
    absPath: string,
    size: number,
    uploadsDir?: string,
    onBytes?: ByteProgressCallback
  ): Promise<void> {
    return this.api.putBlobFile(sha256, absPath, size, uploadsDir, onBytes);
  }
  ownsUploadLaneTiming(size: number): boolean {
    return this.api.ownsUploadLaneTiming?.(size) === true;
  }
  /** Forward the upload-receipt drain port (design 111). Every real publish runs
   *  through this wrapper; omitting this forward silently disabled upload-time
   *  receipt draining fleet-wide (field gap, 2026-07 FM validation). */
  receiptPort(): ReceiptPort | undefined {
    return this.api.receiptPort?.();
  }
  // Deliberately do not forward closeUploader: one pipeline abort would
  // permanently close the daemon's long-lived batch uploader
  // (BlobBatchUploader.close is terminal). Forward it only once uploader
  // close/reopen is attempt-scoped. The parity guard below the class keeps
  // every OTHER optional SyncRemote capability forwarded.
  blobStore(): BlobStore {
    return this.api.blobStore();
  }

  // ---- internals -----------------------------------------------------------

  /** Re-fetch + re-verify the account's roster/key-state chains on EVERY call
   *  (intentional — C4 wants a fresh epoch immediately before signing, plus fresh
   *  anti-rollback). Asserts the chains extend the locally-pinned hashes (C2) AND
   *  that THIS device is still active in the current roster — otherwise a
   *  half-admitted device (admit POST lost after local save) would silently sign
   *  commits no peer can verify. Fail closed instead. */
  private async refreshAccount(): Promise<VerifiedAccount> {
    const keys = await this.api.getAccountKeys();
    if (!keys) throw new Error("workspace is E2EE but this account has no key material — run setup/connect first");
    const rosters = keys.rosters.map((s) => JSON.parse(s) as SignedRoster);
    const keyStates = keys.keyStates.map((s) => JSON.parse(s) as SignedKeyState);
    const account = await verifyAccount(rosters, keyStates);

    const pin = await this.pins.load();
    if (pin) {
      const rh = account.rosterHashByVersion.get(pin.rosterVersion);
      // C2: pin HASHES, not versions. The roster hash at the pinned version and the
      // key-state hash at the pinned epoch must both match — a same-version/same-epoch
      // fork (different hash) is a rollback/substitution. Epoch must not move backward.
      const ksh = account.keyStateHashByEpoch.get(pin.accountEpoch);
      if (rh !== pin.rosterHash || ksh !== pin.keyStateHash || account.currentEpoch < pin.accountEpoch) {
        throw new Error("account key rollback detected (roster/key-state moved backward or forked) — refusing to sync");
      }
    }
    if (!account.currentRoster.devices.some((d) => d.deviceId === this.ctx.secrets.deviceId && d.status === "active")) {
      throw new Error("this device isn't an active member of the account roster — enrollment may be incomplete. Run `rbox connect` with a fresh `rbox pair` token, or `rbox key recover`.");
    }
    return account;
  }

  /** Resolve the workspace KEK for an epoch: memory → server wrap → (push only)
   *  create + CAS-publish, adopting the winning wrap. */
  private async kekFor(keyEpoch: number, account: VerifiedAccount, createIfMissing: boolean): Promise<Uint8Array> {
    const cached = this.kekByEpoch.get(keyEpoch);
    if (cached) return cached;

    const wraps = await this.api.getWorkspaceKeys(this.ctx.workspaceId);
    const found = wraps.find((w) => w.keyEpoch === keyEpoch);
    if (found) {
      const kek = await openWorkspaceKey(this.ctx.secrets, JSON.parse(found.kekWrap) as Wrap, this.ctx.workspaceId, keyEpoch, account.currentEpoch);
      this.kekByEpoch.set(keyEpoch, kek);
      return kek;
    }
    if (!createIfMissing) throw new Error(`no workspace KEK for keyEpoch ${keyEpoch} (fail closed — never guess)`);

    // Create + publish via the immutable CAS; adopt whatever wrap actually won.
    const fresh = await createWorkspaceKey(this.ctx.secrets, this.ctx.workspaceId, keyEpoch, account.currentEpoch);
    const winner = await this.api.putWorkspaceKey(this.ctx.workspaceId, keyEpoch, JSON.stringify(fresh.kekWrap));
    const kek = await openWorkspaceKey(this.ctx.secrets, JSON.parse(winner.kekWrap) as Wrap, this.ctx.workspaceId, keyEpoch, account.currentEpoch);
    this.kekByEpoch.set(keyEpoch, kek);
    return kek;
  }

  private async pinFrom(commit: SignedCommit, account: VerifiedAccount): Promise<void> {
    const body = parseCommit(commit);
    await this.pins.save({
      commitSeq: body.seq,
      commitHash: commit.commitHash,
      rosterVersion: account.currentRoster.version,
      rosterHash: account.currentRosterHash,
      accountEpoch: account.currentEpoch,
      keyStateHash: account.currentKeyStateHash,
    });
  }
}

// Compile-time parity guard: E2eeRemote must forward every optional SyncRemote
// capability — an omitted forward silently no-ops in production, which is
// exactly how the design-111 upload-time receipt drain was disabled fleet-wide
// (receiptPort was never forwarded; found via FM field validation 2026-07).
// Lives HERE, not in a test file: tsconfig excludes **/*.test.ts, so only a
// production module puts this in front of `tsc`. closeUploader is deliberately
// excluded — see the comment beside receiptPort above.
type AssertAssignable<T extends true> = T;
type _E2eeForwardsAllOptionalSyncRemoteCaps = AssertAssignable<
  E2eeRemote extends Required<Omit<SyncRemote, "closeUploader">> ? true : false
>;
