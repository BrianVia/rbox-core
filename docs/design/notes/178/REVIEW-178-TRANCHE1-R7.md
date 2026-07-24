# Design 178 tranche 1 — field-failure implementation review R7

Verdict: **BLOCKING**

1. Promotion checked only the pending mode string, allowing an old boot's
   witness to clear a replacement boot's same-mode pending intent (ABA).
2. Boot and upgrade used cached running rows without a desired-generation
   guard, so a completed user stop could be undone by stale resume work.
3. Upgrade's production and injected paths diverged; production also added an
   unnecessary current-credential dependency after already stopping daemons.
4. Atomic rename lacked the directory fsync required for durable parking.
5. Timeout/retry coverage did not drive the boot-bound witness path and its
   file name was outside the mandated `daemon-control*` glob.
6. Parsing retained pending intent on stopped records.

The implementation and design were revised to close each item and were
re-dispatched for final review.
