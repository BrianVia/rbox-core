# Review 211 — local binding registry + `status --all` / `doctor --all`

Reviewer: codex `gpt-5.6-sol`, high reasoning, adversarial, run against the
branch with instructions to execute the tests and write its own multi-process
break probes.

## Round 1 — CHANGES-REQUIRED (11 findings)

Verbatim verdict summary: typecheck passed, the focused suite passed (57 tests),
a 32-process writer probe retained all 32 unique entries with valid JSON, and
test isolation plus the machine-JSON shape showed no defect.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 1 | BLOCKER | `untrack <stale-registered-child>` walked up and untracked whichever ancestor happened to be a workspace | FIXED — an exact registry hit wins before any upward search; regression test |
| 2 | HIGH | `rememberResolvedRoot` read the binding before the lock, so a pre-`untrack` snapshot could resurrect a forgotten entry | FIXED — both record paths re-read the binding inside the locked mutation; regression test |
| 3 | HIGH | `stop` can recreate `desired.json` after `untrack` removed the runtime dir | DECLINED — pre-existing daemon lifecycle race, identical under #503; with the registry the outcome is a reported, now-clearable `missing` row |
| 4 | HIGH | `forgetBinding` swallowed failures, so untrack could print "no longer lists it" about a surviving entry | FIXED — `forgetBinding` throws; regression test |
| 5 | HIGH | symlink-alias roots produce distinct registry/runtime identities | DECLINED — `path.resolve` is exactly how `workspaceKey` already names every daemon runtime dir; canonicalizing in the registry alone would make the two disagree. Repo-wide path-identity question |
| 6 | MEDIUM | a gate-rejected ambient record still supplied `deferredRepos` and the deferral suffix | FIXED — pending evidence comes only from a trusted record; regression test |
| 7 | MEDIUM | no `fsyncDirectory` after the atomic rename, unlike the mirrored desired-record writer | FIXED |
| 8 | MEDIUM | `--all` silently ignored `--verbose` / `--git` / `--residue-bytes` | FIXED — rejected; regression test |
| 9 | LOW | `name: ""` never converged; a far-future `lastSeenAt` read as fresh | FIXED — normalization + a lower age bound; regression tests |
| 10 | LOW | SIGKILL during staging leaves a `.rbox-tmp-*` file | DECLINED — shared `writeFileAtomic` convention used identically by `autostart-cmd.ts` |
| 11 | LOW | `OwnedLock.release()` result ignored | DECLINED — same as the prior-art `desiredRecordLock` |

## Round 2 — CHANGES-REQUIRED (3 findings)

Round 1's fixes were all confirmed real; only these were raised.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 1 | BLOCKER | `untrack <stale-root>/subdir` (and cwd-based untrack from a descendant) still resolves to the enclosing workspace | DECLINED — that is the memo's PATH-as-workspace-locator contract, not a registry behavior. `findRoot` has always walked up, and a descendant probe behaves **byte-identically** against `origin/main` and this branch (transcript in the PR). Making a stale entry shadow a live ancestor for every descendant path would be the regression |
| 2 | LOW | a name cleared in the config was carried forward from the cache, rewriting the registry on every command | FIXED — the refresh path is authoritative about the name; regression test |
| 3 | LOW | the design's unknown-field preservation guarantee was false | FIXED — the design now says what the code does (a local, fully reconstructible cache keeps only known fields) |

Rounds stop here per the 3-round cap: round 2 raised no unresolved finding above
LOW, and its single BLOCKER claim was disproved by a before/after transcript
rather than argued.
