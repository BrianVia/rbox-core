# FOLD-163-V11 — founder requirement reductions of 2026-07-28

What this fold is: an **amendment to a ratified document**. V10 was ratified
2026-07-28 (codex ALIGNED at `1a42a4f0`, merged in #537). Two founder decisions
taken after that ratification **delete requirements**. Nothing here adds a
mechanism, an artifact, or a file. The status line is therefore
`v11 — amendment to the ratified v10 …, changed sections pending codex
re-confirmation`: only the sections v11 touches are re-opened.

## Witness table (grep-provable in `docs/design/163-state-plane-sqlite.md`)

| # | Claim about v11 | Grep string |
|---|---|---|
| 1 | Status line is the amendment form, not a ratification | `v11 — amendment to the ratified v10` |
| 2 | Only changed sections re-open; the rest stays ratified | `changed sections pending codex re-confirmation` |
| 3 | The exclusivity rule has one normative name | `MIGRATION-EXCLUSIVITY-v11` |
| 4 | Exactly two admitted entry points | `exactly two admitted ways to be inside one` |
| 5 | Entry point (a) cites the real upgrade stop semantics | `src/cli/upgrade-cmd.ts:154` |
| 6 | …and that the stop actually waits for exit | `src/cli/daemon/process-control.ts:445` |
| 7 | …and that the window is per-workspace, not machine-wide | `not "the machine is quiet"` |
| 8 | Entry point (b) is a typed foreground command | `an explicit foreground `rbox migrate`` |
| 9 | Ambient/on-boot migration is deleted | `Deleted by this rule:** ambient migration` |
| 10 | Failure mode when the window is unprovable | `migration-not-exclusive` |
| 11 | The deleted U3 spec requirement is named as deleted | `SUPERSEDED BY EXCLUSIVITY (v11)` and `need not implement the paired-interval sampling` |
| 12 | …and its old refusal is named as gone | `legacy-writer-live` refusal are deleted` |
| 13 | The residue is reclassified, not silently dropped | `asserted by fixture` |
| 14 | M6's last-instant re-verify survives as defense-in-depth | `RETAINED AS DEFENSE-IN-DEPTH, no longer load-bearing` |
| 15 | Fixture framing changed, contents not | `Framing changed in v11, contents not` |
| 16 | Fixtures are kept as regression nets | `excluded by exclusivity, tested anyway` |
| 17 | B0's shipped code is not retroactively deleted | `NOT retroactively deleted` |
| 18 | The drain gate's data source is existing infrastructure | `existing `rbox-admin` version view` |
| 19 | …and #540 is recorded as closed-invalid | `#540 was closed as` |
| 20 | The drain bar itself is not relaxed | `The `telemetry-verified drain` bar is **unchanged**` |
| 21 | The fleet picture is recorded, not abstract | `1 external user on 1.6` |
| 22 | Open inputs dropped to one | `OPEN INPUTS OWED BY THE FOUNDER (v11 — there is exactly one)` |
| 23 | Founder question 1 is fully resolved, not partially | `No part of the question survives as an open input` |
| 24 | …and the machine profile is what's left | `machine profile is the only input still owed` |
| 25 | Review-log section exists for this round | `## R4-v11 founder requirement reduction (v11)` |

## Decision 1 — explicit-and-exclusive migration ("parked car")

The founder's rule: you migrate a parked car. Migration no longer runs
ambiently against possibly-live legacy writers. Two admitted windows:

- **(a) riding `rbox upgrade`.** Verified against `src/`, and the doc states the
  semantics rather than rounding them off: `restartDaemonsAfterUpgrade`
  (`src/cli/upgrade-cmd.ts:106`) iterates `~/.rbox/daemons` entries, calls
  `await stop(root)` at `:154`, and `stopDaemon`
  (`src/cli/daemon/process-control.ts:445`) sends `SIGTERM` and blocks on
  `waitForExit` until the named PID is gone before removing the pidfile. The
  loop then restarts *that* workspace (`resumeDesiredDaemon`, `:160`) before
  advancing to the next entry — so the exclusivity window is **per workspace**
  and is the interval between that workspace's `stop` returning and its resume.
  It is not "the whole machine is quiet", and the doc says so.
- **(b) explicit foreground `rbox migrate`.** A command the user types, in a
  workspace with no live daemon, running M0–M7 in the foreground with progress
  and a non-interactive twin.

**Enforcement and failure mode.** M0 admits only when its caller is one of the
two entry points *and* M0 independently confirms no daemon is live for the
workspace, from the existing pid-record/ownership evidence under the complete
lock set it already takes. Otherwise: typed `migration-not-exclusive` refusal —
no control published, no artifact created, JSON stays authoritative. There is no
"migrate anyway" mode. If the window cannot be guaranteed, migration refuses.

**Deleted:** the M0 paired-interval live-writer sampling and its
`legacy-writer-live` refusal, as a U3 implementation requirement.

**Reclassified (kept in the doc, no longer load-bearing):** the
`check → rename` microwindow analysis and residual outcomes (i) post-`Q`
destruction, (ii) pre-`Q` lost write, and (ii-ABA) the silent overwrite.

**Retained unweakened:** `Q` recognition and B0's write-side barrier (an old
binary started *later* must still refuse — exclusivity says nothing about it);
the `last-writer.json` witness sidecar (cheap, shipped, a claim about history
not concurrency); the 1 MiB reserve; M6's last-instant body-hash re-verify;
`F1`–`F6`; every M0–M7 crash/resume/halt property.

**B0 (#539) is untouched.** Its shipped barrier, witness, reserve, and pinning
inventory test are not withdrawn retroactively. They are defense-in-depth now,
which is a fine thing for shipped code to be.

## Decision 2 — the drain gate reads `rbox-admin` version telemetry

Founder: "I already have version telemetry in my rbox-admin repo." The
`telemetry-verified drain` bar in both the `B0` exit criteria and the U3 gate is
**unchanged in strength**; its implementation cost drops to zero. Issue #540
(build drain telemetry) closed as **invalid**. Fleet picture recorded so the
gate is read against named humans: 1 external user on 1.6 (personal contact, to
be nudged), 2 on 1.9.x upgrading frequently, founder fleet on dev builds.

## Founder question status

- **Open input 1 (migration before payoff) — RESOLVED, no surviving fragment.**
  The question was whether it is acceptable to push an irreversible flip at four
  real users on the project's schedule. Decision 1 removes the push: the user
  takes the migration inside an upgrade they chose to run, or by typing
  `rbox migrate`. What outlives it are two already-ratified obligations, not
  questions: the U3 no-regression gate and the plain-English halt copy.
- **Open input 2 (frozen machine profile) — still OWED, blocking U5.** The only
  input the founder still owes.

## Size

The amendment is a reduction in specification even though the file grows
slightly: the two mandated new sections (founder decisions ~5.1 KB, R4-v11
review log ~2.2 KB) total ~7.3 KB against a ~+3.2 KB net change, so the
pre-existing body shrank by roughly 4 KB — the § 1a closure parts two/three,
the residue passage, the M0 predicate bullet, and the v7-falsification narrative
all got materially shorter.
