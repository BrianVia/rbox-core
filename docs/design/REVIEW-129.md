# REVIEW-129 — organization tidy

Review rounds for §129. The acceptance bar is agreement that every runtime edit is
a relocation, import rewrite, or removal of an externally unused barrel re-export.
No logic or signature change is admissible.

## Round 1

**Codex: NEEDS WORK.** The draft did not pin the two shared engine modules missing
from API tsconfig, did not spell out the capped-byte-reader dependency closure, was
ambiguous about exact matching tests, and did not explicitly include zero-consumer
type exports in the barrel audit.

**Resolution:** §129 now moves the unchanged capped readers together while retaining
only the explicitly requested old-path re-export; names the exact moved and retained
tests plus the compiled-test path rewrite; pins all six sanctioned modules; and
requires the same whole-repo zero-consumer proof for value and type re-exports.

## Round 2

**Codex: PASS.** Moving the unchanged byte-reader dependency closure keeps the
graph acyclic, while the one-line `readBodyCapped` re-export preserves the requested
old surface. Exact test moves, embedded paths, six tsconfig pins, and the value/type
barrel audit are fully specified. Both reviewers are aligned; implementation may
proceed against §129.

## Implementation review

Simplification and antislop passes confirmed that moved bodies and signatures are
unchanged, all executable imports resolve directly, and every remaining engine barrel
export has an outside-engine barrel consumer. Duplicate imports found during review
were combined. The `readBodyCapped` re-export remains because the brief explicitly
requires `commit-envelope.ts` to re-import it; `watcher-compiled.test.ts` remains the
root-level compiled integration test while the exact `watcher.test.ts` source test moved.
