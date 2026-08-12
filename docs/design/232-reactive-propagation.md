# Design 232: Reactive propagation — ≤10 seconds end to end

**Status:** DRAFT r3 (codex r1+r2 folded — kernel reduced to instruments + visibility)
**Snapshot:** `origin/main` at `6538c91ab`
**Yardstick (founder, 2026-08-12):** a change written on host A is applied on
host B in **≤10 seconds**, through the intended fully reactive pipeline:
watcher event → push on quiesce → Durable Object → WS emit → trusted
delta-scoped pull. Never scan-driven in steady state.

## 1. Problem — measured; causes separated from hypotheses

Round-5 bench (2026-08-12, desktop → Mac, 96-byte change): 171s end to end;
the measured active work (sender commit 3.5s + receiver apply 1.0s) is ~5s.
The existing measurements locate the delays, but do not establish every cause:

| loss | mechanism | evidence |
|---|---|---|
| sender ~60s | **Measured, cause unattributed pending trace.** Round-5 pushes landed on the safety-scan cadence, but Parcel already supports darwin-arm64 and observes Git refs; the delay occurred on the desktop sender. Settled ordinary file events call scheduler `request("push")` after the existing 400ms/3s debounce (watcher.ts:312-315, daemon.ts:852-857,1138). | round 5 pushes landed on safety-scan cadence; §4 retracts the earlier macOS-channel theory |
| receiver 94s queue | notify sets `notifyPullPendingAt`, requests pull, then waits behind the single-flight scheduler with **priority `deepScan > fullScan > pull > push`** (policy.ts:109) — a notify queues behind whole scans; `notify_latency_ms` measures exactly this dequeue wait (daemon.ts:1474-1485). Nothing is lost, nothing preempts. | `notify_latency_ms=94145` |
| receiver ~60s scan per pull | the pull ran `skip=p1-watcher` — trust predicate P1 failed (`trustState !== "trusted"`, daemon-pull-transition.ts:43-58, daemon.ts:1944-1946) → O(workspace) `scanManifest` instead of the O(1) trusted view (pull.ts:252-269). | every Mac pull since the fuse |
| — degraded trust overlap | Three asynchronously delivered watcher drops were observed while pull scan/apply churn was active; each drop extended the retrust hold (`retrust drop: window=5/6 hold=300000ms`). This is **delivery-time overlap, not evidence that daemon I/O caused the drops**. The backend supplies no causal identity, so the existing fail-closed accounting remains authoritative. | Mac log 01:40:01-07, three drops in 6s overlapping pull churn |
| `res` 56.9s inside the scan | NOT a work phase: `residualMs = wall − (rd+st+mt+h+srt)` (format.ts:22-28) — unattributed time. 1.8ms/file of untimed overhead with `dc:hit` and zero hashing is bug-shaped, not walk physics. | scan 61.8s: st3.7 mt1.1 res56.9 |
| 37s git-apply per pull | one standing deferral (savvy-core AUTO_MERGE) retries its full residual inside EVERY pull (`residualMs max=37625`). | round-5 pull git-apply 38.7s |

## 2. Product outcomes

1. A `git commit` (or file change) on any platform reaches the server within
   ~2s of quiesce — macOS included.
2. A WS notify is serviced within one bounded, small interval — never behind
   a 30-minute-cadence deep scan or a multi-minute full scan.
3. A healthy watcher converges to trusted within one retrust window and stays
   there under representative daemon load. Overlap telemetry may explain when
   drops are delivered, but never changes fail-closed trust/fuse accounting.
4. Trusted pulls remain O(delta); untrusted pulls become rare (boot, real
   external storms) instead of steady state.
5. A standing git deferral costs bounded retry on its own repo — never a
   per-pull tax on the workspace.
6. The ≤10s budget is a regression-tested number: the existing propagation rig
   and report measure exact sequence-correlated sender, notification-arrival,
   and receiver-apply spans on the rig and the live fleet.

## 3. Non-goals / preserved behavior

- No transport changes: DO streams (workspace-sync.ts:761-766 fanout-first
  ordering), WS frame shape, blob wire, E2EE, commit admission untouched.
- The 400ms/3s watcher debounce IS the quiesce window — this design names it
  and does not invent a second one.
- Burst coalescing and the safety-scan cadence remain as the reconciliation
  net. This kernel does not change commit detection: Chokidar remains
  intentionally scan-bound for Git unless §4.3's evidence gate earns a
  separately reviewed sender mechanism.
- Design 104's fail-closed trust semantics stay: an untrusted watcher still
  means scan. Drop/operation overlap is telemetry only: it never changes
  `errorGen`, suspect/fused transitions, the rolling fuse, or the existing
  clean-scan + stable-generation retrust rule. Any future recovery change is
  evidence-gated in §4.3 and requires its own review. The FSEvents
  persistent-journal boot delta stays OUT (future design; boot cost is not on
  the 10s path).
- The savvy-core deferral itself: ops item + design 234 (git-resolve rig
  suite, founder-requested). Here we only bound its per-pull cost.

## 4. Mechanics — r3: the kernel is instruments, not mechanisms

Codex r1 (REVIEW-232-R1) falsified the r2 kernel's one mechanism: parcel
already supports darwin-arm64 (watcher.ts:290) and routes git-ref signals
around the file batcher into gitSignalDebouncer (watcher.ts:331); `.git` is
NOT pruned for parcel (ignore.ts:227 prunes only objects/ and logs/); the
fs.watch side channel is a deliberately separate linux-only registry
(git-ref-watch.ts:188). And the round-5 sender delay occurred on the DESKTOP
— which has every channel — so "add a darwin channel" was a mechanism designed
ahead of its measurement. Every proposed mechanism now sits behind a number.

### 4.1 Kernel A — end-to-end propagation observability

#### Existing harness owns orchestration and reporting

There is no new `scripts/bench/propagate.ts`. Extend/extract
`scripts/rig/scenarios/git-commit-propagation.ts`, which already owns the
two-host lifecycle, stimuli, convergence witnesses, and event-driven path
assertions. Reuse/extend `scripts/propagation-report.ts` as the sole parser and
report owner. The daemon, watcher, scheduler, sync engine, and API remain the
real path; the rig and report are Adapters and must not reconstruct it.

Each backend run (`parcel-linux`, `parcel-darwin`, `chokidar`) contains two
isolated attempts after both daemons and the repository/ref registry are armed:

1. an ordinary write with a unique marker path and content witness; and
2. a ref-only `git commit --allow-empty` with a unique expected HEAD, with no
   ordinary workspace-file mutation after the attempt fence.

The ref-only attempt is mandatory: a marker write cannot diagnose Git-ref
detection. Each attempt has a bench-local ID used only in the observation
stream; it is not persisted in product state and does not change any wire
shape.

#### Local observation seam and exact joins

One opt-in, local-only observation sink records fixed events without making
timing callbacks part of domain control flow:

- sender backend armed;
- native event received and classified as ordinary-file or Git signal (a new
  hook before the Git-signal bypass, because `onRawEvent` cannot see it);
- the applicable file/Git debouncer armed and fired;
- the first scheduler want transition `false→true` for `push`;
- push operation begin; and
- publish receipt with the committed sequence.

The receiver records matching WS `committed` frame receipt, notify-pull
dequeue (including existing `notify_latency_ms`), and **the adopted remote
sequence at apply completion**. The apply-completion owner must receive and
record that sequence at the completion boundary; associating an earlier
pending sequence with a later `pull applied` log line is forbidden.

Correlation is exact and fail-closed:

- stimulus → sender trace uses the bench attempt ID plus its unique
  path/content or HEAD witness;
- sender publish → WS receive joins only on equality of the existing publish
  receipt sequence and WS-frame sequence;
- WS receive → apply completion joins only when the completion's adopted
  sequence equals that same sequence **and** host B holds the attempt's unique
  content/HEAD witness;
- an apply that adopts a later sequence is classified `coalesced`, reported as
  a convergence upper bound, and excluded from exact-hop percentiles/gates;
  missing, duplicate, reversed, or witness-mismatched events are unmatched
  attempts, never nearest-time matches; and
- every count is reported: attempted, exact, coalesced, unmatched, and invalid
  for clock skew. Percentiles and the ≤10s gate require the minimum exact
  sample count named in §5.

Because the DO broadcasts before the HTTP response, the report must not call a
client-derived span `emit→receive`. With the WS frame unchanged and no
correlated server emit telemetry in this kernel, rename it to
`write→matching-WS-receive`; report `quiesce→publish-receipt` on host A and
`matching-WS-receive→apply-complete` on host B separately. A future true
`emit→receive` row is allowed only from server telemetry joined by workspace,
sequence, and bench window.

Rig containers share the host clock and must measure a relative bound ≤5ms.
For fleet runs, five times before and five times after each attempt, the common
controller brackets a remote `{wallMs, monotonicMs}` sample from each host with
its own wall and monotonic timestamps. A sample yields the conservative host
offset interval `[hostWall − controllerWallAfter, hostWall −
controllerWallBefore]`; the narrowest interval per host is retained and maps
that host's monotonic trace to the controller clock. Subtracting the A and B
intervals yields the relative-offset interval reported with every cross-host
span. Those spans and the end-to-end gate are valid only when the interval
width is ≤250ms and its pre/post midpoint moves ≤100ms; otherwise local-host
spans remain reportable but the attempt enters `invalid-clock-skew`.

#### Exhaustive residual accounting

`scanManifest` owns a fixed, path-free timing schema. It uses one monotonic
clock (`performance.now`) for the outer scan wall time and every bucket;
`Date.now()` remains unchanged for semantic dircache timestamps. Buckets are
non-overlapping (nested work pauses its parent bucket) and cover **every
attempt**, including a failed pruned attempt whose `winningStats` is discarded
before a full fallback:

- rule-inventory pre-validation, post-validation, and rebuild stat passes;
- directory `lstat`/dircache work;
- directory enumeration and dir-entry conversion;
- path construction;
- rule/matcher checks;
- Git discovery;
- file metadata and cache lookup;
- regular-file reads/hashing;
- symlink reads/hashing;
- observer callbacks;
- manifest-entry allocation;
- recursion/loop control; and
- attempt/scan finalization.

The report emits the same fixed fields for each attempt plus an all-attempt
sum; zero-work fields are zero, never omitted, and no path/repository label is
admitted. `scanWallMs` spans all attempts and finalization. Accounting closes
when `abs(scanWallMs − sum(buckets)) ≤ max(2ms × attemptCount, 5% ×
scanWallMs)` on every measured scan, with at least 30 measured scans in each of
pruned-success and pruned-invalidated→full-fallback fixtures after five warmups.

Instrumentation overhead uses a paired incremental A/B run, not a comparison
to historical logs: sink-absent and sink-present trials of the same executable
alternate in ABBA order over the same frozen fixture, process/runtime settings,
and reset cache snapshot, for at least 30 pairs per fixture after warmup. The
absent case retains only the single outer monotonic wall stamp; installing the
sink enables the buckets. The report publishes every pair and
`sum(enabledWall − disabledWall) / sum(disabledWall)`; that overhead must
remain <2%. The existing dircache benchmark must also be non-regressing.

### 4.2 Kernel B — make degraded trust VISIBLE

The daemon adds `watcherTrust?: "suspect" | "fused"` to the v1 ambient record,
derived directly and only from `trustState` (omit it for `trusted`). This is
independent of `attentionReason: "watcher-degraded"`, which remains the generic
backend-degradation signal: either or both may be present. It is not
`activity.halt` and cannot affect scheduler eligibility.

The additive field has this complete projection contract:

- projection writes it from the current `trustState` on every ambient update;
- validation accepts only `suspect|fused`, treats absence as
  unknown/old-writer rather than `trusted`, and otherwise preserves the v1
  parser's fail-closed handling of malformed records;
- observation admits it only from `trustedAmbient`: the ambient record must
  belong to the live pidfile boot ID, current workspace, fresh heartbeat, and
  non-stale incarnation before full status may use it;
- `status-projection` copies the admitted value onto the daemon projection;
- brief status renders `watcher trust suspect — pulls may scan while trust is
  rebuilt` or `watcher trust fused — restart rbox to restore reactive pulls`
  when no halt/quota verdict outranks it;
- verbose status always includes a watcher-trust row when the field is
  admitted, even when halt/quota is also present; JSON adds
  `daemon.watcherTrust` as the same enum (or `null` when absent/unknown); and
- primary-attention precedence remains halt > quota > watcher trust. Trust is
  supplementary in verbose/JSON and cannot conceal either higher-priority
  condition.

Old ambient records omit the field and remain valid; old readers ignore the
new additive key. This field does not change ambient `state` or
`attentionReason`, prompt status, daemon health/readiness, command exit status,
trust transitions, retrust/fuse behavior, or recovery authority. It provides
visibility only.

### 4.3 Evidence-gated mechanisms (each requires a hop still over budget in
round 6, and lands with its own review)
- Sender signal fix — whatever 4.1's tracing names (could be a chokidar-only
  gap, a desktop trust side-effect, or a real darwin channel need; the fix is
  designed AFTER the trace).
- Notify fast-lane — requires scheduler-owned urgency metadata (carrier is
  daemon-owned today, daemon.ts:407,1616; policy sees four booleans,
  policy.ts:85) AND a scan-service bound so notify bursts cannot starve the
  reconciliation floor (r1 finding 4). Not a local priority edit.
- Supervised retrust / fuse escape — only if trust still fails to converge
  once scans are cheap: the EXISTING retrust path (clean scan + stable
  generation, design 104) was actively holding at 5/6 drops during pull
  churn; if the churn goes away, trust may converge with zero new machinery.
  Drop/operation overlap is telemetry-only forever (unknowable causally —
  r1 finding 2); it never touches errorGen/fuse accounting.
- Delta-scoped apply — requires a first-class delta-reconcile contract
  (completeness proof, scoped baseline count for the mass-delete denominator,
  full expected authority for oracle receipts — r1 finding 3). F2 narrowing
  needs a partial-authority observation receipt that does not exist
  (r1 finding 5). Both are REAL designs, not fallback variants; they exist
  only if the res fix leaves applying pulls over budget.
- Deferral residual cap — moves to design 234 with the rest of the deferral
  semantics (r1 finding 6); the bench simply reports the deferral tax so 234
  has its number.

## 5. Validation gates (kernel)

- The extended rig scenario runs both required stimuli on every backend and
  the live fleet; the reused report prints attempted/exact/coalesced/unmatched/
  invalid-clock counts, the clock bound, exact joined hops, witnesses, and the
  untouched WS fields. At least 30 exact attempts per stimulus/backend are
  required before p50/p95 and the ≤10s gate are authoritative.
- Sender trace proves backend armed, event seen/classified, debouncer arm/fire,
  first `false→true` push want, op begin, and publish receipt sequence — a
  sequence-joined table, not a story.
- Scan accounting meets the closure, sample-size, paired A/B <2% overhead, and
  dircache non-regression contracts in §4.1 for both pruned-success and
  fallback paths.
- Suspect and fused ambient records pass parser validation, current-boot/fresh
  admission, and brief/verbose/JSON projection/render tests. Old records and
  old readers remain compatible; halt/quota precedence, health/readiness, and
  exit semantics are differential fixtures.
- Termination during the existing atomic ambient-record write retains today's
  absent/old-or-complete record behavior; observation never admits a partial,
  corrupt, stale, or wrong-boot trust field.
- Existing scheduler/watcher/trust suites pass unmodified: the kernel observes
  state and makes it visible but changes no scheduling or trust transition.
- No runtime path, command, compatibility behavior, safety floor, migration,
  or fast path is approved for deletion or retirement by this design. The only
  safe deletion candidates are unearned proposals removed by §7 after the
  round-6 evidence gate.

## 6. Requirement challenges

| Requirement | Cost | Decision |
|---|---|---|
| Preempt/cancel in-flight ops for notify | cancellation safety machinery | rejected — with scan costs fixed, waits are seconds |
| FSEvents persistent-journal boot delta | new darwin-only persistence | deferred — boot cost is off the 10s path |
| Second quiesce window for the fast path | duplicate debounce concept | rejected — 400/3000 batcher IS the window |
| Treat `res` as irreducible walk cost | designs around a bug | rejected — instrument first (§4.1) |

## 7. The knife — r3

Kernel (build now, all observation): 1) bench harness + signal tracing,
2) res buckets, 3) fused-trust visibility. Nothing else. Then round-6 bench
on the fleet names which hop is still over ≤10s, and ONLY those mechanisms
get designed — each with its own doc section and review. Anything the
number does not demand is deleted from this design, not parked.

Predicted but unproven (recorded so round 6 can falsify us cheaply): the res
fix alone likely collapses receiver cost AND stops the FSEvents starvation
that blocks retrust, which would make the notify lane, retrust machinery, and
delta apply all unnecessary. If round 6 says otherwise, the numbers will say
which one earns its complexity.
