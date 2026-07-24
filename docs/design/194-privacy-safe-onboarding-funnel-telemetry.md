# 194 — Privacy-safe onboarding funnel telemetry

Status: DRAFT — implementation-ready, awaiting review.

Origin: `docs/audits/2026-07-22-onboarding-feedback.md` and the onboarding
follow-up on 2026-07-23.

Depends on: design 120's authenticated, fail-closed telemetry ingest.

Related: designs 184/189 (pairing), 186 (case-only collisions), 187 (recovery
destinations), and the component-driven TUI work in PR #410.

## 1. Problem

rbox now has a much shorter path from first launch to encrypted sync, but the
product cannot answer the next operational question: **where do future users
leave onboarding, and do they later recover?**

The current client telemetry contract measures sync health and successful first
publication. It does not measure:

- whether guided setup started, completed, or exited;
- the last onboarding step reached;
- which recovery destinations were offered and selected;
- how a machine became authenticated and encryption-enrolled;
- whether the initial sync failed, why it failed at a coarse level, or whether a
  later attempt succeeded; or
- wall time from the beginning of setup to the first successful publication.

Without these signals, another beta user can stall at account setup, recovery
storage, workspace selection, or initial sync and look identical to a user who
never tried rbox.

This design adds a deliberately small funnel contract. It is not a general
analytics SDK, session replay system, or error-reporting channel.

## 2. User and product outcome

The target user remains the GitHub-capable non-developer: comfortable running a
command, but not expected to understand credential grants, encryption
enrollment, Git internals, or filesystem portability rules.

The onboarding “aha” moment is not merely reaching the final setup screen. It is
the first successful encrypted sync: a new workspace has published safely, or a
joined workspace has converged and become useful on this device.

The operator must be able to answer:

1. Of observable onboarding starts, what fraction reaches each step?
2. Where do explicit exits and interrupted flows occur?
3. Which recovery destinations are offered and selected on each host?
4. Which enrollment routes successfully reach setup completion?
5. What bounded failure families stop initial sync?
6. What fraction of initial-sync failures later recover?
7. How long does setup-to-first-success take at p50/p90/p99, with publication
   and join-without-publication reported separately?

The resulting data should guide the next onboarding fix. It must never become a
new reason setup or sync can fail.

## 3. Non-negotiable privacy boundary

Only bounded counts, durations, booleans, bitmasks, and allow-listed enums may
cross the telemetry boundary.

The client, API, Analytics Engine, logs, tests, and dashboards MUST NOT collect:

- recovery phrases or any phrase-derived value;
- pairing tokens, device codes, login secrets, or authorization URLs;
- filenames, directory names, absolute or relative paths;
- workspace names, Git repository names, remote URLs, or hostnames;
- 1Password account names, vault names, item names, or item identifiers;
- Keychain paths, plaintext recovery-kit paths, or clipboard contents;
- account, device, workspace, project, or onboarding-flow identifiers;
- hashes of any forbidden value;
- raw errors, exception names, stack traces, stderr, or arbitrary strings; or
- wall-clock timestamps on the wire.

Authenticated transport necessarily identifies the principal while the request
is authorized, as it already does for all design-120 telemetry. That identity
MUST NOT be copied into the Analytics Engine datapoint or used as a dimension.
No stable or random “anonymous” flow identifier is added. Cross-event analysis
is aggregate, not per-user tracking.

The server reconstructs every Analytics Engine blob from a canonical enum
allow-list. It never forwards a client string.

## 4. Scope and explicit limitations

### 4.1 In scope

- Interactive guided setup entered through bare `rbox` or `rbox setup`.
- Direct second-machine enrollment through:
  - `rbox connect <pairing-token>`;
  - bare `rbox connect` followed by a pasted token;
  - browser-approved encrypted pairing (design 189); and
  - browser sign-in followed by 24-word recovery.
- Recovery-destination availability and selection during first-account genesis.
- Initial create, join, or pull outcomes.
- A later successful convergence after a classified initial-sync failure.
- Privacy-safe Analytics Engine records and the queries needed to use them.

### 4.2 Out of scope

- Web-page acquisition analytics before a CLI is installed.
- Anonymous telemetry ingest.
- Session replay, terminal capture, or free-form error reporting.
- Product experimentation, A/B assignment, marketing attribution, or user
  profiling.
- Billing conversion.
- Changing onboarding copy, ordering, or provider behavior.
- Replacing `client.first_publish`; this design complements that performance
  metric.
- Adding a new telemetry consent prompt. The existing
  `RBOX_TELEMETRY=0` kill switch remains authoritative.

### 4.3 Honest observability limit

`POST /v1/telemetry` requires an authenticated device. A user who starts setup,
never authenticates, and never runs rbox again cannot be observed without a new
anonymous ingest surface. This design intentionally does not create one.

Pre-authentication milestones are kept only in a bounded local journal. They are
uploaded after the device becomes authenticated. If the user never returns,
those milestones remain invisible. Dashboard copy and funnel denominators MUST
say **observable starts**, not installs or all attempted starts.

## 5. Funnel model

### 5.1 Steps

Use one stable step vocabulary independent of presentation framework:

| Value | Meaning |
|---|---|
| `account` | authorization and encryption enrollment |
| `recovery` | first-account recovery-phrase storage |
| `workspace` | create/join choice, directory binding, and preflight |
| `initial_sync` | first pull/push/sync attempt |
| `background_sync` | daemon/autostart choice |
| `done` | guided setup returned success |

Instrument orchestration/domain boundaries, not Ink/Inquirer components. A TUI
refactor must not change funnel meaning.

### 5.2 Entry points

| Value | Meaning |
|---|---|
| `bare` | bare `rbox` routed into guided setup |
| `setup` | explicit `rbox setup` |
| `connect_command` | token supplied as `rbox connect <token>` |
| `connect_prompt` | token pasted into bare `rbox connect` or the guided prompt |
| `browser_pair` | design-189 browser-approved encrypted pairing |

Headless `rbox init`, keyed CI setup, recovery maintenance commands, and an
already-enrolled user's ordinary sync are excluded from the guided funnel.

Successful enrollment-only commands leave a local `continuation_expected`
marker at the `account` step. A later bare `rbox` or `rbox setup` resumes that
same local flow instead of manufacturing a new start or calling the clean command
boundary an interruption. The original entry remains `connect_command`,
`connect_prompt`, or `browser_pair`; the enrollment route records how key
material actually arrived.

### 5.3 Enrollment routes

Enrollment is the combined authorization-plus-encryption outcome, not merely
the button the user first selected:

| Value | Meaning |
|---|---|
| `first_machine` | account genesis on the first encrypted device |
| `pair_command` | `rbox connect <token>` |
| `pair_prompt` | a token pasted after a prompt |
| `browser_pair` | browser approval delivered key material automatically |
| `browser_recovery` | browser authorization followed by a recovery phrase |
| `already_enrolled` | setup began with usable credentials and key material |
| `not_reached` | the flow ended before enrollment was known |

Do not collapse `browser_pair` and `browser_recovery`: one is the desired
zero-typing path; the other represents recovery after browser authorization.

### 5.4 Recovery destination masks

Use a four-bit integer encoded as a canonical enum string `m00` through `m15`:

| Bit | Destination |
|---:|---|
| `1` | 1Password |
| `2` | macOS Keychain |
| `4` | plaintext file |
| `8` | clipboard |

Two masks are recorded:

- `recoveryOfferedMask`: providers actually available on this host; and
- `recoverySelectedMask`: the user's submitted multi-select plan.

The offered mask is required as the denominator. A low 1Password selection rate
means something different when the `op` CLI was unavailable.

Use `not_reached` as the enum sentinel when the recovery step did not apply.
Never encode account/vault/file details.

### 5.5 Initial-sync failure categories

One classifier maps typed errors and known phase boundaries to this fixed set:

| Value | Meaning |
|---|---|
| `none` | initial sync succeeded without a prior failure |
| `authorization` | credential or encryption enrollment unavailable |
| `network` | bounded transport/unreachable/timeout family |
| `workspace` | workspace create/select/configuration failure |
| `scan` | local scan or supported-path validation failure |
| `filesystem` | local permission, read, write, or disk-capacity failure |
| `upload` | encryption/blob publication failed before commit admission |
| `commit` | remote manifest commit/admission failure |
| `download` | remote manifest/blob retrieval failure |
| `decrypt` | authenticated decryption/key-state failure |
| `apply` | applying remote file changes failed |
| `git` | Git adoption/capture/apply prevented initial completion |
| `conflict` | user-actionable local/remote content conflict |
| `cancelled` | explicit user cancellation or clean interrupt |
| `other` | known failure that cannot safely be classified above |

Classification consumes internal error types and the current phase. It MUST NOT
inspect arbitrary message substrings, serialize the error, or copy an error name
onto the wire. `other` is preferable to an unstable or identifying category.

## 6. Wire contract

Extend the existing design-120 envelope with two sample kinds. All fields are
required so missing values cannot acquire ambiguous meanings.

### 6.1 `onboarding_flow`

One record represents a bounded lifecycle milestone:

```ts
interface OnboardingFlowSample {
  kind: "onboarding_flow";
  event: "started" | "completed" | "exited" | "interrupted";
  lastStep: "account" | "recovery" | "workspace" | "initial_sync"
    | "background_sync" | "done";
  entry: "bare" | "setup" | "connect_command" | "connect_prompt"
    | "browser_pair";
  enrollmentRoute: "first_machine" | "pair_command" | "pair_prompt"
    | "browser_pair" | "browser_recovery" | "already_enrolled"
    | "not_reached";
  recoveryOffered: "not_reached" | "m00" | "m01" | "m02" | "m03"
    | "m04" | "m05" | "m06" | "m07" | "m08" | "m09" | "m10"
    | "m11" | "m12" | "m13" | "m14" | "m15";
  recoverySelected: "not_reached" | "m00" | "m01" | "m02" | "m03"
    | "m04" | "m05" | "m06" | "m07" | "m08" | "m09" | "m10"
    | "m11" | "m12" | "m13" | "m14" | "m15";
  elapsedMs: number;
}
```

Emission rules:

- `started`: exactly once per locally-created guided flow, uploaded when device
  authentication first permits it;
- `completed`: when guided setup reaches its successful return;
- `exited`: on an action that leaves setup incomplete or a handled cancellation
  (a valid “not now” choice that completes setup is not an exit); and
- `interrupted`: on the next invocation when a prior journal remains active
  without a clean terminal marker.

`elapsedMs` is integer wall time since the local start, clamped to design 120's
`[0, 604_800_000]` ms domain. A clock that moves backward produces `0`; a flow
older than seven days produces the maximum. Absolute timestamps stay local.

### 6.2 `onboarding_activation`

One record represents the first durable sync success associated with a local
onboarding flow:

```ts
interface OnboardingActivationSample {
  kind: "onboarding_activation";
  entry: OnboardingEntry;
  enrollmentRoute: OnboardingEnrollmentRoute;
  activationKind: "published" | "converged_without_publish";
  initialResult: "success" | "failed_then_recovered";
  firstFailure: OnboardingFailureCategory;
  initialSyncAttempts: number;       // integer [1, 100]
  timeToFirstSuccessMs: number;      // integer [0, 604_800_000]
}
```

Rules:

- A successful first attempt emits `initialResult=success`,
  `firstFailure=none`, and `initialSyncAttempts=1`.
- A failed attempt updates the local journal but emits no activation record yet.
- The first later durable sync success emits
  `initialResult=failed_then_recovered`, preserves the first bounded failure
  category, and records the capped attempt count.
- Repeated failures increment the capped count but never add raw detail.
- A create that durably publishes records `activationKind=published`.
- A pull-only join that successfully converges but publishes no new manifest
  records `activationKind=converged_without_publish`. It never fabricates a
  remote commit.

The existing `client.first_publish.timeToFilesSyncedMs` remains a process-local
performance measurement. `timeToFirstSuccessMs` here includes onboarding,
restarts, and recoverable failure time. For `activationKind=published`, it is the
requested setup-to-first-publication metric. For a no-publish join, it is
setup-to-first-convergence. Dashboards MUST keep those slices separate when
labeling “first publish.” Do not substitute the existing process-local metric
for this product time-to-value metric.

### 6.3 Analytics Engine layout

The server schema remains the sole route to Analytics Engine:

| `index1` | blobs, in order | doubles, in order |
|---|---|---|
| `client.onboarding_flow` | `event`, `lastStep`, `entry`, `enrollmentRoute`, `recoveryOffered`, `recoverySelected` | `elapsedMs` |
| `client.onboarding_activation` | `entry`, `enrollmentRoute`, `activationKind`, `initialResult`, `firstFailure` | `initialSyncAttempts`, `timeToFirstSuccessMs` |

The API duplicates the client enum tables as runtime data and the existing
contract-drift test compares both sides. Unknown keys, strings, enums, missing
fields, non-integers, and out-of-domain numbers are dropped through the current
`client.telemetry.drops` path.

No D1 table or migration is added.

## 7. Durable local recorder

### 7.1 Why durability is required

The recovery choice occurs before the daemon owns a `TelemetryQueue`, and the
initial sync may fail before setup reaches its final screen. An in-memory sample
would lose the exact abandonment/recovery evidence this design exists to measure.

Add `src/cli/telemetry/onboarding.ts`, owning:

- the finite-state funnel model;
- bounded failure classification;
- safe local persistence;
- conversion to the two wire samples; and
- best-effort handoff into the authenticated telemetry transport.

It must never own UI copy, prompt order, authentication, sync execution, or API
ingest policy. Add this ownership line to `docs/CODEMAP.md`.

### 7.2 Journal

The recorder has two storage phases, both using constant filenames:

```text
pre-workspace:  <rboxDir()>/telemetry/onboarding-v1.json
post-binding:   <root>/.rbox/state/onboarding-v1.json
```

The global journal owns account/recovery/enrollment progress before a workspace
root exists. Once setup has durably selected and initialized a root, it
atomically transfers the bounded record into that root's internal `.rbox/state`
directory and removes the global copy. The workspace-local placement lets the
foreground sync or that workspace's daemon recognize the correct pending
activation without storing a root path, workspace ID, project ID, stream ID,
hash, or flow ID in telemetry state.

The journal contents contain only:

- schema version;
- local start time and last-update time;
- the enums and masks defined above;
- capped attempt count;
- first bounded failure category;
- lifecycle state (`active`, `continuation_expected`, or terminal);
- terminal/activation state; and
- at most eight pending wire samples, each carrying a local monotonic receipt
  number used only to acknowledge the durable outbox.

The receipt number never crosses the wire and is not a flow identifier. Neither
journal contains an account/device/workspace identifier or arbitrary string.

Requirements:

- parent directory mode `0700`, file mode `0600`;
- atomic temp-write, fsync, rename, and parent-directory fsync using established
  durable-state helpers;
- `O_NOFOLLOW`/containment protections consistent with other global journals;
- strict own-key and enum validation on read;
- corrupt or oversized state is quarantined or discarded without failing setup;
- maximum file size 16 KiB;
- maximum eight outbox records, dropping oldest `started` records before terminal
  or activation records; and
- records older than 30 days are deleted locally and never uploaded.

The global-to-workspace transfer must be crash recoverable: write and fsync the
workspace-local record first, then remove and fsync the global parent. If both
copies survive a crash, the workspace-local copy wins and the global copy is
retired only when their bounded contents match. A mismatch is quarantined and
telemetry is abandoned; setup and sync continue unchanged.

### 7.3 Delivery semantics

Onboarding telemetry is best-effort and at-least-once around a crash:

1. Persist the milestone to the local outbox.
2. Load pending items into the existing `TelemetryQueue` as durable items,
   retaining their local receipt numbers only in memory.
3. On HTTP 202, ask the recorder to acknowledge the exact included receipts.
4. Remove those outbox items in one durable journal mutation.

A crash after server acceptance but before local acknowledgement can duplicate a
sample. No flow identifier is introduced to deduplicate it. Dashboards must use
trend bands and label values as event counts, not exact user counts.

Extend `TelemetryQueue` with a narrow durable-item seam rather than teaching the
queue about journal paths:

```ts
interface DurableTelemetryBatch {
  samples: ReadonlyArray<{ receipt: number; sample: TelemetrySample }>;
  acknowledge(receipts: readonly number[]): Promise<void>;
}
```

The queue loads at most eight onboarding items, places them after the existing
cap-proof health counters but before ordinary rings, and calls `acknowledge`
only for items included in a 202-accepted batch. A failed local acknowledgement
removes the items from that in-memory queue instance but leaves the journal
intact, making a later crash/restart duplicate possible rather than creating a
hot duplicate loop. A 202 containing server-side schema drops still acknowledges
the submitted item, matching existing queue semantics.

The recorder must not create its own retry loop, timer, or daemon. Setup attempts
one short best-effort flush after authentication and on clean terminal events.
The daemon imports any remaining outbox at startup and before its shutdown flush.

On 429, network failure, 5xx, or timeout, leave the outbox intact. On a permanent
4xx/schema rejection, discard only the rejected bounded sample and log a generic
debug message without payload data.

### 7.4 Opt-out

`RBOX_TELEMETRY=0` is checked:

- before journal creation or mutation;
- before importing the outbox;
- before queueing; and
- immediately before network flush.

When disabled, delete the global journal and any journal for the current known
workspace root best-effort, then return a no-op recorder. Re-enabling telemetry
starts a new flow; previously suppressed milestones are never reconstructed.

Because a process does not know every configured workspace root, the kill switch
also writes a constant global privacy tombstone:

```text
<rboxDir()>/telemetry/optout-v1.json
```

It contains only a schema version and local `disabledAtMs`. On every future
journal import, records started at or before that marker are deleted rather than
queued. The marker remains so a dormant workspace cannot upload pre-opt-out
history after telemetry is re-enabled; new flows started after the marker are
eligible. The tombstone is local configuration, never uploaded. Writing or
reading it must also be best-effort and cannot affect product behavior.

## 8. Instrumentation points

Instrumentation is presentation-agnostic:

1. **Entry dispatch:** classify `bare`, `setup`, `connect_command`,
   `connect_prompt`, or `browser_pair`; create or resume the global recorder.
   A successful enrollment-only command marks `continuation_expected`.
2. **`runSetup`:** mark `account`, `workspace`, `background_sync`, and `done`
   around orchestration transitions. PR #410 may change rendering, but these
   domain transitions remain the source of truth.
3. **Genesis recovery selection:** record offered and selected destination masks
   only after the multi-select answer is submitted. Provider-specific execution
   details remain outside telemetry.
4. **Enrollment success:** record the final enrollment route only after usable
   device credentials and key material are durably present.
5. **Workspace binding:** transfer the recorder to the constant workspace-local
   state file without storing the root or stream in its contents.
6. **Initial sync boundary in `runInit`:** mark attempt start, typed failure
   classification, and successful convergence. Do not instrument spinner text.
7. **Successful create publication:** finalize activation immediately after the
   fully persisted commit, beside the existing `first_publish` emission.
8. **Successful join/pull convergence:** finalize activation after state is
   durably saved even when no new remote sequence is created.
9. **Daemon startup:** import the journal associated with that daemon's already
   known root, flush pending bounded outcomes, then recognize
   the first later success after a failed foreground attempt.

Telemetry calls are wrapped at the recorder boundary. No caller adds `try/catch`
noise, and no recorder error changes a command exit code or user-visible output.

## 9. Dashboard contract

Ship saved queries or cockpit panels for:

1. Observable starts by entry point.
2. Completion and explicit/interrupted exit counts by `lastStep`.
3. Completion rate by enrollment route.
4. Recovery destination:
   - offered count per bit;
   - selected count per bit;
   - selected/offered rate per bit; and
   - multi-backup rate (`popcount(selectedMask) >= 2`).
5. Initial activation success versus failed-then-recovered.
6. First failure category distribution.
7. Recovery rate after initial failure.
8. Setup-to-first-success p50/p90/p99 split by `published` versus
   `converged_without_publish`; only the former is labeled time-to-first-publish.

Every panel includes these footnotes:

- counts represent authenticated, observable events, not unique people;
- a never-returning pre-auth abandonment is unobservable;
- delivery is best-effort and rare crash duplicates are possible; and
- no raw user content or identifiers are collected.

No alert should page on a small beta sample. Until volume is sufficient, use the
panels for qualitative prioritization alongside direct interviews.

## 10. Failure and concurrency rules

- Multiple rbox processes may touch the global journal. Mutation uses a bounded
  global lock and reload-under-lock; lock contention drops the current telemetry
  mutation rather than delaying onboarding.
- A clean enrollment-only command marks `continuation_expected`; the next guided
  entry resumes it. An `active` journal without that clean handoff is rolled to
  one `interrupted` outcome on the next guided entry, then a new flow begins.
- Re-entering the same process after a menu “back” updates `lastStep`; it does not
  create another `started`.
- An explicit exit produces one terminal event. Repeated cleanup paths are
  idempotent locally.
- A completed flow cannot later become exited/interrupted.
- Activation is single-assignment locally. Later ordinary syncs do not emit
  onboarding activation.
- Initial-sync attempts saturate at 100.
- Time values clamp to seven days and never become negative.
- Telemetry persistence, classification, queue import, or flush failure is
  swallowed at the recorder boundary and optionally debug-logged without payload.

## 11. Testing

### 11.1 Contract and privacy

- Client/server schema drift test covers both new kinds, field order, enum order,
  and numeric domains.
- Arbitrary strings, extra keys, identifier-shaped values, paths, tokens, phrase
  words, hashes, NaN/infinity, and out-of-range numbers cannot reach
  `writeDataPoint`.
- AE layout tests pin exact blob/double positions.
- Source guard rejects forbidden free-form fields in onboarding sample types.

### 11.2 Recorder state machine

With injected clock, filesystem, lock, and transport:

- started → completed at each valid path;
- explicit exit at every step;
- stale active → one interrupted event on next launch;
- offered/selected masks for every single destination and representative
  multi-select combinations;
- each enrollment route;
- first-attempt success;
- failure → repeated failure → later success;
- create publication and join-without-publication activation;
- clock rollback, seven-day clamp, attempt saturation, and 30-day expiry;
- outbox priority/cap behavior;
- corrupt, oversized, symlinked, and permission-denied journal behavior;
- global-to-workspace transfer, crash-surviving duplicate copies, and mismatch
  quarantine;
- continuation from `rbox connect <token>` into a later bare `rbox`;
- concurrent mutation reload-under-lock;
- 202 removal, 429 retention, 5xx retention, network retention, and permanent 4xx
  discard; and
- `RBOX_TELEMETRY=0` creates no journal, deletes old state, and makes no request;
- opt-out tombstone prevents a dormant workspace from uploading pre-opt-out
  history after telemetry is re-enabled;

### 11.3 Flow integration

- Guided `rbox setup` pins stable step transitions without driving terminal
  rendering.
- `rbox connect <token>` and prompted connect produce distinct routes without
  recording the token.
- Browser pairing and browser-plus-recovery remain distinct.
- Recovery selection records kinds only, never provider metadata.
- Initial-sync error fixtures cover every bounded category plus `other`.
- Telemetry failures leave the same stdout/stderr, exit status, persisted sync
  state, and remote result as telemetry disabled.

### 11.4 Rig and production validation

Extend an existing onboarding rig rather than inventing a TUI-only test:

1. fresh create with two recovery destinations;
2. initial publish success;
3. second-machine browser pairing or `rbox connect`;
4. join convergence;
5. injected bounded initial failure;
6. passive or explicit retry success; and
7. fake ingest capture proving exact samples and absence of forbidden fields.

After dev deployment, run the path with test accounts and verify the two AE
families appear with only the specified dimensions. Production rollout requires
one real opt-out validation showing zero journal/network activity.

## 12. Implementation order

1. Add the client/server declarative schemas and drift/privacy tests.
2. Add `src/cli/telemetry/onboarding.ts` with pure reducers and failure
   classification.
3. Add the bounded durable journal/outbox and opt-out behavior.
4. Wire entry, setup, recovery, enrollment, initial-sync, and first-success
   boundaries.
5. Import the outbox through the existing daemon `TelemetryQueue`.
6. Update `docs/CODEMAP.md`.
7. Add the rig capture and dev AE validation.
8. Add cockpit queries/panels and their observability caveats.

Client and server schema changes ship together. Do not emit a new kind before the
deployed API accepts it; during rollout, server support lands first or the client
must tolerate a permanent 202 drop without affecting onboarding.

## 13. Acceptance criteria

- [ ] Observable onboarding starts, completions, exits, and interruptions are counted
      by stable step and entry enums.
- [ ] Recovery offered and selected masks distinguish 1Password, Keychain, file,
      and clipboard without provider metadata.
- [ ] Enrollment routes distinguish token command, token prompt, browser pairing,
      browser recovery, first machine, and already-enrolled setup.
- [ ] Initial failures use only the bounded category table.
- [ ] A later first success after failure emits one recovery outcome.
- [ ] Setup-to-first-success time spans process restarts and is capped at seven
      days.
- [ ] Published and no-publish join success semantics are honest and separately
      sliceable; only published outcomes are labeled time-to-first-publish.
- [ ] No forbidden value or free-form string can cross the wire or reach AE.
- [ ] `RBOX_TELEMETRY=0` leaves no onboarding telemetry journal or network call.
- [ ] Re-enabling telemetry cannot upload a dormant pre-opt-out journal.
- [ ] Telemetry failures cannot change onboarding or sync behavior.
- [ ] The journal is bounded, durable, symlink-safe, concurrency-safe, and expires.
- [ ] Pre-workspace state transfers to a constant workspace-local journal without
      persisting a root, stream, or workspace identifier.
- [ ] Enrollment-only commands resume into later guided setup without a false
      interruption or duplicate start.
- [ ] Contract, recorder, integration, rig, and dev AE validation pass.
- [ ] `docs/CODEMAP.md` reflects the new module's ownership.

## 14. Rejected alternatives

### Anonymous pre-auth ingest

Rejected. It would improve top-of-funnel visibility but creates a new unauthenticated
abuse and privacy surface for a small product. Observable authenticated starts are
enough to choose the next onboarding fix.

### Raw error reporting

Rejected. Error text can contain paths, workspace names, provider details, and
tokens. Typed phase classification plus `other` is safer and more stable.

### Flow, device, or account identifiers

Rejected, including hashes and random “anonymous” IDs. Exact cross-event joins
are not required for aggregate funnel decisions and would create unnecessary
tracking capability.

### Instrumenting TUI components

Rejected. Rendering is not the product state machine. Instrumenting components
would double-count on rerender and couple metrics to PR #410's implementation.

### In-memory-only samples

Rejected. Recovery selection and initial failure occur precisely where process
exit is likely; losing them would bias the funnel toward successful users.

### New D1 tables

Rejected. These are bounded event trends with existing Analytics Engine
retention, not authoritative mutable state.
