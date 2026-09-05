# 291 round 3 structural addendum — proposed before extraction

Status: implemented locally after this proposal; local validation passed; final independent structural review ALIGNED. Round 2 accepted the cache behavior; this addendum changes its owner boundary, not functionality. GPT-6 Astra's source inspection found one complete operation with one caller and no dependence on ignore precedence. Claude Fable 5.1 and the root GPT-6 Astra source review are aligned; this is the third and final substantive review round.

## Problem and decision

The module-size gate caught real growth plus unrelated formatter expansion in `ignore.ts`. Its baseline already used 786 nonblank lines and 36,764 bytes against effective limits of 807 and 36,789. Reversing unrelated formatting alone leaves 859 lines and 39,923 bytes. Raising a general ceiling or moving individual helpers would obscure the ownership issue: one file currently combines ignore-rule policy with native Git observation and disposable-cache persistence.

Extract the complete trackedness owner to `src/engine/tracked-repo.ts`. Keep the existing `loadTrackedRepoSet(root, relPath, known)` operation and `TrackedRepoSet` result type. Move its entire implementation together: resolved native index path, absent/committed/unborn classification, lossless identity/stat, stable-observation retry, pinned Git discovery/enumeration, result/prefix construction, cache parsing/admission/keying, and exclusive temporary-write cleanup. No index/cache phases become public. No new modes, flags, state files, parsers, feature changes or caller dependencies are introduced.

`ignore.ts` retains repository discovery, known-repository ordering, rule evaluation, pruning and matching. Its sole loading call imports the complete operation; it also imports the result type. The new owner never imports ignore.ts. Crypto, subprocess and JSON-boundary dependencies move with the effect owner. Preserve each existing argument, return field, mutable Set representation and synchronous call boundary; this is not an opportunity to revise the contract.

Ownership headers:

- tracked-repo.ts: `Never: decide ignore precedence or discover repositories.`
- ignore.ts: `Never: resolve native Git index state or own tracked-name cache admission.`

## Protected invariants and validation

Retain all round-2 behavior: warm ordinary one Git call, cold/split three, split never cached, no monitor hook, readable0555 Git metadata, native linked-worktree resolution, one complete drift retry, valid-v1 migration, malformed/future unavailable/no-overwrite, and cleanup limited to the invocation's owned temporary. Keep the public matcher tests rather than rebuilding tests around extracted helper internals. The existing child-process and filesystem spies target the same Node primitives.

First reverse unrelated whole-file formatting using the temporary three-way reconstruction already verified to reformat byte-identically to the tested candidate. Then perform the whole-owner extraction and format only the new file with the existing 140-column/no-trailing-comma convention. Approximate size before ownership comments/formatting: old file below 690 lines/31.3KB; new owner below 200 lines/9KB. The new owner must pass the unexcepted 400-line/25KiB bound. Record actual final measurements and tighten the existing ignore ratchet to that measured size; do not add a new exception or raise a ceiling.

Run the focused ignore+manifest suite under supported Bun1.4.0, root/API/scripts typecheck, targeted oxlint, and the module-size gate. The parent owns manifest's separate cohesion decision and its gate failure. Root independently reviews the source movement and dispatches the final Claude review with exact executed evidence. No fourth review round is planned: a remaining structural disagreement requires cutting or reframing this addendum.

No supported functionality or compatibility branch is approved for deletion. The source locations and import ownership change; cache schema, cache paths, matching outcomes, subprocess budgets and failure behavior do not.

## Executed extraction evidence

Only the existing complete operation and result type cross the boundary. `tracked-repo.ts` imports Node primitives and `src/json.ts`; it imports no matcher or CLI module. Repository discovery, rule ordering, tracked-path policy and purge refusal integration stay in `ignore.ts`. The operation's internal code and cache behavior were preserved, then only the new file was formatted. Existing matcher-level tests were unchanged.

Actual sizes: `ignore.ts` **676 nonblank lines / 31,292 bytes**; `tracked-repo.ts` **188 / 8,918**. The existing ignore ratchet was tightened from 734/33,445 to 676/31,292; its existing exception reason now names the extracted owner. No new exception or global budget increase was introduced for F1. Parent-owned manifest budget changes are separate.

Supported Bun1.4.0 validation after the move:

- `bun test src/engine/ignore.test.ts src/engine/manifest.test.ts`: **70 pass, 0 fail, 1,102 assertions**. Output `/private/tmp/rbox-291-round3-tests.txt`.
- `bun run typecheck`: root/API/scripts clean.
- Targeted oxlint on ignore.ts, tracked-repo.ts, ignore.test.ts and file-size.test.ts: clean.
- `bun test src/cli/state-plane/file-size.test.ts`: **6 pass, 0 fail, 189 assertions**, after the parent's independent manifest budget repair was present. Output `/private/tmp/rbox-291-round3-modulegate.txt`.
- Scoped `git diff --check`: clean.

No commit or external actions. Final Claude round-3 verdict is ALIGNED; [the review record](../../reviews/REVIEW-291-3.md) distinguishes supplied evidence from the parent source review. The compiled integration rerun remains parent-owned and was running when this note was updated.
