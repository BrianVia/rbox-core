# Review 187 — recovery-phrase destination

## Round 1

**Reviewer:** GPT adversarial review

**Result:** CHANGES REQUIRED — 2 P1, 4 P2

1. **P1 — non-genesis saves lacked a durable operation marker.**
   Accepted. Tranche 1 is now fresh genesis only. Non-genesis multi-destination
   writes are deferred until a provider-operation journal exists.
2. **P1 — zero list results were treated as proof of no provider write.**
   Accepted. A zero result after an ambiguous create never authorizes another
   create. Tag results are post-filtered for exact equality because 1Password
   tag queries include subtags.
3. **P2 — “protected file” obscured plaintext storage.**
   Accepted. The choice now says the phrase is plaintext and mode-restricted to
   the current user.
4. **P2 — authorization copy assumed desktop-app integration.**
   Accepted. Copy is neutral about sign-in/approval and the zero-account path is
   explicit.
5. **P2 — the walkthrough could record a generated recovery phrase before
   redaction.**
   Accepted. The design now requires a test-only staged fixture seam, fake
   sinks that discard stdin, and an artifact gate rejecting any BIP39-shaped
   24-word line.
6. **P2 — the existing clipboard helper reports success before child exit.**
   Accepted. Recovery phrase copying gets a bounded async zero-exit-confirmed
   helper with buffer wiping and failure tests.

## Founder ruling after round 1

The founder explicitly requires a true multi-choice/multi-select:

- 1Password when `op` exists;
- macOS Keychain on macOS;
- plaintext file;
- clipboard;
- any combination selected with checkboxes.

The single-destination recommendation is superseded. Design v3 introduces an
immutable bounded destination-set intent plus monotone per-destination progress.
Selected destinations are not falsely described as atomic: all are attempted,
partial success is summarized, and continuing with successful copies requires
explicit confirmation.

The founder also required nontechnical lead-in copy explaining that the phrase
encrypts the uploaded copy before it leaves the computer, while local files
stay normal and usable. The encrypted cloud copies remain private even from
rbox. GitHub and other source control remain separate; rbox's encrypted copy
also protects uncommitted work. The phrase cannot be reset if every signed-in
device is lost.

## Alignment status

- GPT: PASS at round 6 on v7.
- Claude: not run. The local Claude OAuth session was unavailable.
- Fable: permanently excluded by founder instruction.

## Round 2

**Reviewer:** GPT adversarial review

**Result:** CHANGES REQUIRED — 2 P1, 4 P2, 1 P3

1. **P1 — provider create dispatch was not durably distinguished from a
   never-started attempt.**
   Accepted. Progress now has prepared and may-have-dispatched events persisted
   before spawn, with conservative ambiguity in the narrow pre-spawn window.
2. **P1 — completed evidence could disappear before final receipt.**
   Accepted. Live receipt eligibility rechecks artifacts, appends an
   invalidation event, excludes invalidated completions from the threshold, and
   supports same-target repair or witnessed replacement.
3. **P2 — partial success offered Change while the state machine forbade it.**
   Accepted. The UI says `Change incomplete choices`; a two-file witnessed
   intent/progress replacement carries valid completions byte-for-byte.
4. **P2 — absent-CLI copy pointed to deferred `rbox key save` functionality.**
   Accepted before the round completed. Copy now directs users to select
   Clipboard and paste into 1Password manually.
5. **P2 — subprocess environment conflicted with manual 1Password sessions.**
   Accepted. The adapter allowlists required process/locale plus `OP_*`
   variables, treats provider sessions as secrets, and strips rbox/cloud/CI
   credentials.
6. **P2 — Clipboard omitted exposure and clearing.**
   Accepted. The choice discloses clipboard history/app/sync exposure, and
   completion requires confirmed paste plus confirmed clear or explicit manual
   clearing.
7. **P3 — macOS had no default if Keychain preflight failed.**
   Accepted. Plaintext file becomes the preselected fallback.

## Round 3

**Reviewer:** GPT adversarial review

**Result:** CHANGES REQUIRED — 2 P1, 3 P2

1. **P1 — the provider event log could not authorize a safe retry.**
   Accepted. Every create attempt has an ID and durable prepared,
   may-have-dispatched, and authoritative-no-write states. Only the final state
   authorizes a new attempt.
2. **P1 — live evidence lacked an unverifiable state.**
   Accepted. Verification is now valid/invalid/unverifiable. Unverifiable
   evidence neither counts nor invalidates, and may be retried or replaced while
   other live-valid completions are carried.
3. **P2 — wildcard `OP_*` inheritance enabled excluded auth modes.**
   Accepted. The environment allowlist now names supported interactive values
   and session-key grammar while stripping service-account, Connect, debug, and
   format controls.
4. **P2 — invalidated provider locators survived as apparently active.**
   Accepted. `kit.json` durably marks the exact locator invalid before progress
   invalidation, and status renders it as invalidated history.
5. **P2 — zero-account copy overpromised `op signin`.**
   Accepted. Copy neutrally directs users to sign in or add an account through
   the 1Password app/CLI.

## Round 4

**Reviewer:** GPT adversarial review

**Result:** CHANGES REQUIRED — 2 P1, 2 P2

1. **P1 — authoritative-no-write was not concretely classifiable.**
   Accepted. No provider response qualifies. Only local child-not-started
   ENOENT/EACCES events authorize a new create attempt; the event reason is a
   strict enum.
2. **P1 — manual `OP_SESSION` was excluded.**
   Accepted. The allowlist includes exact `OP_SESSION` and bounded documented
   suffixed session names, with positive process tests.
3. **P2 — receipt wording included stale historical completions.**
   Accepted. Receipt contains only the folded live-valid set plus the exact
   final-progress digest; invalidated/unverifiable entries cannot count.
4. **P2 — durable locator invalidation was modeled only for 1Password.**
   Accepted with scope correction. 1Password requires persisted invalidation
   because ordinary status does not probe it. Keychain/plaintext keep their
   existing live-probe missing/unrecognized behavior; progress invalidation
   governs genesis receipt eligibility.

## Round 5

**Reviewer:** GPT adversarial review

**Result:** CHANGES REQUIRED — 1 P2

1. **P2 — the pre-consent install probe inherited provider session secrets.**
   Accepted. `op --version` now uses a separate minimal environment with no
   provider account/auth/config variables. The provider-session allowlist is
   activated only after explicit 1Password selection.

## Round 6

**Reviewer:** GPT adversarial review

**Result:** PASS — no remaining P1/P2 correctness, security, or onboarding
blockers.

## Round 7 — post-implementation adversarial review (PR #408)

**Reviewers:** two independent reviewers (Claude/Opus + a second independent
review), run against the implemented branch, not the design.

**Result:** NOT-MERGEABLE — 2 BLOCKERs, plus MAJOR/MINOR follow-ups. All fixed
on the branch; entry recorded so the history stays truthful.

**The lesson — the frozen-2030 clock hid the flagship feature being broken.**
Every destination-set/1Password test pinned `now: () => 1_900_000_000_000`
(year 2030). `completeGenesisDestinationSet`'s `eventAt()` clamps to
`max(realNow, progress.updatedAt)`, so with a far-future injected `now` every
call returned the *same* constant string. That masked all wall-clock behaviour.
On a real clock (`Date.now()`) the feature failed 100% of the time. A pinned
far-future clock must never be the only coverage of timestamp-bearing flows.

1. **BLOCKER — 1Password (and latently every) completion failed on a real
   clock.** `parseDestinationEvent` required `completion.completedAt === at`.
   The caller sampled the clock twice (once for the completion, once for the
   event), and for 1Password an `await recordOnePasswordArtifact` (a durable
   kit.json write) sat between the two samples, so `at` landed a millisecond
   later → `"completion event timestamp mismatch"` → the verified, recorded save
   was reported as failed.
   Fixed per founder guidance by *removing the manufactured strictness*: dropped
   the equality requirement in the parser (the completion is embedded in and
   bound to the event; only `at` drives the fold's monotonicity, which is
   retained) and made the caller derive the event `at` from the completion's own
   authoritative timestamp (a single sample per completion). Reproduced with a
   `Date.now()` test that is now a permanent regression.
2. **BLOCKER — retry/resume wedge.** After a crash between the provider write and
   the durable progress append, resume re-recorded the same verified item with a
   freshly sampled `writtenAt`; `recordOnePasswordArtifact` hard-errored on
   `"conflicting 1Password artifact identity"` and the destination could never
   complete. Fixed by making the re-record idempotent for a byte-identical active
   item identity (same account/vault/item UUID, operationTag, field, rbox
   account), tolerating `writtenAt` drift and keeping the original record. A
   genuinely different operationTag/field still fails closed.
3. **MAJOR (UX) — declined/ambiguous 1Password create was a Retry dead-end.**
   The fail-closed invariant (never create a duplicate once may-have-dispatched)
   is correct and kept, but the copy promised "rbox will reconcile it before
   retrying" while plain Retry could only re-throw. Copy now tells the user to
   pick "Change incomplete choices" to set up 1Password again.
4. **MINOR — clipboard decline left the phrase on the clipboard.** Declining the
   "did you paste and save it?" confirmation now best-effort clears the clipboard
   before failing, honouring the disclosure's promise.
5. **MINOR — invalidation reason was hardcoded `mismatch`.** Now records
   `missing` vs `mismatch` from the actual probe (keychain/file missing →
   `missing`; wrong-content file or 1Password readback mismatch → `mismatch`).
6. **MINOR — silent orphan on Change.** Replacing an incomplete 1Password choice
   that reached may-have-dispatched now prints a non-blocking note that an
   unconfirmed item may remain in the vault (design's failure semantics), without
   claiming it is absent.
7. **NIT — `attemptOnePasswordRecoverySave`** is not called by the production
   genesis flow (which drives the primitives directly to interleave durable
   progress); documented as test-only. The v3 kit.json bump and `op` 2.x version
   gate were left as-is.

**Verification:** `bun run typecheck`, `bun run guards`, and the focused suites
for auth-cmd, genesis-durable, recovery-kit, recovery-kit-1password,
recovery-secret-clipboard, json-output, prompt (+ genesis-seam/enrollment) all
green, including the new real-clock regressions.
