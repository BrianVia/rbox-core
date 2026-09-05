# 291 review 2 — aligned

On 2026-09-05, Claude Fable 5.1 (`claude-fable-5-1`), medium effort, returned **ALIGNED**, with no blocking defects. This was a supplied-text design/evidence review: the reviewer did not independently inspect the working tree or execute tests. GPT-6 Astra performed the local source review and supported-runtime implementation checks recorded in [the validation notes](../notes/291/implementation-validation.md). The successful structured verdict is retained in [round2-claude-fable-result.json](../notes/291/round2-claude-fable-result.json).

This completes substantive round 2. Its earlier invocation emitted unavailable tool calls as text and produced no verdict; retrying that failed invocation is not an additional formal review round. Round 1 required stronger identity witnesses and proposed changing corrupt-cache behavior. The replacement and in-place witnesses now pass; the always-fresh corruption fallback was rejected because it would remove the protected existing unavailable/no-prune contract. Fable accepted that disposition.

The review accepts the lossless identity token, validation before freshness checks, one complete retry, ordinary-only cache publication, split fresh enumeration, and preserved malformed/future-record refusal. Supplied execution evidence: Bun 1.4.0, 70 tests passing with 1,102 assertions, clean typecheck and targeted oxlint; ordinary warm/cold/split subprocess budgets of 1/3/3.

Non-blocking dispositions:

- The suggested per-invocation unique temporary filename is already implemented: PID plus four random bytes, exclusive `wx` creation, and cleanup only after this invocation acquired the temporary file. No stale-temp sweep is introduced.
- The compiled rig should additionally assert live main-index bytes/identity remain unchanged during cold pinned discovery with repository `core.splitIndex=false`. Unit fixtures already verify source bytes, no monitor-hook invocation, and read-only metadata acceptance; compiled integration remains the parent task's gate.
- Legitimate concurrent Git index refreshes can change ctime or inode and cause safe cold misses. The deferred 100-repository latency pass should record cold-miss frequency so these invalidations are not mistaken for additional subprocesses on a valid warm hit.

No source changes, deployment, or new test run occurred while recording this review.
