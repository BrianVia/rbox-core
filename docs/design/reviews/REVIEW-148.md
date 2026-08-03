# Review 148 — Git-shapes final live fixes

## Round 1 — evidence review

Three independent reviewers read the five failing rows, their full report and
run-log context, the scenario, designs 141 and 145–147, and the findings
protocol.

All reviewers agreed that S2 configured is a false negative caused by the
one-second non-TTY spinner throttle. They required the exact formatted capture
plan, exact apply line, zero exits, and native-repository proof instead.

All reviewers also agreed that the corrected rebase fixture fully aborts and
that the post-abort EPIPE is an engine gap. They independently identified the
unchanged-symbolic-HEAD transaction shape: recovery `create` consumes the
single `option no-deref`, after which Git rejects `symref-verify`. They rejected
the annex's settled/pending-empty/B-to-A expectations.

## Round 1 — response

design 148 records the exact post-abort gap, replaces the four failed positive
settlement assertions with positive gap assertions, requires the generated
finding, and updates both annex copies. It removes sequence-only no-op claims
from rebase.

## Round 2 — convergence review

One reviewer initially recommended stopping before a B commit; another
recommended preserving the fourth live observation as explicit gap evidence.
They aligned on a narrow probe after the immediate persistent state is pinned:
B push and A pull must exit zero, the plain receiver file reaches A, no native
capture plan appears, and A main remains unequal to B's commit. The cell then
returns without generic settlement cycles.

## Verdict

Both adversarial reviewers returned **ALIGNED** with the design and acceptance
criteria. Engine repair remains a separate follow-up design.

