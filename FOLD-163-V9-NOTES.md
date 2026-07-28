# FOLD-163-V9 — round-five targeted fold

Two residuals from the codex serial review of the v8 tip. Doc:
`docs/design/163-state-plane-sqlite.md`, status line moved to **v9**.

## Residual 1 — the pre-`Q` silent lost write

V8's paired witness sample is not atomic with M6's rename. An unlocked
pre-`1.11.0` writer can `fs.rename` between the final sample and M6's rename;
M6 then overwrites that fresh JSON with `Q`, and both the migrated DB and the M2
backups descend from the older source. Distinct from the post-`Q` destruction
`F3` asserts, and unnamed in v8.

What v9 does:

- **(a) Shrink the window.** M6 re-verifies `.rbox/state.json`'s
  `stateBodySha256` against the M3-imported source digest as the *immediately
  preceding operation* to `fs.rename`, under the held `stateLockPath`. Mismatch
  is a typed `legacy-write-detected` disposition: no rename, C1 retirement, JSON
  authoritative. V8 already rehashed the live JSON, but at the *start* of the M6
  exact-sibling step; v9 moves it to the last instant. Explicitly not atomic —
  `writeFileAtomic` exposes only `beforeRename` (`fsutil.ts:40`).
- **(b) Name both outcomes.** (i) post-`Q` destruction (`F3`); (ii) pre-`Q` lost
  write in the `check → rename` microwindow (`F5`). Preconditions restated
  without v8's falsified necessity claims — a pre-`1.11.0` binary, the
  `forceLegacy`-or-`unsupported` path, and a rename landing in one of the two
  windows. Nothing about spanning M0–M6.
- **(c) Detection, without overclaim.** Outcome (ii) is **unrecoverable and
  silent**. `fs.rename` (`fsutil.ts:83`) releases the displaced inode and M6
  never opened it, so preservation is not implementable; no `.bak` diverges and
  no witness records the write. `F5` asserts the *absence* of a doctor anomaly
  so the silence cannot drift. Damage is limited by convergence, not detection:
  `state.json` is a manifest cache plus derived git records, so the failure mode
  is a stale BASE with a fail-closed consumer.
- **(d) Ratification.** Pinned to the `B0` adoption gate and made a hard U3 exit
  criterion: if telemetry cannot show the pre-`1.11.0` population drained, U3
  does not open.

Fixture matrix `F1`–`F4` → `F1`–`F5`.

## Residual 2 — reserve header encoding

V8's 64-byte `RBOX-STATE-RESERVE-v1 <semver> <stream>\n` cannot fit. Byte math
now in the doc: fixed overhead `24` + variable fields; verbatim stream needs
`101`, full SHA-256 hex needs `94`, truncated hex makes the digest width a
function of the semver. All three 64-byte forms rejected.

Header is now **128 bytes**: magic (21) + SP (1) + semver (`<= 40`) + SP (1) +
lowercase SHA-256 hex of the workspace `stream` (64) + `\n` (1), NUL-padded.
Fixed overhead `88`, leaving exactly 40 for the semver. Zero fill becomes
**1,048,448**; `128 + 1,048,448 = 1,048,576`, so total size and the allocation
guarantee are unchanged. M1 adoption and M6 role-7 deletion share one rule:
byte-for-byte equality of all 128 bytes with the CAS-recorded header.
`reserve-foreign` extended to a malformed 128-byte frame.

## Review log

Extended with an `R4-v9 residual fold (v9)` section: two rows plus an explicit
note that v8's log row 1 asserted two bounds the cited source contradicts. The
v8 rows are left intact as the record of what v8 did; the corrections live in
the normative sections and in the v9 table.
