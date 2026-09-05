# Design287 adversarial review — round1, general consistency

Reviewed the complete generated design287 (11,102 words) and only the key index/watcher/E2EE symbols needed to challenge its assumptions. Verdict: **good staged roadmap; not an accepted collection of implementation specifications. Changes requested before declaring roadmap alignment**, principally two concrete safety/behavior gaps and coupling of G1's release slices. Larger G6/S5/X1 wire/state-machine choices are correctly labeled design gates and need not be solved in this roadmap.

## Ranked findings

### R1 [P1] F1 introduces a Git-directory write prerequisite into a currently read-only trackedness query

Plan F1 step3 requires copying every cache-miss index beside itself. Existing `buildIgnoreMatcher/loadTrackedRepoSet` can read a healthy index in a non-writable `.git` directory; private copying cannot. The fallback “unavailable, preserve fail-open” changes results for a supported readable repository, not merely performance: ignore protection for a known-but-unavailable repo can allow paths the correct tracked set would exclude. It can also cause persistent cold reads/deferrals and index-snapshot temp artifacts in locations the caller is not authorized to mutate.

**Executed bounded probe:** `/private/tmp/rbox-plan-readonly-index-probe.ts` makes a temp repo, force-adds `a.secret`, sets `.git`0555, then calls fresh Git and current matcher. Result: `git ls-files --cached = a.secret`, matcher tracked=true/ignored=false, but sibling copy fails **EACCES**. Fixture cleaned. This directly falsifies the implicit read→write assumption; no production/source changes.

**Correction:** make snapshot placement/fallback an explicit algorithm. For an ordinary index, copy into owned cache/temp storage and route Git to it while preserving resolved repository context. For split index either materialize referenced immutable dependencies into the owned scratch location, or use stable before/after observation around a read-only Git enumeration when the entire dependency identity can be proven. If neither can be proven, retain the deliberate unavailable behavior—but do not choose unavailable solely because the live Git directory is non-writable. Add readable-index/non-writable-gitdir, unrelated shared store, cache-dir failure and no-extra-live-temp regression fixtures. Do not broaden write privileges to make a cache optimization work.

### R2 [P1] S4d refreshes account state only for unknown epochs/rosters, weakening the current head-opening gate

Plan S4d says “Unknown roster/epoch triggers current account refresh” then applies current-epoch checks. An already-known cached roster can become stale while a receiver remains connected; a new malicious/replayed chain signed under that formerly active known roster is not made safe by its roster being known. The current path deliberately calls `refreshAccount()` on each `verifiedHead` (`cli/e2ee-remote.ts:504-506`), and `openCommit` rejects against CURRENT roster/epoch (`engine/e2ee/session.ts:337-355`). Binding/revoking WS sessions is valuable, but revoking a publisher does not necessarily close every recipient session; transport principal checks do not replace the recipient's E2EE authority update. An untrusted server is part of the protocol threat model.

**Correction:** preserve per-consumed-head account freshness initially, overlapping the existing refresh with fetch/prefetch. If removing the request is essential, add a separately specified authenticated account-state carrier/lease and define freshness, key rotation/revocation propagation and partial-failure bound. “Known version” must not imply “current.” Test a connected recipient with cached versionN, signer revoked/key rotated atN+1, then delivery of a newly chained frame carrying known versionN. It must be rejected under the same refreshed state as normal pull. Update request-count targets to include the preserved freshness fetch until a replacement is proven.

### R3 [P1] G1's normalization writer can be shipped before the identity-convergence mechanism that makes it safe

G1b emits a normalized private index; G1c later “proves capture identity and receiver identity agree” and leaves the raw-unmerged identity mechanism unresolved. The text itself correctly identifies endless recapture/divergence if outgoing bytes alone are normalized, but schedules the fix/proof after the writer change. The recommended first cut also calls “G1a split-index self-containment/G1b unmerged object closure,” while the package itself assigns G1a only fixtures and G1b normalization, so sub-PR IDs do not identify the same deliverables.

**Correction:** move identity characterization and exact compatibility choice before any normalization writer PR; merge normalization+matching identity derivation atomically in one release slice, or land disabled normalization implementation and explicitly gate activation until the identity roundtrip/convergence gate passes. Keep root closure as a separate safe slice only if it does not depend on normalized identity. Reconcile first-cut IDs with the package table. This does not require the roadmap to pick the new identity grammar now; it must make that unresolved decision a hard predecessor of emission.

### R4 [P2] F3 names index freshness but gives no source of invalidation; current matcher generation does not cover index-only changes

F3 plans to use existing pre/post trust checks and invalidate for imported/external indexes, but current matcher generation is driven by rule/topology rebuilds (`daemon.ts:2878-2897`). The shared Git signal surface explicitly includes HEAD/packed-refs/stash/heads/tags, not index (`engine/ignore.ts:171-175`); ignored `.git/index` changes therefore cannot be assumed to bump that generation. A `git add -f` without changing file content/HEAD/topology can produce a stale certified matcher if F3 simply routes the daemon object through existing P7.

**Correction:** specify the minimal default freshness algorithm: retain resolved index/dependency locations from F1, perform bounded identity probes for them at the pull observation boundary, and invalidate changed tracked sets before granting reuse. This achieves zero Git subprocesses for unchanged indexes without pretending the existing watcher covers them. An index event channel may later eliminate probes, but requires its own coverage/drop/fallback proof. Include the explicit index-only `git add -f`, `git rm --cached`, externally replaced index, split dependency change and no file/ref event tests. Record per-repo stat cost honestly; zero subprocesses need not mean O(changed repos) immediately.

### R5 [P2] X1c's new node carrier needs an explicit E2EE invariant before a network prototype

The Merkle proposal defines hashes, path namespaces and a root signed through the commit, then fetches immutable nodes, but does not specify encrypting node bodies or whether the signed root is a plaintext-derived commitment. Current manifests keep file paths, plaintext hashes and Git metadata inside encryption; sending canonical path-keyed node bodies or externally visible plaintext leaf/root identities would change that confidentiality surface. General “preserve E2EE” language is too easy to miss when implementing this concrete carrier.

**Correction:** add a hard protocol requirement: every path/content-bearing node is encrypted under a versioned account/workspace/key context, public blob addresses are ciphertext-derived, and the authenticated tree/root placement must avoid exposing any plaintext metadata commitment not already exposed by current protocol. Child-reference format and node/root authentication must bind order/type/context; retention/GC tracks ciphertext carriers. The first prototype can stay local; any over-network experiment requires the E2EE carrier specification. Add dictionary/cross-account equality and malformed-node substitution cases to the threat-model review. This is a design gate, not a request to invent cryptography in the roadmap.

## What is already correctly constrained

- S1 explicitly refuses to call async alarm scheduling inside transactionSync atomic without platform proof; it distinguishes bootstrap repair from recovery requiring no further request.
- S2 recognizes frozen schema fingerprint and legacy binary tolerance; collector/index migration is not presented as arbitrary v1 DDL editing.
- S3 paginated verification retains current head semantics and forbids silently truncated legacy histories.
- S5 clearly distinguishes compatible client-upload reduction from genuinely change-proportional server work; old-reader/root retention is protected.
- F2 correctly limits its70× evidence to absent-delete batches; mixed-event differential gates remain mandatory.
- F4 does not silently reset authoritative state; F5 verifies bytes and rejects mutable hardlinks; F6 keeps final authentication before publish.
- Wire experiments correctly retain readers/GC roots after writer rollback, and prior pipeline/packing regressions are not swept aside.

## Remaining specification boundaries, not defects in a staged roadmap

Exact S1 alarm primitive, S2 schema/index installation choice, F4 database location and corruption recovery ownership, G6 checkout/store identity and conflict policy, S5 incremental authenticated root, F7 chunk format and old-writer fence, X2 current-device credential proof remain open. These are real implementation blockers for their respective durable/wire slices, but the roadmap already marks most as design gates. Label each package/slice explicitly Fix/Design gate/Experiment in the package map to prevent the generic “Fix means specified implementation” statement from overstating readiness.

After R1–R5 corrections, I would accept design287 as an evidence-grounded staged roadmap. I would not authorize implementing all packages directly from it. G2/F2a and other bounded fixes can move to their focused red-test/spec dispatch; architecture/protocol packages require the named transition/compatibility supplement first. Review round2 should inspect these concrete corrections, not restart the audit or add unrelated feature requirements.
