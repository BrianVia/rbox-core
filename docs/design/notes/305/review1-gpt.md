# Review 1 — design 305

Verdict: ALIGNED.

The adversarial reviewer checked `docs/design/305-batched-scratch-pins.md` against
`SPEC.md`, `AGENTS.md`, `pins.ts`, and `pins.test.ts`, and ran the focused baseline:

```
bun test src/cli/sync-git/pins.test.ts
5 pass, 0 fail, 18 expectations
```

The review confirmed the exact `create <ref>\0<sha>\0` protocol, one creation lease,
empty-input zero-spawn behavior, original-error propagation after cleanup, atomic lock and
invalid-object failure, namespace isolation, forbidden scope, rollback, and compatibility
gates. No revision was requested.

Repository caveat: the acceptance command names `capture.test.ts`, which does not exist;
Bun ignores that path and runs the two existing named files. This is not a design blocker
and the exact command will still be run and reported.
