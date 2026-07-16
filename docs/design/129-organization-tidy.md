# §129 — behavior-identical organization tidy

> **Status: implemented — 2026-07-16.** This change is structural only: moves, import
> rewrites, identical re-exports where required by an existing public surface, and
> documentation. No signatures, control flow, constants, or runtime behavior change.

## Move map

- Move ambient daemon status, watcher, watcher self-test, and drift-audit modules
  from `src/cli/` to `src/cli/daemon/`; move the exact matching
  `ambient-status.test.ts` and `watcher.test.ts` tests. Keep broader integration
  tests (`watcher-compiled`, `watcher-retrust`, and design-85 measurement) in place
  and rewrite their imports and embedded source path. Rewrite every repository
  consumer directly and leave no compatibility shims.
- Move `git-deferral-json.ts` and its test to `src/cli/sync-git/`; rewrite direct
  consumers and leave no compatibility shim.
- Move the release manifest contract and its byte-identical signature verification
  helpers (`Manifest`, `Artifact`, `releaseSigningInput`,
  `verifyAndParseManifest`, and their private domain constant) from
  `upgrade-cmd.ts` to `release-verify.ts`. The upgrade, doctor, update-check, release
  verification, and tests import the single implementation from its new owner.
- Move `readBodyCapped` and its unchanged `readBytesCapped` dependency together
  from API commit-envelope parsing to `util.ts`; all production consumers import
  both helpers directly from `util.ts`. Preserve the requested old
  `commit-envelope.ts` surface with a one-line re-export of `readBodyCapped` only;
  this avoids a `util.ts` → feature-module dependency cycle without duplicating or
  editing the reader logic.
- Move `packKey` from API blob-pack behavior to `util.ts` beside `blobKey`; rewrite
  production and test imports directly.
- Move `DIVERGENCE_SAMPLE` from commit-delta feature logic to `metrics.ts`; delta
  logic imports the constant from metrics, removing the reverse metrics-to-feature
  edge. Tests import it from its owning module.

Moves use `git mv`; file bodies and export signatures remain byte-for-byte identical
apart from the imports required by their new paths. Tests move only when they match a
moved source by name.

## Engine barrel prune

Inventory every value and type name re-exported by `src/engine/index.ts` against
all repository code outside `src/engine/`. Remove every name with no external
occurrence; an internal engine use is not a reason to retain a barrel export because
engine modules import siblings directly. The seven pre-verified candidates are
`prepareDisplacedRefPins`, `parseMajor`, `minMajor`, `satisfiesMajor`,
`zstdCompress`, `indexByPath`, and `gitCaptureScratchRoot`; any additional removal
requires the same zero-external-consumer evidence.

## Ownership documentation

Extend `docs/CODEMAP.md` with the requested API Worker cluster map, daemon and
sync-git relocations, CLI telemetry modules, and the six explicitly sanctioned
Worker-to-engine wire-protocol modules. This records organization only; ownership
and behavior do not change. Add the currently implicit `blob-pack.ts` and
`manifest-chain.ts` imports to `apps/api/tsconfig.json#include` beside the other
four sanctioned modules so the documented six-file boundary is explicitly pinned;
this changes typecheck roots only, not runtime code.

## Validation

- Inspect the diff for rename detection and prohibit non-import/non-documentation
  body changes.
- `bun run typecheck`
- `bun test src/cli src/engine`, recording only the two named pre-existing failures
  if they reproduce.
- `bun run test:api`, or record a sandbox-specific inability to run it.
