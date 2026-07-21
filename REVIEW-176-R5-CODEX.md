# REVIEW-176-R5-CODEX — focused review of §4 amendment v5

Scope is only the v5 decision to admit `local-index` to the held-skip
allowlist. The `local-index` classifier consumes five facts: live index
presence and `indexIdentityV2` projection; BASE index presence and projection;
incoming index presence and projection; and the comparison that the live value
matches neither BASE nor incoming. BASE projection comes from `RepoRecord.idxProj`
when present, otherwise from the decrypt-verified BASE artifact; incoming
projection comes from the staged, decrypt-verified incoming artifact
(`follow.ts:400-428,467-481,1032-1048,1062-1085`). That inventory exposes two
inputs and one ordering edge not covered by the amendment's stated argument.

## Findings

1. **BLOCKER — the blocker-producing classification is outside the attempt fingerprint bracket, so an index repair can be recorded as the fingerprint for a stale `local-index` blocker.**

   `classifyCheckout` reads and classifies the live index during
   `followDivergedRepo`; only after that function returns does apply call
   `recordAttempt`, whose `observeHeldInputs` takes its own before/after
   fingerprints (`apply.ts:1136-1155,1294-1300`; `held-skip.ts:118-155`). An
   index change after classification but before line 1139 is therefore seen by
   both sides of the later bracket. The resulting attempt stores the *new*
   index fingerprint with the *old* `local-index` blocker. If the change made
   the index equal BASE or incoming, a later pull can skip the full follow even
   though the hold is now unblocked.

   The racy-clean margin does not repair this ordering. It only refuses a match
   while an observed stat timestamp is within two seconds of the current match
   (`held-skip.ts:166-176`). Once that timestamp ages—or immediately for a
   sub-1 MiB index, whose token is content-hashed and carries no index
   timestamp—the stale blocker/fingerprint pairing is eligible. The one-hour
   floor eventually discovers it, but that contradicts “any index mutation
   voids the attempt and forces a full follow.”

   Minimal fix: bracket the exact classification whose blocker set is
   persisted: take a trusted fingerprint before that classification and the
   matching fingerprint only after every classification/composer input has
   been read, recording no attempt if they differ. If rbox-authored mutations
   make that impractical, rerun the complete classification inside a final
   stable bracket. Add a seam that changes the index from divergent to
   BASE/incoming after `classifyCheckout` but before attempt recording; after
   the margin ages, the next pull must full-follow rather than skip.

2. **MAJOR — BASE's effective projection cache is a classification input but is absent from the attempt identity; incoming transport identity is also weaker than the prose suggests.**

   The BASE section itself is covered: `baseOriginsHash` hashes the exact bound
   BASE plus origins (`held-skip.ts:136-154`), so a changed BASE index artifact
   descriptor invalidates the attempt. But classification normally prefers
   `record.idxProj` over re-deriving that artifact (`follow.ts:1037-1047,
   1082-1085`), and `observeHeldInputs` neither hashes nor records `idxProj`.
   Thus `idxProj` can change without `baseOriginsHash`, `incomingKey`, or
   `gitFingerprint` changing, while changing whether the live index matches
   BASE. This is not theoretical in the state model: `idxProj` and `attempt`
   are independent merge fields, so an idxProj repair can be saved while the
   old attempt is preserved.

   Incoming semantic index bytes are substantially covered because
   `gitIncomingKey` binds `indexSha`; authenticated decryption means a different
   successful encoding with the same plaintext SHA cannot yield a different
   projection. It does **not**, however, bind `indexEncSha`,
   `indexCipherSize`, `indexComp`, or `indexPayloadSha`
   (`shared.ts:83-100`). A changed locator/encoding can therefore turn staging
   from successful to unreadable/artifact without changing the attempt key.
   That is at least an outcome/availability input omitted by the blanket
   “incoming section” coverage claim, even if equal plaintext makes the
   successful projection semantically equivalent.

   Minimal fix: add the effective BASE projection (including absent) and the
   effective incoming projection to `HeldInputObservation`/`GitHeldAttempt`,
   and compute them inside the stable classification bracket. Either bind an
   exact canonical incoming artifact descriptor as well, or narrow the design
   claim explicitly to semantic plaintext identity and justify why transport
   availability changes may wait for the floor. Add idxProj-only and
   same-`indexSha`/changed-locator invalidation tests.

3. **MAJOR — `gitFingerprint` covers `.git/index`, but not every file read by the live semantic projection.**

   `indexIdentityV2` deliberately places its private copy beside the source so
   Git can resolve a split index's `sharedindex.*` dependency
   (`index-identity.ts:48-66`). `gitDirFingerprint`, however, tokens `index`,
   locks, HEAD, config-worktree, and op-state only; it does not token any
   `sharedindex.*` file (`fingerprint.ts:268-277`). A referenced shared-index
   file can disappear, appear, or change while `.git/index` remains unchanged,
   changing live projection from a value to indeterminate (or changing its
   value) without invalidating a held attempt. The amendment's “index file is
   inside the fingerprint” premise is therefore insufficient for split-index
   repositories.

   Minimal fix: make held-skip fingerprint the exact referenced shared-index
   dependency with the same hash/stat+racy-clean discipline, or normalize the
   live index into a self-contained snapshot while a bracket proves both the
   index and shared-index inputs stable. Fail open to a full follow when that
   dependency cannot be enumerated. Add a split-index test that mutates or
   removes only the referenced `sharedindex.*` file.

4. **INFO — admitting `local-index` does not itself weaken composer ref mapping or the non-empty rule, provided the implementation changes only eligibility.**

   `local-index` has checkout provenance and no ref, so it cannot satisfy the
   existing causal mapping, which remains explicitly limited to ref-plane
   `local-commits`/`missing-branch-proof` and
   `local-stash`/`missing-safe-ref-proof` pairs (`held-skip.ts:55-63`). Any
   unmatched composer hold therefore still becomes a non-allowlisted artifact
   blocker, and checkout-incomplete remains blocking. The merged set is also
   non-empty because `local-index` is itself a classifier blocker. There is no
   additional composer authority supplied by this amendment.

   Minimal fix: none to the mapping contract. Pin it with a mixed test whose
   classifiers are `{local-commits, local-stash, local-index}` and with controls
   for an unmatched same-ref composer code and `checkoutComplete:false`; only
   the exact mapped triple may qualify.

Verdict: CHANGES-REQUIRED
REVIEW-COMPLETE
