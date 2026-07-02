# Design 51 — `rbox.yml` (synced project config) + optional `.rboxignore` at init

**Status:** draft (not scheduled).
**Depends on:** design 03b (`.rboxignore`, shipped), design 08 (hydration trust boundary, shipped), design 07c (init wizard / `resolveInitPlan`, shipped).

## 0. Why this doc exists

`rbox.yml` was named once, early, and never built. This doc is a scoped revival —
not a straight resurrection of the original idea, most of which is either already
solved elsewhere or was killed for good reason. It also folds in a related,
previously-undecided question: should `rbox init` offer to scaffold
`.rboxignore` at workspace root, instead of that file only appearing the first
time someone runs `rbox ignore <glob>`?

## 1. What happened to `rbox.yml` (history, so this doesn't re-litigate settled ground)

`docs/rbox-architecture-v2.md` (D11) proposed a single synced `rbox.yml` doing
two jobs: carrying an `ignore: string[]` list, and carrying `hydrate.commands`
("recipes") — arbitrary shell run on `rbox hydrate`.

Both jobs were explicitly declined when their milestones actually shipped:

- **Ignore rules** shipped as `.rboxignore` instead (design 03b, ✅ DONE) — a
  plain synced dotfile, not a YAML sub-key. `docs/roadmap.md` §3b still carries
  the `rbox.yml`-backed version as an unchecked "(original plan)" wishlist item
  directly under the `✅ DONE` `.rboxignore` line — that's drift in the roadmap
  doc, not a live proposal.
- **Hydration recipes** were rejected outright (design 08 §2): *"Recipe commands
  (`rbox.yml`) are untrusted and never auto-run. `rbox hydrate` runs only the
  inferred path by default."* `docs/learnings.md` (2026-06-26) records this as
  a deliberate call: *"Recipes (`rbox.yml` custom commands) deliberately NOT
  implemented — the safest default is 'only the inferred allowlist runs.'"*

Net effect: `rbox.yml` has zero references anywhere in `src/`. Nothing about
this doc reopens either of those two calls — ignore rules stay in
`.rboxignore`, and hydration stays inferred-only (no recipes, trusted or
otherwise). If recipe-style hydration is ever revisited, that's a separate
design doc with its own trust-boundary argument, not a rider on this one.

## 2. The actual gap: no synced, human-readable project config

Everything project-identifying today lives in `.rbox/workspace.json`
(`src/cli/config.ts`), which is explicitly **per-device and machine-local**
(the doc-comment on `WorkspaceConfig` says so directly) — it's never synced,
and for good reason: `rootPath`, `deviceId`, and the runtime-only `token`/`kek`
fields must not leave the machine.

One field doesn't fit that mold: `name`. It's a workspace's human label, meant
to be the *same* across every device — but it's currently propagated
inconsistently:

- On **create**, `--name`/the interactive prompt sets it server-side and caches
  it locally on that one device (`init-cmd.ts` `promptMissing`, `executeInitPlan`).
- On an **interactive join**, `promptWorkspacePick` fetches the name from the
  server and caches it locally too (`init-cmd.ts:47-53`).
- On a **headless/CI join** (`rbox init --workspace <id> --no-interactive`),
  neither path runs — the joining device has no name cached until someone
  passes `--name` by hand, and `rbox status` on that machine shows the bare
  opaque id instead.

That's a real, narrow gap: there's no synced source of truth for the one piece
of project identity that's supposed to be uniform everywhere, so the
CI/headless path silently degrades.

## 3. Decision: `rbox.yml` v1 — synced project *defaults*, non-secret, no arbitrary execution

Revive `rbox.yml` as the synced counterpart to `workspace.json`'s per-device
settings: anything that's a **project-wide default a team should agree on**,
which any one device can still override locally. It is:

- **Synced** — a normal tracked file, like `.rboxignore` (not in `BUILTIN_IGNORE`).
- **Human-editable** — plain YAML, meant to be hand-edited and code-reviewed.
- **Non-secret** — nothing that requires the workspace KEK to be meaningful.
  Never a home for tokens, keys, or per-device paths.
- **Declarative only** — every key is a value the client reads and branches
  on. Nothing in `rbox.yml` is ever passed to a shell. That property is what
  keeps this from reopening design 08 (see the `deps` section below).

```yaml
# rbox.yml — synced project config (design 51). Safe to hand-edit and commit.
schema: rbox.yml/v1

name: my-project

# Project-level defaults, applied at bind time (a new device's `init`/`track`).
# `--git` still overrides syncGit on that command; hand-editing workspace.json
# still overrides notifyOfDepsChange (see § precedence for why the two differ).
syncGit: false             # opt this project OUT of the hardcoded default (on, design 28) —
                           # e.g. a repo with a huge/noisy git history nobody wants auto-synced
notifyOfDepsChange: true   # post-sync drift nudge on (already the hardcoded default; shown
                           # explicit here for illustration) — see §5, `deps` CLI is disabled

# NOT implemented yet (design 08 still applies: no arbitrary shell, ever).
# Reserved shape for future *parameters to the existing inferred allowlist* —
# i.e. picking which already-trusted step runs, never a custom command string.
# deps:
#   manager: pnpm       # disambiguate when multiple lockfiles coexist
#   only: [node]         # limit which ecosystems/rules `deps install` considers
#   allowBuild: false    # project-level default for --allow-build
```

`schema` is a forward-compat marker (mirrors `WorkspaceConfig.schema`'s
`e2ee/v1` pattern) so a future version can add fields without breaking parsers
that only understand v1.

**In scope for v1:**

- `name` — see §2.
- `syncGit` — project-level default for git-state sync. **Correction from an
  earlier draft of this doc:** git-sync's actual hardcoded default is **on**,
  not off (design 28 — "git-sync defaults ON, git artifacts are E2EE-encrypted
  ... this is the git-native sync the product is built around"; `--git false`
  opts out). `syncGit` is also not genuinely *unset* per-device today the way
  `noDrift` is: `init-plan.ts`/`track-cmd.ts` both write
  `syncGit: flags.git !== "false"` unconditionally, so every bound device
  already has a concrete `true`/`false` in `workspace.json` — there's no gap
  left for a project default to fill *after the fact*. See the precedence
  section below for what this actually changes about the design.
- `notifyOfDepsChange` (the synced-config name for the inverse of `noDrift` — see
  naming note below) — same shape of argument: whether drift nudges matter is
  usually a property of the project's workflow, not each dev's taste. Unlike
  `syncGit`, `noDrift` genuinely is left unset by default today (nothing
  currently writes it — the `deps notify` command that would have is itself
  disabled, see §5), so the "fills the gap for devices with no local opinion"
  framing applies to this field without modification.

**Still explicitly out of scope for v1** (unchanged from the original call,
for the same reasons):

- **No `ignore:` key.** Ignore rules stay exclusively in `.rboxignore`
  (design 03b). Two files describing the same concern is worse than one.
- **No arbitrary `hydrate.commands`/recipe strings.** Hydration stays
  inferred-only (design 08) — nothing in `rbox.yml` is ever executed as a
  shell command. The commented-out `deps:` shape above is *configuration of
  which trusted step runs*, never a new command; if that distinction blurs
  during implementation, cut the `deps:` key rather than blur it.

### Naming note: `notifyOfDepsChange` vs `noDrift`

`workspace.json` calls the per-device field `noDrift` (true = suppress
nudges). The synced project field is named the other way, `notifyOfDepsChange` (true
= show nudges), because a project-authored default reads backwards as a
double negative ("no drift: true" in a file meant for humans to hand-edit is
confusing). The loader maps `notifyOfDepsChange: false` ⇔ the local `noDrift`
semantics; this is a presentation difference only, not two independent
booleans.

### Precedence — two different shapes, because the two fields behave differently today

**`notifyOfDepsChange` (maps to local `noDrift`): ongoing runtime fallback.**
`noDrift` is genuinely unset per-device unless something writes it, and
nothing does today. Resolution order, read fresh wherever `cfg.noDrift` is
consulted (currently just `postSyncNudge` in `index.ts`): **explicit
per-device value in `workspace.json`** (if ever set by hand or a future flag)
→ **`rbox.yml` project default** (if present) → **hardcoded fallback**
(today's behavior: nudges on). No new "layered runtime config" machinery is
needed for this one — it's a small, explicit precedence check at each read
site, same cost as today's single field read:

```ts
function shouldNotifyOfDepsChange(cfg: WorkspaceConfig, projectCfg: ProjectConfig | undefined): boolean {
  if (cfg.noDrift !== undefined) return !cfg.noDrift;                       // explicit per-device wins
  if (projectCfg?.notifyOfDepsChange !== undefined) return projectCfg.notifyOfDepsChange; // rbox.yml default
  return true;                                                              // hardcoded fallback: nudges on
}
```

**`syncGit`: resolved once, at bind time — not a runtime layer.** Because
`init`/`track` *always* write a concrete `syncGit: true|false` into
`workspace.json` (there is no "unset" state in practice, only "explicitly
chosen at bind time" vs "defaulted at bind time"), `rbox.yml`'s project
default can only matter *before* that write happens, not after:

- **On create** (new workspace): `--git` flag (if passed) → hardcoded default
  (**on**, design 28). There is no existing `rbox.yml` to consult yet — this
  path is unchanged from today.
- **On join**: `--git` flag (if passed) → the *joining workspace's* `rbox.yml`
  `syncGit`, fetched the same way `promptWorkspacePick` already fetches `name`
  for the interactive join picker (`init-cmd.ts:47-53`) — extend that same
  lookup to also carry `syncGit`/`notifyOfDepsChange` alongside `name`, rather
  than inventing a second fetch path → hardcoded default (on).
- Once resolved, it's written and behaves exactly as `syncGit` does today —
  a normal per-device override via `--git` on any later `rbox track` still
  wins, same as now. This doc does **not** propose making `workspace.json`
  distinguish "explicit" from "defaulted" after the fact (e.g. re-applying a
  `rbox.yml` change retroactively to already-bound devices) — that's a
  materially bigger change (needs provenance tracking in the schema) and isn't
  needed to fix the actual gap from §2 (a *new* device joining with no signal).

- `rbox.yml` is **optional** throughout, for both fields. Its absence is not
  an error at any existing milestone's behavior — everything works exactly as
  it does today with no `rbox.yml` present.
- Corrupt/unparseable `rbox.yml` is a **warning, not a hard failure** — every
  field falls back to its per-device value or hardcoded default. A YAML typo
  in a synced file should never be able to break `push`/`pull`/`sync`/`init`
  for every device that pulls it.

### Files touched (indicative — implementation is a separate task)

| File | Change |
|---|---|
| `src/cli/rbox-yml.ts` | **new** — `loadProjectConfig(root)` (local read, for `notifyOfDepsChange`) and a remote variant usable during join, before the workspace is fully bound (for `name`/`syncGit`) — tolerant of absence/corruption (warn, don't throw) either way |
| `src/cli/init-cmd.ts` | `promptWorkspacePick`'s join-time lookup extended to also carry `syncGit`/`notifyOfDepsChange`, not just `name`; on create with a name, write `rbox.yml` alongside `workspace.json` |
| `src/cli/index.ts` | `postSyncNudge`'s `cfg.noDrift` check gains the `rbox.yml` `notifyOfDepsChange` fallback described above |
| `src/cli/status-view.ts` (or equivalent) | no change — still reads the local cache; the cache just now has a better source for `name` |

## 4. Decision: optional `.rboxignore` scaffolding at `rbox init`

Today `.rboxignore` (design 03b) is created **lazily**, only by
`addIgnorePattern()` (`src/cli/ignore-cmd.ts`) the first time someone runs
`rbox ignore <glob>`. `rbox init` never touches it. That's a reasonable
default — most workspaces never need an entry beyond `BUILTIN_IGNORE` +
`.gitignore` — but it means a user who *knows* up front they'll want one has
no way to say so at setup time; they have to remember to run `rbox ignore`
later, or hand-create the file themselves (which works — `.rboxignore` is just
a normal ignore-syntax file — but isn't discoverable).

**Decision:** let the user choose at init time, on both flows:

- **Interactive:** add a `promptConfirm` step to `init-cmd.ts`'s
  `promptMissing`, mirroring the existing "Add a name for this workspace?"
  pattern (`init-cmd.ts:70-80`) — same block style, asked once, skippable.
  Default **off** (matches today's behavior when the user says no) — this is
  additive convenience, not a new default file every workspace gets.
- **Scripted/CI:** a tri-state `--ignore-file` / `--no-ignore-file` flag pair.
  Unset on a non-interactive run preserves the current behavior exactly (no
  file). This keeps `rbox init --no-interactive` byte-for-byte compatible for
  every existing CI invocation that doesn't pass the new flag.
- **On accept:** write a `.rboxignore` containing only a comment header (no
  default patterns) explaining precedence, so the file is self-documenting
  the first time someone opens it:

  ```
  # .rboxignore — synced, shared across every machine on this workspace.
  # Precedence: builtin defaults -> .gitignore -> .rboxignore (this file wins).
  # One gitignore-style glob per line. `rbox ignore <glob>` appends here too.
  ```

- **Rebind safety:** if the root is already bound (the `prev`/`nextStream`
  rebind path in `executeInitPlan`, `init-cmd.ts:156-164`), never overwrite an
  existing `.rboxignore` — the prompt/flag only creates the file when it's
  genuinely absent, same as `addIgnorePattern`'s own "create if absent" rule.

### Files touched (indicative)

| File | Change |
|---|---|
| `src/cli/init-cmd.ts` | `promptMissing`: new confirm step; `executeInitPlan`: write the scaffold file when accepted and absent |
| `src/cli/init-plan.ts` | `InitPlan` gains `createIgnoreFile: boolean`, resolved from the flag/prompt like every other init input |
| `src/cli/ignore-cmd.ts` | export the header-scaffold writer so `init-cmd.ts` and `ignore-cmd.ts` share one "create `.rboxignore`" code path instead of two |
| `src/cli/index.ts` | wire `--ignore-file` / `--no-ignore-file` |
| `src/cli/help-registry.ts` | document the new flags under `init` |

## 5. Already done: the `deps` CLI group is commented out

Unlike everything else in this doc, this part is **executed, not proposed** —
done directly on this branch rather than left as a future task, since it's
purely subtractive (disable a dispatcher path) and easily reversible.

**Decision:** the entire `rbox deps <install|list|check|drift|notify>` command
group, plus its deprecated aliases `hydrate`/`detect`/`doctor`, is commented
out of the live CLI. Reasons: the command surface was judged premature/unused
right now, and `deps notify`'s job (toggle the post-sync drift nudge) is
better served by the declarative `notifyOfDepsChange` field above than by an
imperative shell-hook-install command.

**What changed** (all comment-outs, no deletions — the underlying logic in
`hydrate-cmd.ts` / `deps-drift.ts` / `deps-notify.ts` is untouched):

| File | Change |
|---|---|
| `src/cli/index.ts` | `runDeps()` and `case "deps":` commented out; falls through to `default:` (unknown command, exit 1) |
| `src/cli/help-registry.ts` | the 5 `deps *` entries and the 3 alias entries (`hydrate`, `detect`, `doctor`) commented out |
| `src/cli/deprecations.ts` | `hydrate`/`detect`/`doctor` removed from `SIMPLE_ALIASES` (their forward target no longer exists) |
| `src/cli/setup-cmd.ts` | the "Be notified when dependencies change?" prompt + `installNotify()` call commented out — its shell hook runs `rbox deps drift --quiet`, now unknown |
| `scripts/install.sh` | the `--with-dep-notify`/`RBOX_DEP_NOTIFY` install-time block commented out — it ran `rbox deps notify install`, now unknown |
| `src/cli/{help-registry,deprecations,completions}.test.ts` | assertions updated to match (deps group returns no help entries, grouped screen omits `DEPENDENCIES`, the one completions test with no remaining live example is commented out) |
| `src/cli/{deps-notify,deps-drift}.test.ts` | header notes added — these still test the (now uncalled, except `deps-drift`'s post-sync-nudge half) implementation directly, intentionally |
| `README.md`, `docs/usage.md` | Quickstart/CLI-table/prose updated to stop advertising working `deps`/`hydrate`/`doctor`/`daemon start` commands |

`command-catalog.ts` needed no edit — `KNOWN_TOP_LEVEL`/`PUBLIC_COMMANDS`/
`ALIAS_COMMANDS` are all derived from `COMMAND_HELP`, so removing the entries
there was sufficient for the dispatcher's own consistency check
(`help-registry.test.ts`'s registry↔dispatcher parity test) to stay green.

**What's unaffected:** the automatic post-sync drift nudge (`postSyncNudge` in
`index.ts`, gated on `cfg.noDrift`) is a *sync* behavior, not a `deps` command
— it still runs today exactly as before. It's the eventual home of
`notifyOfDepsChange` once `rbox.yml` is real (§3).

**Caught in review, fixed here:** an adversarial pass (codex) found the first
cut of this change missed two real callers of the disabled surface —
`rbox setup`'s notify prompt and `install.sh`'s `--with-dep-notify` both still
invoked `deps notify`/`deps drift` commands that no longer exist, which would
have silently installed a shell hook that always fails. Both are now
commented out too (rows above). The same pass also caught that this doc's
first draft asserted `syncGit` defaults off — it's actually on (design 28) —
see the correction in §3.

**To re-enable:** uncomment all locations above in order (`index.ts` →
`help-registry.ts` → `deprecations.ts` → `setup-cmd.ts` → `install.sh` → the
test files), then `bun run test` — the parity tests will immediately flag
anything left inconsistent.

## 6. Verification plan (once implemented)

- Unit: `resolveInitPlan` carries `createIgnoreFile` correctly from
  `--ignore-file`/`--no-ignore-file`/interactive-confirm-answer; a corrupt
  `rbox.yml` degrades to per-device/hardcoded values with a warning, not a
  throw; a present `rbox.yml` name wins over a stale local cache after pull;
  `notifyOfDepsChange` runtime fallback — explicit local `noDrift` beats the
  `rbox.yml` default beats the hardcoded fallback, tested for all three levels
  independently (a project default must not clobber a device that already
  opted in *or* out explicitly); `syncGit`'s bind-time resolution — `--git`
  beats the joined workspace's `rbox.yml` beats the hardcoded (on) default,
  tested only at `init`/`track` time (not as an ongoing check).
- Integration: `rbox init --ignore-file` on a fresh root creates `.rboxignore`
  with the header only; re-running init against an already-bound root with an
  existing `.rboxignore` leaves it untouched; a headless join
  (`--no-interactive --workspace <id>`) against a workspace that has a synced
  `rbox.yml` shows the real name in `rbox status` after first sync, with no
  `--name` flag passed; a fresh device joining a project whose `rbox.yml` sets
  `syncGit: false` binds with git-state sync off without passing `--git
  false`; a fresh device joining the SAME project but passing `--git true`
  explicitly gets sync on regardless of the project default (flag always
  wins); an already-bound device is completely unaffected by a `rbox.yml`
  appearing or changing later — `syncGit` is bind-time-only, not re-resolved
  on pull.

## 7. Open questions

- Does `deps:` (commented-out in §3's example) ever graduate to real,
  implemented config, and if so does it stay a pure parameter set (manager
  choice, ecosystem filter, `allowBuild` default) or does someone eventually
  push for actual custom command strings again? This doc's position: parameters
  to the existing inferred allowlist are fine; custom commands are not, full
  stop, without a dedicated trust-boundary redesign superseding design 08. Left
  commented rather than specified because there's no concrete gap driving it
  yet (unlike `name` and `syncGit`, which fix an observed problem) — write the
  real spec once one shows up.
- Is a comment-only scaffold the right default for `.rboxignore`, or should it
  seed one or two common project-specific patterns (e.g. detected from an
  existing `.gitignore` that already has `node_modules/` etc., which would be
  redundant with `BUILTIN_IGNORE` and shouldn't be duplicated)? Leaning
  comment-only to avoid ever writing a pattern the user didn't ask for.
- Should `rbox init` offer to write `rbox.yml` itself (mirroring the new
  `.rboxignore` prompt in §4), or does it only ever get created by hand /
  by a future `rbox config` command? Leaning towards folding it into the same
  init prompt flow once `name`/`syncGit`/`notifyOfDepsChange` are real, so a project's
  first device seeds sensible defaults for everyone who joins after — but
  that's an implementation-time call, not blocking this doc.
