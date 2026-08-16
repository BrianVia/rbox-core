Implemented FOLD-268-R1 completely. The verified working tree is unstaged because `.git` is read-only; the commit attempt failed creating `index.lock`. No work was lost, and the pre-existing `CODEX-268-IMPL-R1.md` remains untouched.

### Per-item disposition

- CRITICAL-1 — Done: global ordinal acquisition records, 4,096-lock cap, 4,099-record cap, 8 MiB line cap, 16 MiB v2 total, unchanged 1 MiB v1 admission, duplicate/out-of-range rejection, capacity tests.
- CRITICAL-2 — Done: single-use release handle is the sole normal release owner; acquisition failures clean internally once; raw public release, `retainJournal`, and acquire-failure flags removed. Production-wrapper regression added.
- MAJOR absent-parent recovery — Done: nearest existing bounded ancestor is fsynced before first-pass retirement.
- MAJOR forged journals — Done: fixtures are newline-terminated and the unmodified-header negative control parses.

- MINOR-1 — Single EOF suffix pop documented.
- MINOR-2 — Receipt/brand/WeakMap ceremony replaced by batch `#flushed` assertion.
- MINOR-3 — CAS counts separated from timing milliseconds.
- MINOR-4 — No-CAS formatting returns empty/undefined.
- MINOR-5 — Dead `PreparedStateCasLocks.root` removed.
- MINOR-6 — `#ensureOpen()` returns its handle; meaningful distinct bounds enforced; ternary statement removed.
- MINOR-7 — Compatibility test uses the real exported v1 parser.
- MINOR-8 — Staged-token/readback hardening is CAS-batch-only; generic locking retains its original path.
- MINOR-9 — `format.ts` drive-by restored exactly.
- Design/CODEMAP — Updated §M1, §M2, §M2.5, validation evidence, and module ownership. Primitive-first review led to coherent recovery and loader modules rather than size allowlists.

Additional correctness found during validation: production identities are canonicalized before strict journal encoding, preventing internal `knownBoots` metadata from invalidating a journal.

### Gates

| Gate | Result |
|---|---|
| Preflight lock test | 32 pass |
| `test:affected` iteration 1 | 4,601 pass, 15 skip, 1 fail; stale path-record fixture fixed |
| Iteration 2 | 4,602 pass, 15 skip, 4 fail; three in-scope regressions fixed, one environment-sensitive heap test |
| Iteration 3 Bun closure | 4,608 pass, 15 skip, 0 fail across 310 files |
| Iteration 3 affected API test | 15 pass, 0 fail |
| Full `bun test src/cli src/engine` | 5,517 pass, 20 skip, 0 fail across 406 files |
| Typecheck | Pass |
| `lint:affected` | Exit 0; zero new warnings, three unchanged baseline warnings |

The stock iteration-3 wrapper exited nonzero only because Vite attempted to write under read-only shared `node_modules/.vite-temp`; the same affected API test passed using the supported runner config loader.

Near-cap N=2000 locked journal: **1,317,414 bytes**.

Goal runtime: approximately 54m 44s.