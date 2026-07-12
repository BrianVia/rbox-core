# Review ledger — design 106

## Round 1 — GPT

Verdict: REVISE. It required explicit raw-v0 terminal hashing, LRU accounting,
one-pass linkage state, honest high-water memory methodology, real pre-fix
evidence, and bounded scalar serialization.

## Round 1 — revision

All findings accepted and addressed in §§4–6.

## Round 2 — GPT

Verdict: REVISE. Remaining issues were conditional rather than deterministic
LRU eviction, unbounded whole-string escaping, and ambiguous shared-process HWM.

## Round 2 — revision

All accepted. Uncached folds now clear stale cache entries unconditionally;
string escaping is incremental; focused measurement is specified in a fresh
process.

## Rounds 3–4 — GPT and revision

Round 3 required isolated RSS execution, recursive fallback outside bounded
flat FileEntries, fold-as-fetch cold walking, and timing tests. Round 4 required
non-empty nested `gitRepos` fuzzing plus raw/snapshot timing coverage. All were
accepted and implemented. Final verdict: **ALIGN**.

## Round 5 — external review

| Attack | Result | Disposition |
|---|---|---|
| Verification weakening (`trustedBaseHash`, raw-v0 terminal, fast guard) | Not landed | Production trust inputs are freshly verified snapshot/raw hashes, preceding verified `resultHash`, or exact guarded persisted evidence; every delta result remains hash-verified. |
| Corrupt/stale `manifestMeta` or `lastSyncedManifest` | Not landed | Bad evidence can demote or fail closed; the authenticated `resultHash` prevents a wrong folded manifest from applying. |
| Memory-bound honesty | Landed, fixed | Independent lifetime-HWM subtraction could mask fold allocation; the parent now samples the fold child's Linux `VmRSS` only after a setup-complete handshake. |
| Benchmark realism | Landed, fixed | The 124k entries were all files despite the mixed-type contract; the sorted dataset now includes deterministic encrypted-shape symlinks and files with fractional mtimes. |
| Streaming-hash byte identity | Landed, fixed | An invalid-surrogate object key with an omitted `undefined` value escaped validation; key validation now precedes omission and a regression covers it. Other boundary/escape/number/size/depth attacks matched the reference. |
| Cold-walk fetch concurrency | Landed, fixed | All signed-chain ciphertexts are fetched concurrently with indexed missing-link attribution, then serially decrypted/decoded/folded and nulled as consumed; timing and byte accounting remain separated. |

Final verdict: **ALIGNED** — no open findings.

## Round 2 fold follow-up — GPT adversarial review (2026-07-12)

The review attacked shortcut placement, historical-read leakage, signed-prefix
indexing, suffix address substitution, first-link and head linkage, trusted-hash
threading, result-hash omission, snapshot injection, missing-link retry, byte
accounting, and fold-count off-by-one errors. The implementation keeps the
same-head return after verified-head structural checks but before any blob/LRU
work; restricts it to current heads; accepts only an element-wise evidence
prefix; authenticates every new signed address; recomputes every fold result;
and fails closed without cold-walk retry after guard acceptance. Accounting and
`foldLinks` semantics match the specification. Verdict: **ALIGN**, subject to
the recorded R1–R4 and full-suite validation gates.

## Round 2 external follow-up — counterpart + Codex adversarial review (2026-07-12)

| Attack | Result | Disposition |
|---|---|---|
| Same-head and prefix epoch substitution | Landed, fixed | Both guards require signed key/account epochs to equal the evidence epochs; mismatch demotes to the cold walk and preserves its precise AAD failure. |
| Duplicated suffix/cold link walkers | Landed, fixed | One private helper owns parallel link fetch, serial open/decode/kind/linkage/fold, slot release, timing, and snapshot/delta accounting for both starting modes without changing error strings or attribution. |
| Corrupt carried manifest with valid metadata + crafted suffix | Landed, fixed | Evidence manifest bytes are hashed against the persisted verified hash before either shortcut; mismatch demotes to the authenticated cold walk. |
| Zero-fetch hostile server/signer variants | Refuted | Verified-head pin/signature/account gates plus exact address, chain, epoch, and evidence-hash equality cover rollback, body-field reuse, raw-v0, and empty-chain snapshot cases. |
| Fold counts and timing across evidence/cold/snapshot/raw | Refuted | `foldLinks` remains the exact `foldDelta` call count; head/link download and AEAD-open timing remain separated while decode/fold stays parse time. |
| Daemon-path test realism | Refuted; assertion tightened | R1–R3 call real `pull()`/`push()` through live env reads; R3 now compares sorted arrays so duplicate fetches cannot pass. |
| Fast-path metadata comment | Landed, fixed | It now says suffix folds never refetch the terminal snapshot, rather than claiming no chain fetch. |

Focused typecheck and the three mandated suites passed (58 tests, 468
expectations). Final verdict: **ALIGNED** — no open findings.

## Round 3 fold follow-up — counterpart-reviewed convergence (2026-07-12)

The round-2 evidence hash was correctly fail-safe but eagerly imposed an O(N)
pass on guard misses, every same-head daemon poll, and all suffix folds. F1 now
checks epochs and exact signed identity first, reuses only fully verified folds
from the exact-key LRU, and hashes/caches carried state only on an LRU miss. F2
has no evidence pre-hash: its persisted trusted base hash and every delta
`resultHash` remain the fail-closed correctness authority. Corrupt same-head
state cold-walks and self-heals, then the repaired fold is reused at zero fetch.

Verdict: **ALIGNED** — the placement/cost regression is removed without
weakening the evidence trust anchor or round-1 current-head roster gates.
`bun run typecheck` and the three mandated test files passed: 60 tests and 478
expectations.

## Round 3 evidence-carriage follow-up — GPT adversarial review (2026-07-12)

The review attacked packet atomicity, reconstruction identity, contextual git
section validation, chronic pending behavior, pre-upgrade state, and writer
delta eligibility. It agreed that verbatim `gitRepos` makes evidence independent
of repo projection while preserving the global CAS. The revision uses one
explicit reconstruction helper for both consumers, reuses the manifest
git-section validator, and retains fail-closed F1/F2/result-hash checks. The
contextual-validator limitation is recorded conservatively: legitimate producer
data is fully validated, while corrupt reconstructed state still demotes or
fails closed. R5 uses real busy-repo pull deferral; R6 uses a repo-record pending
transition through real push. Final simplify/anti-slop review required a writer
regression for structurally valid but context-invalid evidence; the real-push
test proves full-manifest validation demotes it to a snapshot without throwing.
Verdict: **ALIGN**.

## Round 3 uncommitted-change adversarial review (2026-07-12)

The review compared the extracted validator against its former inline body,
traced every evidence producer, consumer, and state writer, checked deferred
writer target identity and peer folding, and exercised upgrade and benchmark
behavior. No implementation defect landed. Two coverage gaps did: malformed
metadata now explicitly pins rejection of an Array `gitRepos`, and R6 pins the
peer-folded target's `gitRepos` after both deferred delta commits. Round 3 also
records the sanctioned evidence-drop channels in design 106 for field triage.

Refutations: `validateManifest` preserves every prior rule, error, schema gate,
and first-error order by passing its file-path set and validated schema into the
shared helper; standalone evidence validation may use schema 4 and no file set
because producers describe already-validated manifests, F1/F2 verify hashes,
and both apply and writer paths run full reconstructed-manifest validation before
trusting contextual collisions. Packet CAS and one atomic state write keep the
file layer and meta paired; repo-only transitions alter only projection. Delta
and snapshot encode the identical committed target from the git plan, while
`resultHash` makes a successful peer fold canonical-target exact. The new map is
referenced in memory and serialized only by the existing state write, so the
engine benchmark path is unchanged. Pre-R3 metadata demotes to one cold walk.

Validation: `bun run typecheck`; mandated targeted suites plus the adjusted
validator suites (`engine-m1.test.ts` and `git-nested.test.ts`, because the
requested `manifest-validate.test.ts` does not exist) passed: 109 tests, 672
expectations, zero failures. Benchmark: 625.9 ms, +44,872 KB isolated peak RSS
against a 90,790 KB allowance. Final verdict: **ALIGNED — no open findings**.
