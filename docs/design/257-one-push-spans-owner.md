# design 257 — one PushSpans owner

## Verdict

Create one `PushSpans` for each bounded `pushManifest` operation and pass it
through every retry iteration. It owns the existing `PhaseReport`, first-publish
measurement state, upload-lane totals, and missing/commit tail samples behind
`span(name, fn)` and `note(name, value)`. One async-local context carries that
single object to the upload and HTTP leaves.

This is sink consolidation, not a new timing authority. `PhaseReport` continues
to own wall time, phase transitions, gaps, rendering, and the bounded telemetry
projection. In particular, `git-plan` still encloses candidate preparation,
`commit` still means the remote commit transition, and `state-save` still means
the durable acknowledgement writes. Detail clocks do not rename or narrow those
transitions.

## Protected-functionality ledger

| Contract | Protection |
| --- | --- |
| Human output | Push phase lines, detail token order, labels, rounding, separators, and first-publish/lane/tail summaries remain byte-identical. A differential fixture compares the old formatter transcript with `PushSpans` output. |
| Phase authority | The same `PhaseReport` instance receives the same `phase`, `record`, `recordDetails`, and `appendDetails` calls. Its wall/phases/gaps/rendering implementation is unchanged. |
| Named detail spans | `drain_wait` remains appended to `state-load`; `ack` and `publish_transition` remain appended to `state-save`. They never become enclosing PhaseReport phases. Missing/commit chunk summaries retain payload-byte accounting, nested-request suppression, p95 rounding, and finalization on success or throw. |
| Telemetry | Upload-lane samples retain transport grouping, fill-version observation at completion, integer rounding, completion-on-error, swallowed observer errors, and one completion batch per bounded push operation. Phase telemetry retains #693's bounded gap vector and existing sampling cadence. |
| First publish | Arming point, command-level files-synced start, retry survival, token invalidation, upload interval overlap, auth classification, finalization, and every rendered/stat field remain unchanged. An operation field replaces the process-global mutable singleton. |
| Disabled cost | `PhaseReport.disabled("push")` remains the disabled authority and no detailed clocks run while disabled. Ambient instrumentation calls outside a push remain no-ops. |
| Retry/crash behavior | 409/422/epoch/files-first retry ordering and budgets do not move. Finalizers still run on thrown upload/commit/state-save work; no durable effect boundary moves. |

No command, protocol, wire/state format, safety property, compatibility path,
migration, or performance fast path is approved for deletion.

## Measured complexity and ownership

Before, `push.ts` contains four independent `deps.report ??
PhaseReport.disabled("push")` sites, two independent async-local scopes, direct
mutation of one process-global first-publish singleton, about fourteen manual
`performance.now()` brackets, and five repeated projection `appendDetails`
calls. The orchestration must understand setup/finalization rules for all four
sinks.

`PushSpans` owns:

- exactly one `PhaseReport` selection for a push operation;
- async propagation of one operation context;
- upload-lane accumulation and its existing completion projection;
- missing/commit request samples, nesting suppression, and summary projection;
- first-publish mutable measurement state and its arm/finalize lifecycle;
- the stable mapping from detail names to their owning PhaseReport phase and
  existing formatter.

It must never own push decisions, retry policy, remote calls, file/Git work,
durable transitions, PhaseReport rendering, phase/gap semantics, telemetry
sampling policy, or upload scheduling.

The complete orchestration Interface is:

```ts
const spans = PushSpans.create(deps);
await spans.run(() => pushManifestInner(..., spans));
await spans.span("state-load", () => loadState(...));
const result = await spans.span("matcher_ms", () => matcherForState(...));
spans.note("projection_ms", milliseconds);
```

Known phase names delegate to `PhaseReport.phase`. Known detail names measure
with `performance.now()` and append the same snake-case detail to its existing
owning phase using `formatPushSpan`. `note` accepts already-measured values and
preserves append order. Domain-specific PhaseReport data such as scan counts,
Git-plan stats, commit server timings, and first-publish structured details is
forwarded without reinterpretation; `PushSpans` is a sink facade, not their
schema owner.

The object is created once per complete bounded `pushManifest` operation, not
once per retry iteration. That wording matters: the current lane accumulator
and tail scope cover the complete retry loop, and first-publish timing carries
the command milestone across a retry. Creating one object per `runPushAttempt`
iteration would change sample count and attribution, violating the stated
sampling-cadence contract.

## Implementation slice

1. Add `src/cli/push-spans.ts` with one async-local carrier
   `{ owner: PushSpans; activeTailKinds: ReadonlySet<PushTailKind> }`. Absorb the
   lane accumulator and push-tail implementations into private owner fields plus
   leaf helpers that consult the carrier. A nested request runs with a new
   carrier containing the same owner and an immutable expanded kind set. This
   preserves nested wrapper suppression without putting nesting state on the
   shared owner: concurrent sibling requests start from the same unexpanded
   parent carrier and are both counted.
2. Move first-publish mutable state into a field of `PushSpans`. Keep the
   existing first-publish algorithms and formatter, but make ambient producer
   helpers resolve the current object; calls outside a scoped push are inert.
   Tests construct a scoped `PushSpans` instead of arming a shared singleton.
3. Construct the owner at the two public adapters (`push` and direct
   `pushManifest`) through one factory. The scan wrapper passes its owner into
   the private manifest path; all inner reconstruction sites disappear.
4. Replace manual detail brackets in `runPushAttempt` with `span`, and the five
   projection detail re-emissions with ordered `note` calls. Preserve the
   acknowledgement subtraction of nested state-save time and commit subtraction
   of receipt-redemption time as named composite spans; they measure exclusive
   time and cannot be naively replaced by raw wall brackets.
5. Delete `push-tail-timing.ts` and `telemetry/lane-accumulator.ts`, rewire their
   leaf imports, and replace their three CODEMAP entries with the one owner.
   Retain `upload-lane-timing.ts` for the separate flag-gated lane/pack/dispatch
   sweep counters and exact summary formatter; remove only its global
   first-publish ownership.

## Ceremony deletion and safe-deletion proof

The separate CODEMAP entries for `push-tail-timing.ts` and
`telemetry/lane-accumulator.ts`, plus the singleton warning in the
`upload-lane-timing.ts` entry, become unnecessary and are deleted in this
change. Their exported helpers are internal TypeScript imports with no command,
flag, wire, durable, package-export, generated-load, automation, documentation,
migration, or support-window role. All production importers are rewritten, and
their behavior is absorbed behind `PushSpans` contract tests.

`push.ts` remains above the hard size limit, so its size allowlist entry stays.
Its byte/nonblank ratchet must be re-pinned downward to the measured result; an
upward or unchanged pin is not allowed.

## Requirement challenges

| Requirement | Complexity cost | Evidence | Decision |
| --- | --- | --- | --- |
| Preserve two async-local stores | Two independently nested setup/finalization protocols can drift. | Both scopes start at `pushManifest` and serve leaves of the same operation. | Replace with one context; preserve each sink's data and finalization order. |
| Preserve the process-global first-publish singleton | Requires serialized-push commentary, overlap voiding, generation fencing, and direct mutations across modules. | The push already has an operation scope reaching every producer. | Delete the global; make its state an operation field. Keep token fencing for work that can settle after finalization. |
| Allocate one owner per retry iteration | Would emit more lane samples and tail summaries and lose retry-carried first-publish attribution. | Existing scopes enclose the full retry loop. | Interpret “attempt” as the bounded publication operation; `runPushAttempt` is a retry iteration. Preserve cadence. |
| Replace enclosing phase labels with narrow work labels | Would falsify historical phase/gap meaning and violate the 247 verdict. | `git-plan` currently encloses the whole candidate transition. | Reject. Detail spans append beneath the existing authority only. |

## Differential and validation gates

- Before implementation, check in a golden transcript captured from the current
  complete daemon push-line recipe under fixed clocks. It includes prologue and
  settle residuals, projection details, lineage/matcher, missing/commit tail
  summaries, delta-base, `drain_wait` on `state-load`, and `ack` plus
  `publish_transition` on `state-save`, in exact phase/detail order. The new
  complete line must equal that pre-change fixture byte-for-byte; a reconstructed
  “legacy” path sharing new code is not accepted as differential proof.
- Retain and rewire the existing lane, tail, first-publish token/overlap,
  completion-on-error, and nested-tail tests. Add concurrent scoped owners to
  prove there is no cross-attribution, plus concurrent sibling and nested
  same-kind tail requests to prove both siblings count while wrappers count once.
- Force one 409/422 retry through `pushManifest` and assert exactly one lane
  completion batch, one aggregate missing/commit tail projection, and no
  duplicate first-publish or phase completion. This pins the operation scope
  rather than merely documenting it.
- Run at least one focused test suite during adversarial review, then require
  exit code 0 from `bun test src/cli/sync src/cli/daemon src/cli/telemetry`,
  repository typecheck, the file-size gate, and `bun run lint:affected`.
- Run whole-file oxlint on `src/cli/sync/push.ts`; all standing warnings in that
  file must reach zero. Record before/after warning counts.
- Crash/compatibility evidence is structural plus differential: no effect
  ordering or data format moves; finalizers are tested on throw; disabled paths
  remain inert; sampling count and scope are asserted. Add a focused timing
  benchmark that compares the pre-change direct property-check loop with the
  scoped producer-helper loop at representative per-blob call volume, records
  median A/B results, and fails only above a deliberately generous 2x/absolute
  25 ms regression bound. Also assert an unscoped disabled producer performs no
  allocation or mutation. No fleet deployment is part of this branch-only task.
