# 67 — CLI polish: the launch sanding pass

**Status:** draft — design only.
**Depends on:** design 14 (upgrade/CI, shipped), design 45 (status health,
shipped v0.6.3), design 50 (destructive-apply safety / trash, shipped), design
51 (rbox.yml + `deps` disabled), design 58 (recovery kit, shipped), design 61
(daemon autostart, sibling draft — the `rbox uninstall` step D.2 assumes it ships first).

## 1. Problem

Nothing here is broken — the CLI works end to end. But a dozen small
inconsistencies (flag names, exit codes, error formats, internal strings
leaking into `--help`) are the kind of thing a new user or a reviewer notices
in the first five minutes, and they're cheap to fix in one pass before launch
rather than one grumpy bug report at a time after. This doc enumerates every
fix, cites the exact line it corrects, and notes where the fix isn't obvious.

## 2. Scope

### A. CLI consistency

**A1. `ignore`/`trash` take `--path`; everything else takes positional `[path]`.**
Confirmed: `push`/`pull`/`status` resolve root from `positional[0]`
(`src/cli/index.ts:266,290,335`), but `ignore` and `trash` resolve root from
`flags.path` (`index.ts:478,485`). **Original fix (positional path) REVERSED by
adversarial review 2026-07-03:** these commands' positional slots are already
taken — `ignore <glob>` reads the glob from `positional[0]`, and `trash
<list|restore|empty>` reads its subcommand there (`trash-cmd.ts:13`), so a
positional path would break `rbox ignore node_modules` and every `trash`
invocation. Revised fix: keep `--path` as the addressing mechanism for these
two, and make the inconsistency *legible* instead of invisible — document
`--path` prominently in both commands' help entries and in the usage-error
strings ("run from the workspace, or pass --path <dir>"). No parsing change.

**A2. Dead short flags on `logs`.** `parseFlags` (`index.ts:117-129`) only
ever populates keys from `--long` tokens — there is no code path that sets a
single-character key. Yet `logs` reads `flags.f` and `flags.n` as fallbacks
(`index.ts:471-473`: `flags.follow === "true" || flags.f === "true"` and
`flags.lines ?? flags.n`). Both `flags.f`/`flags.n` are always `undefined` —
dead code that *looks* like short-flag support but isn't. Fix: teach
`parseFlags` a curated short-flag table (not general getopt bundling — just a
fixed map so we don't have to solve `-xyz` clustering):
`-f`→`--follow`, `-n`→`--lines`, `-y`→`--yes`, `-w`→`--workspace`. Anything not
in the table stays a positional (preserves today's "unknown `--` becomes a
literal flag" leniency without extending it to single dashes).

**A3. `logs --lines` vs `versions --limit`.** Two names for "how many rows."
Standardize on `--limit` (it's the more common CLI convention and matches
`versions`); `logs` keeps `--lines` as an alias so existing muscle memory and
any scripts already using it don't break.

**A4. `init` exits 2 for usage errors; everything else exits 1.** Confirmed:
`init-cmd.ts:107` (bad init plan) and `init-cmd.ts:192` (device not enrolled)
both set `process.exitCode = 2`, while the top-level catch-all
(`index.ts:603-606`) and every other command's error path exit 1. Fix: unify
on 1. Document the exit-code contract explicitly (in `docs/usage.md` and
`rbox help`'s footer): **0 = ok, 1 = error, 130 = user cancel (Ctrl-C)**. No
command should carry a bespoke exit code beyond this contract.

**A5. Two error formats.** Top-level uncaught errors print
`rbox: <message>` (`index.ts:604`); `style.fail` prints `✗ <message>` in red
(`style.ts:49-52`, confirmed: `${stderrStyle.sym.err} ${stderrStyle.red(message)}`
where `sym.err` is `✗`). Both are used throughout the codebase depending on
which path a given command's error takes. Fix: single format everywhere —
`✗ rbox: <message>`. Concretely: `style.fail` gains the `rbox: ` prefix, and
the top-level catch in `index.ts:603-606` calls `style.fail` instead of its
own `console.error` (so NO_COLOR/FORCE_COLOR/TTY detection — already centralized
in `style.ts` — applies to the top-level catch too, which today bypasses it).
**Must be output-mode-aware (adversarial review 2026-07-03):** when the invoked
command ran with `--json` (§B), a thrown error that reaches the top-level catch
must emit `{"error": "<message>"}` to stderr, not `✗ rbox: …` — otherwise the §B
error contract is unimplementable for any error that escapes the command body.
One `emitError(message)` helper owns the branch (reads a module-level json-mode
flag set at dispatch); `style.fail` and the top-level catch both route through it.

**A6. Unhide `versions`/`restore` in help.** Both are marked `hidden: true`
(`help-registry.ts:329,336`) with a stale comment calling them "fail-closed
stubs" — they are fully shipped, paid-tier features (design 12 §15 / D11,
confirmed live in `index.ts:506-530`). Fix: move both entries out of the
"hidden: version-history stubs" block into the `SYNCING` group proper, drop
the now-wrong comment at `help-registry.ts:323`.

**A7. Strip internal strings from help text.**
- `doctor`'s `--diagnostics` flag description reads *"rbox.yml diagnostics is
  reserved for design 51"* and its `--report` description says *"requires
  --diagnostics or RBOX_DIAGNOSTICS=1"* (`help-registry.ts:291-292`) — a design
  doc number and an env var name are internal implementation detail in
  user-facing `--help`. Fix: describe the behavior ("upload requires opting in
  first — see `rbox doctor --help` for how"), not the mechanism.
- `login --plan`'s description reads *"honored only by dev-gated servers"*
  (`help-registry.ts:63`) — again internal. Fix: "ignored on servers that don't
  support bootstrap plan selection" or just drop the caveat (it's a no-op
  elsewhere, doesn't need defending in `--help`).

**A8. Friendly translation for raw endpoint errors.** Confirmed instance:
`workspace-picker.ts:205` throws
`` `account/workspaces failed: ${res.status} ${await res.text()}` `` straight
from the fetch — a raw HTTP status + server body surfaces to the user. Same
shape exists across `src/cli/remote/*.ts` (`api.ts`, `blobs.ts`, `commits.ts`,
`keys.ts`, `multipart.ts`) wherever a non-OK response is turned into an
`Error`. Fix: a shared "translate a raw remote error into an actionable
message" helper (map common statuses: 401 → "signed out, run `rbox login`",
403 → "not permitted", 404 → "workspace not found — check you're in the right
directory", 5xx → "rbox's servers are having trouble, try again shortly") used
by every `remote/*.ts` throw site and by `workspace-picker.ts`. **402 (quota
exceeded) is explicitly this design's non-goal** — that's design 62
(`62-quota-ux.md`, drafted as a sibling of this doc). This design's helper
should simply pass a 402 through unmapped (or with a generic "over quota"
line) so the two efforts don't collide.

### B. `--json`

Add `--json` to: `status`, `device list`, `account status`, `versions`,
`trash list`, `usage` (once shipped by the quota-UX design), `key status`.
Contract: stable **lowerCamelCase** DTO to stdout; on error, `{"error": "..."}`
to stderr and the normal non-zero exit code (unchanged); no ANSI color
(`--json` implies `NO_COLOR` semantics regardless of TTY). One-line DTO
sketch per command:

- `status --json`: `{ workspace: {id,name,root}, health, daemon: {running,pid}, remote: {sequence,source}, trash: {bytes,count}|null, account: {plan,usedBytes,capBytes} }` — `health` is NOT a new enum: it mirrors `shellStateOf` (`activity.ts:118`) verbatim, i.e. today `"ok"|"pending"|"active"|"halt"` plus design 62's `"outofstorage"` when that ships (adversarial review 2026-07-03: an invented `ok|pending|conflict` triple would drift from the real state machine; one source of truth)
- `device list --json`: `{ devices: [{id, kind, createdAt, lastSeenAt, revoked}] }`
- `account status --json`: `{ accountId, plan, graceUntil, readOnly, linked: boolean }`
- `versions --json`: `{ versions: [{sequence, committedAt, path|null}] }`
- `trash list --json`: `{ entries: [{path, deletedAt, size, batch|null}], totalBytes }`
- `usage --json`: verbatim `GET /v1/account/usage` DTO passthrough — design 62 §3.2 owns this contract; this doc just lists it for completeness
- `key status --json`: `{ enrolled: boolean, recoveryKit: {path, writtenAt}|null }` (mirrors design 58 §2.4's `rbox key status` line)

### C. Update nudge

Reuse the existing signed-manifest-check machinery (`upgrade-cmd.ts`: fetch +
`verifyAndParseManifest` at lines 42-69, forward-only `semverGt` check at
lines 176-181) behind `rbox upgrade --check`
(`upgrade-cmd.ts:193-196`, confirmed: prints `update available: <version> (you
have <current>) — run \`rbox upgrade\`` and returns without downloading). The
daemon runs this check at most once per 24h (new state file, see below),
never downloads or installs, and skips silently offline (the existing
`fetchBytes`/manifest-fetch already throws on network failure — the caller
just swallows it, same best-effort pattern as `fetchRemoteSequence` in
`index.ts:40-67`). Surfacing:

- `rbox status` gains a dim line when an update is pending: `update available
  0.7.1 → X.Y.Z — run \`rbox upgrade\`` (only when a check has actually
  succeeded and found something newer — never blocks status on a live check).
- Any interactive command prints a once-per-version stderr note the first
  time it runs after a new version is detected, then never repeats for that
  version.

State file (new, `~/.rbox/update-check.json`, same directory convention as
`release.json`/`upgrade.lock` in `upgrade-cmd.ts:83-85`):
```ts
{ lastCheckedAt: string; lastKnownVersion: string; lastNudgedVersion: string | null }
```
The daemon (which already runs continuously) is the natural owner of the
24h-cadence check; `status`/interactive commands only ever *read* this file,
they don't trigger a network check themselves (keeps `status` zero-network on
the happy path, consistent with design 59's whole point).

### D. `install.sh` verification

**The gap:** `scripts/install.sh:51` prints *"verify integrity via the signed
manifest... rbox upgrade checks it automatically"* — but the installer itself
does no such thing. It `curl`s the binary directly (`install.sh:41`) and
`mv`s it into place (`install.sh:46`) with zero manifest fetch, zero signature
check, zero sha256 comparison. The comment describes what happens on the
*next* `rbox upgrade` run, not what just happened during install — misleading
as written (reads like the install itself was verified).

**Fix:** port the sha256-pinning half of `upgrade-cmd.ts`'s logic into the
shell installer: fetch `$BASE/version` (the signed manifest), pull this
platform's `sha256` field for the artifact, download to a temp file while
hashing (mirrors `downloadToTemp`, `upgrade-cmd.ts:129-159`), compare against
the manifest's `sha256` (mirrors the check at `upgrade-cmd.ts:217`), and abort
before `mv` on mismatch. **JSON-in-POSIX-sh (adversarial review 2026-07-03):**
no jq dependency and no real parser — the manifest is OUR stable, server-
generated format (release.yml emits it), so a constrained `grep -o`/`sed`
extraction of `"rbox-<os>-<arch>"…"sha256":"<64 hex>"` is legitimate, with a
hard abort (refuse to install) if extraction yields anything but exactly one
64-hex string. Add a comment at the manifest-emitting site (release workflow /
`routes/release.ts`) declaring the field layout a compatibility contract the
installer greps — reshaping it is a breaking change. `sha256sum`/`shasum -a
256` chosen by probe, abort if neither exists. **Be honest about what this buys**: Ed25519
signature verification (`verifyAndParseManifest`, `upgrade-cmd.ts:48-69`) needs
the `RELEASE_KEYS`/verify logic that only exists inside the compiled binary —
a POSIX shell script can't do public-key crypto without shipping a second
trust root. So bootstrap trust is **TLS (the manifest and binary are both
fetched over HTTPS from `rbox.to`/`api.rbox.to`) + sha256 pinning from that
same TLS-fetched manifest** — it stops a corrupted/truncated download and a
compromised *download mirror* (if one ever existed) that doesn't also control
`api.rbox.to`'s TLS cert, but it is **not** independent of the channel the
installer script itself came over. Real defense against a fully compromised
`rbox.to` is the *next* `rbox upgrade`, which does have the Ed25519 check
against a key embedded in the binary at build time (out of the compromised
channel's reach). Say this plainly in the installer's own comment — don't
overclaim.

**`rbox uninstall`** (new command — no existing `uninstall-cmd.ts` in
`src/cli/` today, confirmed). Default (no flags): print the removal steps
without performing them (a dry-run-first stance matches `doctor`'s consent
pattern). With `--yes`: perform them.
1. Stop any running daemons — via design 61's `desired.json` enumeration (61 must
   ship first; its `rootPath` field is what makes "every workspace this machine
   tracks" enumerable at all — adversarial review 2026-07-03). For pre-61 runtime
   dirs that lack `desired.json`, fall back to reading each
   `~/.rbox/daemons/*/daemon.pid` and SIGTERMing that pid directly (best-effort;
   the pidfile is in the runtime dir even when the root path is unknowable).
2. Disable autostart if enabled (`rbox autostart disable`, design 61
   `daemon-autostart.md:187`).
3. Remove `~/.rbox` (credentials, e2ee keystore, daemon state, upgrade lock).
4. Print (never auto-edit) the PATH-line removal note: point at the
   `# >>> rbox PATH >>>` / `# <<< rbox PATH <<<` block the installer wrote
   (`install.sh:100-104`) and the shell rc file it targeted, so the user can
   delete it themselves — installer auto-edits an rc file, uninstall should
   not auto-edit it back (asymmetric risk: appending a clearly-marked block is
   safe, blind-deleting a block from a file the user may have since edited
   around is not).

### E. README rewrite

Confirmed current-state problems:
- `README.md:16` claims *"roadmap complete... All milestones (M1–M9)"* and
  `README.md:30` lists *"Pending human setup: Stripe keys..., rbox.to
  nameservers..., the IdP decision"* — stale: Stripe billing is live (design
  13 shipped, webhook-driven plan sync confirmed in `stripe.ts`), and per
  `AGENTS.md:7` the API now deploys via Cloudflare Workers Builds, not the
  M-numbered milestone framing.
- `README.md:9,27,55` all pitch `rbox deps install/list/check` as a feature,
  each caveated "temporarily disabled — design 51" — three separate places
  advertising a command that doesn't run (confirmed disabled in
  `index.ts:69-100`, the whole `runDeps` dispatch is commented out).
- `README.md:156` and `apps/api/tail/README.md:35` both reference
  `.github/workflows/deploy-api.yml` for how prod deploys happen — that
  workflow was **removed 2026-07-03** per `AGENTS.md:7`; prod now deploys via
  Cloudflare Workers Builds' git integration. Both refs are dead.
- `README.md:101`'s plan table lists Free retention as **"7 days"** — wrong on
  two counts: `plans.ts:18` sets `retentionDays: 0` (current-state only) and
  `docs/pricing.md:9` correctly says "No version history." This is a real
  pricing-copy bug, not just staleness — fix it as part of this pass
  regardless of the rest of the README rewrite's scope (see design 66 §0 for
  the retention-side confirmation).

**Fix:** rewrite `README.md` as a user-facing front door: curl one-liner
(`curl -fsSL https://rbox.to/install.sh | sh`, matching `install.sh:2`'s own
header comment — note the header says `.sh` while `recovery-kit.ts:75`'s
in-kit instructions say `curl -fsSL https://rbox.to/install | sh`, no `.sh` —
**pick one canonical URL and use it everywhere**, this is its own small
inconsistency worth fixing here), quickstart via `rbox setup` (the guided
wizard, not the M1-era `rbox init --new --bootstrap` scripted form as the
headline), features, a link to `docs/pricing.md` for plans. Move the
`Development`/`Benchmarking` sections (README.md:108-170) to a new
`docs/development.md` verbatim (no content loss, just relocated — this is
real, useful content for contributors, just not what a prospective user
should see first). Remove the M1–M9 roadmap-complete framing and "Pending
human setup" entirely (both stale); stop pitching `deps` in all three spots.

### F. `docs/usage.md`

- Add a recovery-kit section describing `--kit`/`--kit-path` accurately: reads
  from `src/cli/recovery-kit.ts` — `rbox login --bootstrap ... --kit [path]`
  and `rbox key backup --kit [path]` write a plaintext kit (banner + account id
  + device + the 24-word phrase + recovery instructions + the no-escrow
  warning) to `~/Downloads` when it exists, else `$HOME`, atomically
  (temp+rename) at mode 0600, named
  `rbox-recovery-kit-<8-hex-acct-suffix>-<YYYYMMDD>.txt`. `rbox key status`
  reports the last-written kit path/date, or that none is recorded, or that
  the recorded file is missing.
- Fix the stale removal note at `usage.md:~100`: *"slated for removal at v0.3"*
  for the `link`/`daemon` deprecated aliases — the project is at **v0.7.1**
  (confirmed via `src/cli/version.ts`, git tags `v0.6.0`..`v0.7.1`) and those
  aliases are still present. Either commit to an actual removal version/date
  or drop the "slated for removal" framing and just document them as
  deprecated-but-supported.
- Add `CHANGELOG.md` at repo root (doesn't exist today, confirmed): Keep a
  Changelog format, start the real per-entry log at v0.7.1 going forward, and
  backfill a condensed 0.6.0→0.7.1 highlights section from
  `git log --oneline v0.6.x..v0.7.1`-style tag ranges (one line per notable
  design/feature, not every commit). `release.yml` is unchanged — the
  changelog is repo-only for now, not surfaced by the release workflow or the
  installer.

### G. Explicitly out of scope

zsh is the only shell with completions/prompt integration
(`shell-init.ts`/`completions.ts`, design 46) — bash/fish support is future
work, not part of this pass. Don't add partial/stub support for either here.

## 3. Mechanism notes (non-obvious bits, collected)

- A2's short-flag table and A3's `--limit`/`--lines` alias both live in
  `parseFlags`/its call sites — do them together, one PR, since A3 depends on
  `logs` accepting `--limit` as an alias which touches the same code A2 touches.
- A5's unification means `style.fail` and the top-level `main().catch` in
  `index.ts:603-606` converge on one function — after this fix there should be
  exactly one place in the codebase that formats a top-level CLI error string.
- B's `--json` contract needs one shared serializer helper (strip ANSI,
  camelCase key enforcement at the type level) so seven commands don't each
  reinvent "how do I print JSON" slightly differently.
- C's state file and D's install verification both touch `~/.rbox` — no
  conflict, different files (`update-check.json` vs `release.json`), but worth
  noting both land in the same directory convention.

## 4. Test plan

- A1: `rbox ignore <pattern>` and `rbox ignore --path <dir> <pattern>` resolve
  the same root; same for `trash`. A positional path takes precedence if both given.
- A2: `-f`, `--follow`, `-n 50`, `--lines 50` all parse to the expected flag
  values; an un-mapped single-dash token (`-x`) still lands in `positional`
  (unchanged behavior).
- A4: every command's usage-error path exits 1; a captured table of "command →
  exit code" across all commands should have exactly one value (1) for errors,
  0 for success, 130 only from the SIGINT handler.
- A5: `NO_COLOR=1` and a piped stdout both suppress ANSI on the unified error
  path (regression: today's top-level catch bypasses `style`'s TTY detection
  entirely, so this is a real behavior change to verify, not just a formatting one).
- B: golden-file JSON snapshot per command's DTO; `error` shape asserted on at
  least one forced-failure case per command (e.g. `status --json` outside a
  workspace).
- C: mock the manifest fetch to return a newer version; assert the status line
  appears; assert it does NOT re-fetch within 24h of a prior check
  (state-file-driven); assert total network silence when the mocked fetch throws.
- D: corrupt a byte of a mocked downloaded artifact → installer aborts before
  `mv`, leaves no partial binary at the destination path, non-zero exit.
- E/F: link-check pass over `README.md`, `docs/usage.md`, and
  `apps/api/tail/README.md` for any reference to `deploy-api.yml` or `design
  51`/`RBOX_DIAGNOSTICS` in user-facing prose (grep-based CI check would also
  work as a permanent regression guard, not just a one-time fix).

## 5. Out of scope

- Live quota (402) error UX — design 62; this doc's error-translation
  helper (A8) passes 402 through, it doesn't own the message.
- bash/fish completions (§G).
- Any change to the actual retention/billing mechanism (design 66 is the
  billing-side doc; this one is CLI-surface only).
