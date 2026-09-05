# 306 review 1 — not aligned

The adversarial source review found that the first draft reused the wrong
context. `preCaptureRepoCtx` is populated before classification, while the
fingerprint probe resolves a separate fresh `diskCtx`; pending, recovery,
busy, and slow carries also do not necessarily have a fingerprint hit. The
initial `rev-parse` assertion was vacuous because this checkout's
`repoCtxFromDisk` is already filesystem-only.

Required revision: retain the actual fingerprint `diskCtx` only for a proven
trusted-hit carry, preserve fresh reads for every other capture/carry path,
and add a direct context-read oracle.
