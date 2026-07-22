# Design 178 tranche 1 — field-failure implementation review R8

Verdict: **ALIGNED**

The exact admitted boot now gates promotion under the desired mutation lock;
same-mode replacement ABA is covered. Boot and upgrade share a generation-
guarded resume API, completed stop wins their stale-row races, and upgrade no
longer adds a credential dependency or bypasses persistence hooks. Desired
rename is directory-fsynced, timeout→retry coverage lives under the mandated
`daemon-control*` glob, and stopped records cannot retain pending intent.

Review validation: typecheck green; 61 focused tests passed.
