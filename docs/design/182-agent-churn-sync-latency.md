# 182 — sync latency under continuous agent churn (capture in the gaps)

Status: DRAFT v0 — problem statement + mechanism sketch, captured from the
founder's framing 2026-07-22. No review rounds yet; queued behind 180/179
implementation and 178 tranche 3.

## The paradigm (founder, lightly compressed)

LLM/agent-driven development is becoming the primary use of software: heavy
file churn from agents running on many developer machines, often in
parallel, sometimes in worktrees, sometimes on branches. It's hard to know
what is truly deferrable — if we defer a busy repo long enough and the user
then switches from desktop to laptop, the code has to already be on the
other machine. We can't defer indefinitely. That's the trade-off, and we
don't have a good solution yet.

Field evidence, same day: a codex agent on the founder's Mac STOPPED the
rbox daemon to avoid "recreating a deferral" while it modified 15 files —
trading one repo's capture lag for zero replication of the whole machine.
Second agent (after the 2026-07-21 incident operator stop) to misread
deferral as a hazard. Status output is now an agent API; alarming copy
causes agent behavior loops.

## Why the trade-off is softer than it looks

1. **"Busy" is measured too coarsely.** Git holds locks for milliseconds;
   agent workloads create thousands of tiny lock windows with real quiet
   gaps between tool calls. The existence-only probe (shared.ts:591 area)
   samples occasionally and stamps a deferral with a retry floor, so
   "deferred 1h" usually means "sampled unluckily," not "no safe moment
   existed." The unsafe windows (ref transactions, index writes) are
   milliseconds; the object store is immutable and always safe to read.
2. **The deadline is not continuous — it's handoff.** Freshness matters at
   the moment another machine asks. That moment is observable (the peer
   pulls / comes alive on WS).

## Mechanism sketch (for the future review loop)

A. **Event-driven micro-gap capture.** Watch lock paths on the existing
   watcher plane instead of polling; on lock-clear, attempt capture
   immediately (bounded attempts/sec). Expected to kill most deferral
   latency at the source. Never weakens the never-capture-mid-operation
   invariant — it only finds the real gaps.
B. **Demand-driven flush.** When peer B pulls (or wakes) and sees peer A's
   advertised deferred lanes, B signals A over the existing WS plane:
   "flush repo X now." A escalates that repo to tight-interval gap-hunting,
   captures, pushes. Deferral semantic becomes "until demanded," which
   bounds the laptop-switch case by need. UX: "catching up from your
   desktop… Ns".
C. **Churn-as-heat scheduling.** A repo generating constant lock traffic is
   the most valuable repo on the machine, not the least — schedule its
   capture attempts hardest (inverting today's defer-and-back-off), within
   A's bounded attempt budget.
D. **Don't guess transience.** Agent worktrees that get squash-merged and
   deleted an hour later are indistinguishable in advance from the one that
   matters. Sync everything; let deletion propagate; content-addressing
   makes doomed-work bandwidth cheap. The hygiene work is ghost-record
   cleanup (pr8 class, 178 t3) and remnant pruning — not prediction.
E. **Agent-readable status contract.** Calm, non-alarming deferral copy
   everywhere (the bar "Degraded" papercut is the same bug); an explicit
   machine-parseable line: safe-to-leave-running, do-not-stop-the-daemon.
   Agents act on status text; treat it as API.

## Relationship to existing work

- 178 t2 (shipped v1.7.21): deferrals self-clear and report honestly — the
  hygiene floor this builds on.
- 178 t3 (queued): lock ownership classification + gone-directory ghost
  clearing — prerequisite for trusting lock-plane signals.
- 176/177: resolution semantics unchanged; B/C only move CAPTURE timing.
- Design 174's held-apply bounds and the 1h floor remain apply-side
  concerns; this doc is capture-side.

## Non-goals (pinned early)

- No capture of mid-operation git state, ever. Latency is bought with
  better gap detection and demand signals, not weakened safety.
- No transience prediction / selective sync.
- No new daemon-stop choreography; the whole point is that stopping is
  never the answer.
