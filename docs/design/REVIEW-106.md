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
