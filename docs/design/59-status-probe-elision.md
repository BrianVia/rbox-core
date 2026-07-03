# 59 — Zero-network `rbox status`: trust the connected daemon, skip the probe

**Status:** draft — design only.
**Depends on:** design 45 (status health verdict, shipped v0.6.3), design 46
(shell.line sidecar, shipped v0.6.4), design 49 (idle backoff, shipped v0.6.6).
**Origin:** founder asked whether Cloudflare KV should cache the server side of
`rbox status`. Answer: no — the reads are already point reads and the felt latency
is the HTTPS round trip itself; KV staleness would also poison the one datum
(remote head) whose freshness is status's whole job. The real win is CLIENT-side:
when a live daemon already knows the answer, status shouldn't ask the network at
all.

## 1. Today

`rbox status` always fires `fetchRemoteSequence` (`src/cli/index.ts:33-60`) — an
authenticated GET of `/v1/ws/<ws>/proj/<proj>/latest` with a 2.5s abort — plus the
account/plan summary fetch, concurrently with the local sidecar reads
(`index.ts:355-365`). Measured wall cost ~90-160ms when online; up to 2.5s of
hang-feel when the network is black-holing. Meanwhile a RUNNING daemon holds a
hibernating WebSocket to the workspace DO (`daemon.ts:607-624`): the DO fans out
every new commit, the daemon pulls promptly, and its `activity.json` sidecar
(design 45, `src/cli/activity.ts:18`) already records heartbeat + last push/pull.
The freshest source about the remote is sitting on local disk; status ignores it
and re-asks the server.

## 2. Why heartbeat alone is NOT the trust signal

`activity.at` is written on pump ops, and design 49's idle backoff stretches the
safety-scan cadence to 5 minutes — an IDLE daemon's heartbeat is legitimately
minutes old while its WS is connected and fully current. Conversely a daemon whose
WS died (network change, laptop sleep) can keep heartbeating on scans while remote
moves unseen. Heartbeat freshness and remote currency are DIFFERENT properties.
The trust signal must be WS connectivity, recorded explicitly.

## 3. Design

### 3.1 New activity slot (daemon-written)

`DaemonActivity` gains:

```ts
/** WS link to the workspace DO. `at` refreshes on every WS event AND every pump
 *  tick while open — so a half-open TCP corpse ages out even when quiet. */
ws?: { connected: boolean; at: string };
```

Written on `open` (`connected: true`), `close`/`error` (`connected: false`),
refreshed (throttled alongside the existing heartbeat write path) while open.
Same shape-validated best-effort parsing as every other slot
(`loadActivity`, activity.ts — user-editable file, drop malformed).

### 3.2 Status elides the probe when the daemon can vouch

In the status assembly (`index.ts:355`), before firing `fetchRemoteSequence`:

TRUST = all of:
- daemon binding current + running (existing `daemonBindingStatus` gate — a
  stale-bound daemon already suppresses activity, design 45 R4);
- `activity.ws.connected === true`;
- `age(activity.ws.at) < WS_TRUST_MS` (**60s**) — bounds half-open sockets;
- no `halt` (a halted daemon is not keeping anything current);
- verdict inputs otherwise normal (a mid-op `active` daemon already renders
  "live progress", which needs no probe either).

When TRUST holds: skip the GET entirely; the remote line renders honestly as

```
remote: live via daemon (ws connected)
```

and the verdict uses the daemon's recorded sequence trail (`lastPush.sequence`
vs local `lastSyncedSequence`) exactly as design 45 already does when the probe
returns. When TRUST fails for ANY reason: probe exactly as today — this design
adds zero new failure modes, only removes a request on the happy path.

### 3.3 Freshness argument (why this is not KV-staleness in disguise)

With WS connected, a remote commit triggers DO fanout → daemon pull within the
pump latency; the window in which status could say "in sync" while remote just
moved is the same window today's probe has between its response and the render.
Same freshness class, zero staleness budget added — unlike KV (≤60s global
eventual consistency ON TOP of the round trip, on exactly the wrong datum).

### 3.4 Account summary (companion, optional)

The plan/usage line keeps its fetch for v1 (it is not correctness-bearing).
Follow-up option, out of scope here: cache the last account summary in a local
sidecar with a rendered age ("plan pro · used 1.2G — as of 3h ago") and refresh
opportunistically after syncs.

## 4. Implementation shape

- `activity.ts`: `ws` slot type + validation + write helpers (daemon side wires
  into the existing throttled heartbeat writer — no new write cadence).
- `daemon.ts`: set/clear/refresh at the WS lifecycle points (`:607-624` connect
  path, close/error handlers, pump tick refresh).
- `index.ts` status assembly: TRUST predicate (pure, colocated-tested with fake
  activity fixtures + fake clock) gating the `fetchRemoteSequence` call; remote
  line render variant.
- `status-view.ts`: render `remote: live via daemon` (and keep the probe render
  unchanged otherwise).
- shell.line (design 46) is untouched — the daemon already renders it locally.

Tests: pure TRUST predicate table (connected/stale-at/halt/binding permutations),
activity round-trip with the new slot, and the existing status tests unchanged
(probe path preserved).

## 5. Non-goals

- Any server-side caching (KV/Cache API) — rejected above.
- Eliding the probe when the daemon is stopped/stale/halted (probe stays).
- Changing shell-glyph (design 46) behavior — already zero-network.
- The account-summary cache (§3.4 follow-up).

## 6. Risks

- **Lying daemon**: a wedged-but-connected daemon that stops pulling would make
  status optimistic. Mitigation: `ws.at` refresh rides the pump tick — a wedged
  pump stops refreshing and TRUST ages out in ≤60s.
- **Clock skew**: `ws.at` is same-machine wall clock read back by status on the
  same machine; skew is a non-issue (no cross-machine comparison).
- **User-edited sidecar**: already the threat model of activity.json; the slot is
  shape-validated and TRUST failure degrades to today's probe.

---

# V2 REVISIONS (review round 1 — all findings accepted; binding, later overrides earlier)

The three BLOCKERs share one root: v1 tried to infer remote currency from
connectivity. V2 makes the daemon RECORD remote currency — the DO already pushes
the commit sequence in its fanout; the daemon discards it today
(`daemon.ts:627` queues a bare pull). Keeping it changes elision from
"trust the socket" to "compare two sequences we hold locally."

R1 (BLOCKER 1): **Record the broadcast sequence.** The `ws` activity slot becomes
`ws?: { connected: boolean; at: string; lastBroadcastSequence?: number }`, written
BEFORE the pull is queued when a fanout arrives. Elided-verdict math is then the
SAME comparison design 45 makes with the probed value: `remoteSeq =
max(ws.lastBroadcastSequence ?? 0, state.lastSyncedSequence)` vs
`state.lastSyncedSequence` — behind-remote renders as behind-remote even when the
pump never serviced the pull. `lastPush.sequence` is NOT used for verdict math
(it was always just the trail line).

R2 (BLOCKER 2): **A wedged pump can no longer lie.** Because R1's verdict uses the
recorded broadcast sequence, a stuck pump with a live WS shows
`behind remote (daemon has not applied seq N yet)` — honest degradation, not
false "in sync". `ws.at` refresh (R4) additionally never comes from pump-side
wants, only from WS-layer traffic.

R3 (BLOCKER 3): **Sleep/half-open.** `ws.at` refreshes ONLY on actual WS-layer
events (message, pong) — never on pump/safety ticks. A laptop-sleep resume with a
half-open socket gets no WS events, so trust ages out within WS_TRUST_MS and
status probes. Post-sleep missed commits are additionally covered by the on-open
resync pull (`daemon.ts:622`) once the socket re-establishes.

R4 (SHOULD-FIX 4): **Dedicated keepalive, not pump cadence.** The daemon sends a
WS ping every 25s while open (the DO's hibernation layer can auto-respond
without waking — verify `setWebSocketAutoResponse` during implementation; if
unavailable, a 1-byte app-level ping frame handled in the DO's message handler).
Pong/message refreshes `ws.at`. WS_TRUST_MS stays 60s (>2 missed pings). Design
49's scan backoff is untouched — the keepalive is network-only, no disk IO or
scan work.

R5 (SHOULD-FIX 5): elision requires STRICT binding: `workspace.bound` present AND
`=== cfg.remoteWorkspaceId`. Unknown/missing binding keeps today's lenient
DISPLAY behavior but always probes.

R6 (SHOULD-FIX 6): render exposes source + evidence, never a bare claim:
`remote: seq 42 · live via daemon (ws, 8s ago)` — and the design-45 "in sync
requires remote confirmation" contract is amended to accept the recorded
broadcast sequence as confirmation-equivalent WITH the source label; when trust
fails, today's probed render is unchanged.

R7 (SHOULD-FIX 7): test plan upgraded — pure predicate table PLUS daemon/status
integration tests: fake WS injecting fanout frames (sequence recorded before
pull), held pump (verdict shows behind-remote), fake timers aging ws.at past
trust (probe fires), unknown-binding (probe fires), sleep-simulation (no WS
events → age-out).

R8 (NIT): §1's concurrency claim corrected — the account summary fetch is NOT in
the `Promise.all` (it happens later, `index.ts:433`); only activity/probe/git/
trash are concurrent.

---

# V3 AMENDMENTS (confirm-round resolutions — binding, later overrides earlier)

A-R3 (reopened → resolved): **trust begins only after the on-open catch-up pull
SUCCEEDS.** The ws slot gains `caughtUp: boolean` — set `false` on every
open/close/error, set `true` only when the connection's initial catch-up pull
(`daemon.ts:622-625`) completes successfully; any later WS close resets it.
Elision requires `caughtUp === true`. Commits missed while disconnected are
therefore reflected in `lastSyncedSequence` before the first elided verdict of a
connection can exist.

A-R4 (reopened → resolved): **honest persistence cadence.** ws.at refresh is
driven by WS pong/message but PERSISTED throttled: the sidecar is rewritten at
most once per 20s for keepalive purposes (~3 tiny writes/min while connected —
the "network-only, no disk IO" claim in R4 is WITHDRAWN as impossible; this is
the corrected cost statement). The ws-slot writer is a separate path that does
NOT bump the top-level `activity.at` heartbeat (its design-45 semantics — "last
pump op" — are unchanged); implementation extends `writeActivity` with an
explicit ws-only update mode or a sibling writer.

A-V2A (new BLOCKER → resolved): **restart inheritance.** (a) On daemon start,
before any connect, the daemon overwrites the ws slot with
`{ connected:false, caughtUp:false, pid:<self> }`; (b) the slot carries the
writing daemon's `pid`, and status's TRUST additionally requires
`ws.pid === aliveDaemonPid` (the pid `daemonBindingStatus` already resolves). A
fresh process can never be vouched for by a dead one's sidecar, even in the
window before its first write.

A-V2B (new SHOULD-FIX → resolved): shape rules for the slot:
`lastBroadcastSequence` must be a finite non-negative integer (else the whole ws
slot is dropped → probe); daemon-side it is monotonic non-decreasing in memory
(a lower broadcast never overwrites a higher one); `pid` finite positive int.

A-R7: test plan additions — reconnect-elides-only-after-catchup (open → trust
denied → pull completes → trust granted), daemon-restart stale-sidecar (new pid,
old connected:true slot → probe), pong-throttle persistence (fake timers: ws.at
persisted ≤1/20s), monotonic broadcast sequence.

A-R6 note: implementation widens `StatusSnapshot`'s remote field to carry
`{ sequence, source: "probe" | "daemon", ageMs }` for the render.

---

# V4 AMENDMENTS (round-3 resolutions — binding, later overrides earlier)

A4-1 (NEW-BLOCKER-1, echo suppression): **the DO broadcasts to ALL sockets** —
the `fromDeviceId` skip in `ws-fanout.ts:20` is REMOVED (one-line server change,
shipped with this design). The pushing daemon's own catch-up pull no-ops (its
`lastSyncedSequence` already advanced through the push), so the echo costs one
frame and a no-op; in exchange, a same-device second checkout / one-shot push
from another root can no longer create a broadcast blind spot. The elided
verdict then sees every commit the probe would have.

A4-2 (NEW-BLOCKER-2, write ordering): ALL ws-slot updates flow through the
EXISTING serialized activity write chain (`daemon.ts:489`) as ws-only merges —
no sibling writer, no independent file write. Ordering therefore inherits the
chain's guarantee: a keepalive enqueued before a close can never land after it,
and `halt`/trail slots are never clobbered (merge, not replace).

A4-3 (A-V2A reopened → resolved, PID reuse): replace the pid check with a
**launch nonce**: the spawning parent generates a random `bootId`, records it in
the daemon binding record (`workspace.bound`, written by the parent alongside
the pidfile at `daemon-control.ts:239`) and passes it to the child (env); every
ws-slot write carries `bootId`; status TRUST requires
`activity.ws.bootId === binding.bootId` for the CURRENTLY-recorded pidfile.
PID reuse and the pidfile-before-first-child-write window both fail the nonce
match → probe. (`pid` stays in the slot for debugging only, not trust.)

A4-4 (NEW-SHOULD-1): lifecycle transitions (`open`/`close`/`error`,
`caughtUp` flips) BYPASS the keepalive persist throttle — they enqueue
immediately on the serialized chain; only pong/message `at` refreshes throttle.

A4-5 (A-R7): test plan additions — stale catch-up completion after rapid
reconnect (old pull completing must not set `caughtUp` for the NEW connection:
tie the pull completion to the connection generation that queued it), bootId
mismatch (reused PID) → probe, same-device second-checkout commit visible in
elided verdict (echo test, server-side), keepalive-after-close ordering through
the chain, and pong-throttle LIVENESS (ws.at does keep advancing, not merely
"rarely writes").

---

# V5 AMENDMENTS (round-4 resolutions — binding, later overrides earlier)

Reviewer note: this is a DESIGN document — every "removed/changed" statement in
V4/V5 PRESCRIBES the implementation change that ships with this design; none of
it is claimed to exist in live code yet.

A5-1 (echo suppression, BOTH sides): in addition to the server-side fix (A4-1:
remove the `fromDeviceId` skip in `ws-fanout.ts:24`), the DAEMON's own
same-device skip (`daemon.ts:630`, `m.deviceId === this.cfg.deviceId` → ignore)
is ALSO removed. The handler processes every `committed` frame: record
`lastBroadcastSequence` FIRST (monotonic), then queue the pull — which no-ops
when already caught up (the push that caused the echo already advanced
`lastSyncedSequence`). Cost: one no-op pull per own-push; benefit: a same-device
sibling checkout's commits are always visible to the elided verdict.

A5-2 (binding schema, explicit migration): `workspace.bound` becomes a VERSIONED
record: `v2 <workspaceId> <bootId>` (one line, space-separated). All readers
(`daemonBindingStatus` at `daemon-control.ts:44`, the doctor stale-binding
guard, stale-binding tests) accept BOTH formats: a legacy plain id parses with
`bootId: undefined`, which always FAILS the trust match (→ probe) while keeping
every existing display/stale behavior intact. WRITER ORDERING (the round-4 sharp
edge): today the parent deletes `workspace.bound` and writes only the pidfile
(`daemon-control.ts:224`), while the CHILD writes the binding at `daemon.ts:152`
— under this design the parent generates `bootId`, passes it to the child (env),
and the CHILD writes the full v2 line exactly once at startup (single writer, no
clobber window: until that write exists, binding is absent → trust fails →
probe).

A5-3 (test plan, final): add the daemon-side echo test (same-device `committed`
frame → `lastBroadcastSequence` recorded + elided verdict reflects it) and
legacy-`workspace.bound` back-compat cases (plain-id file → display unchanged,
trust denied; v2 line → both parsed).

---

# V6 AMENDMENTS (round-5 resolutions — binding, later overrides earlier)

A6-1 (durability, NEW-BLOCKER-1): committed-frame handling is LIFECYCLE-class:
the sequence record + `ws.at` refresh ride ONE immediate merged write on the
serialized chain (no keepalive throttle), enqueued before the pull is queued.
Trust semantics are defined ON THE DISK RECORD only — status never sees daemon
memory. The two failure windows this leaves are both bounded and smaller than
today's probe equivalents: (a) frame-arrival → write-durable is single-digit ms
on a local disk, versus the probe's own ~100ms response-to-render window — an
elided verdict can be "stale" by strictly less time than a probed one; (b) a
STALLED write chain stalls keepalive `ws.at` refreshes too (same chain, same
file), so on-disk `ws.at` ages out and trust self-expires within WS_TRUST_MS —
a wedged writer cannot stay trusted past 60s. Test: hold the write chain with a
fake fs, assert the elided path degrades to probe once ws.at ages, and that a
committed frame's persist precedes the pull queueing in the op order.

A6-2 (bootId anchoring, NEW-BLOCKER-2): `bootId` lives IN the pidfile — the
parent writes `v2 <pid> <bootId>` (same dual-format reader treatment as
`workspace.bound`: legacy bare-pid parses with `bootId: undefined` → trust
fails, display unchanged). TRUST requires: pidfile parses v2 AND its pid is the
live `isOurDaemon` pid AND `activity.ws.bootId === pidfile.bootId` (AND, per
A5-2, `workspace.bound` v2 matches the same bootId). Overlapping starts collapse
to whichever daemon owns the CURRENT pidfile: the loser's activity/binding
writes carry a bootId the pidfile no longer names → mismatch → probe. No
startup lock needed; the pidfile is already the single authority the stop/start
paths fight over. The child receives bootId via env (parent generates it before
spawn) and stamps it into every ws-slot write + its `workspace.bound` v2 line.

A6-3: test-plan closure for both: delayed/stalled-sidecar-write (A6-1b),
persist-before-pull ordering (A6-1a), pidfile-v2 legacy back-compat, and the
overlapping-start loser-bootId-mismatch case.

---

# V7 AMENDMENTS (round-6 resolutions — binding, later overrides earlier)

A7-1 (A6-1 reopened → resolved structurally, not by timing claims): activity
persists are WHOLE-SNAPSHOT serialized writes — every write that lands carries
the daemon's complete current in-memory record, so the on-disk
`lastBroadcastSequence` can never be older than the on-disk `ws.at` from the
same write. The staleness of an elided verdict is therefore EXACTLY the rendered
`age(ws.at)` — self-describing, not asserted. Failed/slow individual writes are
healed by the next persisted snapshot (keepalive cadence). Elision gets its own
tighter age gate, separate from connection trust: `ELIDE_MAX_AGE_MS = 30s`
(> the 25s ping cadence, so a healthy idle daemon qualifies) — beyond that,
probe, even while `connected` under the 60s WS_TRUST_MS. Truth-lag ceiling for
an elided verdict: 30s adversarial, sub-second typical (fanout + immediate
lifecycle write); the ~100ms-vs-ms comparison from A6-1 is WITHDRAWN in favor of
this bounded, rendered-age model.

A7-2 (NEW-BLOCKER-1, DO ordering — server change ships with this design): the
DO broadcasts the committed frame IMMEDIATELY after the authoritative head
advance (`workspace-sync.ts:274-290`), BEFORE the awaited best-effort D1 mirror
(`:310-319`). Rationale: `/latest` serves the advanced head at once, so the
fanout must not lag it by a dependent await — otherwise the probe-visible window
is elision-invisible. The D1 mirror stays best-effort after the broadcast;
failure semantics unchanged (mirror retries/backstops as today).

A7-3 (NEW-SHOULD-FIX-1, loser hygiene): at startup, after the parent-written v2
pidfile exists, the CHILD verifies it owns it (`pidfile.bootId === env bootId`);
a non-owner logs and EXITS instead of writing `workspace.bound`/activity — a
late loser can no longer disable a healthy winner's elision (availability), and
the winner's records are the only ones on disk (consistency). This matches the
existing single-daemon-per-root semantics.

A7-4: test additions — whole-snapshot invariant (a persisted file's sequence ≥
any earlier persisted sequence; sequence and ws.at always co-written), elide-age
gate (age 29s elides, 31s probes, connected either way), DO ordering (fanout
observable before the D1 mirror settles — server test), loser-exit (second
child with stale bootId exits without touching binding/activity).

---

# V8 AMENDMENTS (round-7 resolutions — binding, later overrides earlier)

A8-1 (A7-3/NEW-BLOCKER-1 → resolved, continuous ownership): the one-time child
startup check is replaced by ownership verification ON EVERY serialized
binding/activity write (keepalive persists included — one ~50-byte pidfile read
per persisted write, ≤3/min): the writer re-reads the pidfile and requires
`pidfile.bootId === own bootId`; on mismatch it logs and EXITS without writing.
A parent-B overwrite therefore dethrones child A at A's next write — no stale
records land after the takeover, closing the spawn-before-pidfile-write window
(`daemon-control.ts:232`) without changing the parent seam or adding a lock.

A8-2 (NEW-SHOULD-1, wording): the D1 mirror's failure semantics are
"best-effort log/drop as today" (`d1_commit_mirror_failed` after INSERT OR
IGNORE, `workspace-sync.ts:308`) — the V7 "retries/backstops" phrasing is
corrected; this design changes ONLY the ordering (broadcast first), not the
mirror's semantics.

A8-3 (A7-4): test additions — "verified winner later loses pidfile": child A
running + persisting, overwrite pidfile with a new bootId, assert A's next write
exits without landing; and the write-path read cost is bounded (one pidfile read
per persist, none between).

---

# V9 AMENDMENTS (round-8 resolutions — binding, later overrides earlier)

A9-1 (unifying principle, resolves the TOCTOU reopen by scoping the claim):
correctness rests ENTIRELY on read-time ATTRIBUTION — the activity sidecar is
attributable iff `activity.ws.bootId` matches the live v2 pidfile's bootId (and
the v2 binding). The write-side ownership check is HYGIENE (bounds junk writes),
not a correctness gate; the check-then-rename TOCTOU window is ACCEPTED and
harmless: any record landing in it carries the loser's bootId and fails
attribution at read time (cost: one needless probe). A8-1's "no stale records
land" claim is WITHDRAWN in favor of this.

A9-2 (NEW SHOULD-FIX, total suppression): an UNATTRIBUTABLE sidecar is
suppressed WHOLESALE — status passes `activity = undefined` (identical to
today's stale-binding treatment, design 45 R4): no elision, no halt/trail/
progress lines from it. A dethroned writer can therefore never feed ANY status
surface, not merely not the remote verdict.

A9-3 (NEW BLOCKER, graceful wind-down): on write-side ownership mismatch OR
missing pidfile, the daemon NEVER hard-exits: it DROPS the trusted-surface
write and initiates the EXISTING graceful shutdown path (drain active pump,
then exit — `daemon.ts:250` semantics), preserving the stopDaemon contract
(`daemon-control.ts:249` removes the pidfile BEFORE SIGTERM lands — a mid-pump
write observing that removal must not abort the drain). FIRST-START grace: a
missing/legacy pidfile during startup (before the parent's v2 write at
`daemon-control.ts:232`) drops nothing permanently — writes proceed tagged with
own bootId (attribution simply fails until the pidfile appears), and no
wind-down triggers on ABSENCE alone; wind-down triggers only on a CONFLICTING
v2 pidfile (different bootId).

A9-4: test closure — TOCTOU window write (pidfile swapped between check and
rename → record lands, status attribution fails → probe; no crash); dethroned
daemon winds down gracefully mid-pump (drain completes, no mid-sync abort);
first-start guarded write before parent pidfile (proceeds, attribution begins
once pidfile lands); unattributable sidecar suppresses halt/trail/progress
wholesale.

---

# V10 AMENDMENTS (round-9 resolutions — binding, later overrides earlier)

A10-1 (NEW-1/A9-1 → resolved by shrinking the boundary): the v2 BINDING's
bootId is REMOVED from the attribution equation. Attribution = exactly two
checks: (a) binding WORKSPACE identity current (the existing design-45 stale
gate, unchanged) and (b) `activity.ws.bootId === live v2 pidfile.bootId`. The
pidfile is the ONE boot authority — it is already the file start/stop contend
over, and unlike the binding it is parent-written and re-written per start, so
a loser's landing-last binding cannot suppress a winner (its workspaceId is
identical for same-root daemons; its bootId field is now forensic-only).
`workspace.bound` keeps the v2 format for debugging, with zero trust weight on
its bootId. A9-1's binding-TOCTOU is thereby not "accepted" — it is out of the
trust path entirely.

A10-2 (NEW-2/A9-3 → one unambiguous rule): **wind-down triggers ONLY on
observing a CONFLICTING v2 pidfile (different bootId). Absence NEVER triggers
anything**: absent/legacy pidfile = keep running with existing behavior (covers
both first-start grace before the parent's write and stopDaemon's
remove-then-SIGTERM ordering — shutdown is driven by SIGTERM, never inferred
from file absence), writes proceed tagged with own bootId, attribution simply
fails-open-to-probe until the pidfile matches. The A9-3 sentence "missing
pidfile initiates graceful shutdown" is DELETED.

A10-3: tests — loser-binding-lands-last (winner's activity still attributed:
elision + halt/trails intact); stopDaemon mid-pump (pidfile removed, SIGTERM
pending: daemon finishes drain, no wind-down-from-absence, no crash);
absent-pidfile first start (writes proceed, attribution begins when the parent
write lands).
