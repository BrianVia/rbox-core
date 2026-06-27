# Design 08 — Hydration Brain (Milestone 8)

**Status:** v3 — IMPLEMENTED & live-verified. Resolved TWO codex passes: v1 (6
must-fix, structural) and v2 (3 residual P1 security holes). Resolutions below.

### v2 re-review P1s (security) — resolved
- **Yarn/Corepack `yarnPath`/plugins:** `.yarnrc.yml`/`.yarnrc` can point yarn at
  a repo-shipped binary or load repo-local plugins (repo code at startup) — no
  flag fully prevents it. Resolution: the rule declares `untrustedConfigFiles`;
  the executor **refuses to auto-run yarn when one is present** unless
  `--allow-build`, and sets `YARN_IGNORE_PATH=1` when it does run (defense in
  depth). Verified: a yarn project with `.yarnrc.yml` is skipped.
- **Cwd containment at spawn:** the executor now `realpath`s the project dir and
  asserts it's inside the workspace **immediately before spawn** (rejects a
  symlinked dir that escapes), not just lexical `path.join`.
- **pnpm `.pnpmfile.cjs`:** repo code that runs even with `--ignore-scripts`.
  Resolution: pnpm's default args now include **`--ignore-pnpmfile`**. Verified
  in the run argv.

---

**v1 resolutions (structural):**

### Resolutions to codex must-fix (v1 → v2)
1. **Trusted argv, untrusted project inputs.** The rule table is a fixed in-binary
   allowlist; we run a known argv, never synced content. Lifecycle/build scripts
   are **off by default** (`hydrateArgv` adds `--ignore-scripts` where supported).
2. **Per-ecosystem script/build policy.** Each rule carries `ignoreScriptsArgs`
   (npm/pnpm/yarn) and `fetchRunsCode` (pip/poetry/bundler compile sdists/native
   ext → cannot be disabled). `fetchRunsCode` rules are **blocked without
   `--allow-build`**. bun (trustedDependencies by default), `cargo fetch`, `go mod
   download` run no repo code → auto-runnable.
3. **Ambiguous node lockfiles hard-fail.** Multiple lockfiles in one dir →
   `ambiguous`, resolved only by `package.json#packageManager` or `--manager`;
   otherwise the executor refuses (never silently precedence-picks).
4. **Prefetch vs reconstruction split.** cargo/go have `installDir: null` (global
   cache prefetch, not `target/` reconstruction); `cargo fetch --locked`. Bare
   `pip`/`requirements.txt` is intentionally NOT in the hydrate allowlist
   (not a guaranteed lockfile) — detect-only.
5. **Hardened tool/cwd resolution.** Tools resolved from PATH with **realpath
   containment** — a repo-shipped `./pnpm` or a PATH entry inside the workspace is
   rejected (verified: a planted malicious `./npm` did NOT run). Version probes
   run from a **neutral cwd** (`os.tmpdir`), never the project, so project-local
   version-manager shims can't influence them. `execFile`/`spawn`, never a shell.
6. **Doctor is advisory.** Hard-fail missing tools / incompatible majors; **warn**
   (never fail) on ranges we can't cheaply decide (`minMajor` returns null →
   warn). No project-local code execution.
Inline: generated manager artifacts (`.pnpm-store/`, `vendor/bundle/`) added to
`BUILTIN_IGNORE` so hydrate output isn't re-uploaded (Yarn PnP `.yarn/` left
alone — projects commit it intentionally). **Recipes (`rbox.yml`) are NOT
implemented** — the safest default; only the inferred allowlist runs.

---


**Implements:** roadmap M8. The dev-aware wedge: rbox doesn't sync
`node_modules`/`target`/`.venv` (huge, regenerable, already builtin-ignored).
It syncs the **lockfile + a recipe**, and *hydrates* the dependency tree on the
new machine by running the project's package manager. This is also the
performance story — never ship gigabytes of regenerable deps over the wire.

## 0. The wedge, stated plainly

Dropbox syncs `node_modules` byte-for-byte (slow, conflict-prone, OS-specific
binaries break). rbox syncs the *inputs* (lockfile, manifest) and reconstructs
the *outputs* deterministically. Three commands:
- `rbox detect` — what ecosystems/package-managers does this tree use?
- `rbox hydrate` — reconstruct deps from the synced lockfiles (the inferred,
  trusted path) + optionally run project-defined recipes (UNTRUSTED).
- `rbox doctor` — is THIS host ready to hydrate/run this project? (tool presence
  + version compatibility, host-vs-project readiness.)

## 1. Detection (`rbox detect`) — pure, lockfile-driven

A pure `detectProjects(fileList) → DetectedProject[]` over the synced manifest's
paths (no disk reads needed for detection itself). Each ecosystem is a
`{ lockfiles, manifestFile, packageManager, hydrateArgv, installDir }` rule:

| Ecosystem | Lockfile (priority) | Manifest | Hydrate (exact argv) | Install dir |
|---|---|---|---|---|
| node/pnpm | `pnpm-lock.yaml` | package.json | `pnpm install --frozen-lockfile` | node_modules |
| node/yarn | `yarn.lock` | package.json | `yarn install --immutable` | node_modules |
| node/npm | `package-lock.json` | package.json | `npm ci` | node_modules |
| node/bun | `bun.lock`/`bun.lockb` | package.json | `bun install --frozen-lockfile` | node_modules |
| rust | `Cargo.lock` | Cargo.toml | `cargo fetch` | target |
| go | `go.sum` | go.mod | `go mod download` | (module cache) |
| python/uv | `uv.lock` | pyproject.toml | `uv sync --frozen` | .venv |
| python/poetry | `poetry.lock` | pyproject.toml | `poetry install` | .venv |
| python/pip | `requirements.txt` | — | `pip install -r requirements.txt` | .venv |
| ruby | `Gemfile.lock` | Gemfile | `bundle install` | vendor/bundle |

- **Lockfile presence is the trigger** (a `package.json` with no lockfile → not
  auto-hydratable; report as "no lockfile, can't reproduce deterministically").
- **Monorepo:** detect per-directory; a tree can have many DetectedProjects
  (e.g. `apps/web/pnpm-lock.yaml` + `services/api/go.sum`). Each hydrates in its
  own dir. The detector returns one entry per lockfile location.
- node manager precedence when multiple lockfiles exist: pnpm > yarn > bun > npm
  (and warn about the ambiguity — multiple lockfiles is a project smell).

## 2. Hydration (`rbox hydrate`) — TRUSTED inferred path + UNTRUSTED recipes

**Security rule 7: synced project commands are UNTRUSTED.** A synced
`rbox.yml`/recipe could contain `rm -rf ~` or `curl … | sh`. The boundary:

1. **Inferred commands are trusted** because they come from a *fixed in-binary
   allowlist* keyed by detected lockfile — NOT from synced content. We run a
   known `hydrateArgv` (e.g. `npm ci`), never a string from the repo.
2. **Recipe commands (`rbox.yml`) are untrusted** and **never auto-run.**
   `rbox hydrate` runs only the inferred path by default. Custom recipe steps
   are printed and require explicit opt-in: interactive `y/N` per step showing
   the exact argv, or `--allow-recipe` (headless). Default = inferred only.
3. **No shell.** Execute via `execFile`/spawn with a fixed argv array — never
   `exec(string)`, never shell interpolation of any synced value. The only
   variable input is the install *directory* (a resolved path under the
   workspace root, validated to stay within it — no `..` escape).
4. **Tool from PATH, pinned name.** We invoke `npm`/`pnpm`/`cargo` by bare name
   resolved from the host PATH; we never run a binary shipped inside the synced
   tree (a repo could carry a malicious `./pnpm`). Reject if the resolved tool
   lives inside the workspace root.

Flow: `detect` → for each project, doctor-check its tool → run `hydrateArgv` in
the project dir (streamed output + spinner) → report per-project success/fail.
`--only <ecosystem>` / `--dir <path>` to scope. Continue-on-error with a summary
(one failed project doesn't abort the rest).

## 3. Doctor (`rbox doctor`) — host vs project readiness

`rbox doctor` answers "can this machine build/run this project?":
- For each DetectedProject: is the package manager on PATH? (`which`/PATH scan).
- Version compatibility where cheaply checkable: node engines (`package.json`
  `engines.node`) vs installed `node --version`; `go.mod` `go 1.xx` vs `go
  version`; `Cargo.toml` `rust-version` vs `rustc --version`; python
  `requires-python`. Report satisfied / missing / version-mismatch.
- Output: a per-project readiness table (`✓`/`✗`/`!`) + actionable fixes
  ("install pnpm: `npm i -g pnpm`"). Exit non-zero if any hard gap.
- Pure core: `evaluateReadiness(projects, hostTools) → ReadinessReport`, with
  host-probing (PATH/versions) as the thin impure shell. Unit-test the matrix.

## 4. Why this is the performance story (daemon tie-in)

`node_modules`/`target`/`.venv` are already in `BUILTIN_IGNORE` (design 01/03b),
so the watcher never floods on `npm ci` and we never upload them. Hydration is
what makes that ignore safe: the deps are *reproducible*, not *lost*. A new
machine syncs a few KB of lockfile, then `rbox hydrate` rebuilds locally at
native speed. (A future `rbox init` could offer to hydrate as a final step — out
of scope here; init stays lean.)

## 5. Plan gating (M7b tie-in)

`plans.ts` already has an `advancedHydration` feature flag (pro+). M8 ships
**basic hydrate/detect/doctor on all plans** (it's core value, not a paywall).
`advancedHydration` is reserved for later (parallel multi-project hydration,
remote build cache, recipe trust policies) — flagged, not built here.

## 6. Files

| File | Change |
|---|---|
| `src/engine/detect.ts` | **new** — pure `detectProjects(fileList)` + ecosystem rule table |
| `src/engine/doctor.ts` | **new** — pure `evaluateReadiness(projects, hostTools)` |
| `src/cli/hydrate-cmd.ts` | **new** — `detect`/`hydrate`/`doctor` shells (execFile, no shell) |
| `src/cli/index.ts` | wire `detect`/`hydrate`/`doctor` commands + help |
| `src/engine/detect.test.ts` | **new** — detection + readiness matrices (pure) |
| `docs/roadmap.md` | M8 checkboxes |

## 7. Verification

- **Unit (pure):** `detectProjects` over crafted file lists — single ecosystem,
  monorepo (multiple lockfiles in different dirs), multiple node lockfiles
  (precedence + ambiguity warning), package.json-without-lockfile (not
  hydratable). `evaluateReadiness` — tool present/absent, version satisfied/
  mismatch.
- **Live (prod host):** sync a real Node + (Go or Rust) tree (lockfiles only,
  deps ignored) to the host; on the host `rbox detect` lists both;
  `rbox doctor` reports tool readiness; `rbox hydrate` runs `npm ci`/`go mod
  download` and reconstructs `node_modules`/cache; confirm the watcher did NOT
  upload the reconstructed deps (still ignored).
- **Security:** a synced `rbox.yml` with a hostile step does NOT run under plain
  `rbox hydrate` (only inferred runs); `--allow-recipe` prompts/echoes the exact
  argv. A repo-local `./pnpm` is rejected (tool must resolve outside the
  workspace). No `exec(string)` anywhere (grep).
- `bun test` + both `tsc` green; antislop clean.

## 8. Open questions for codex review

1. **Trust boundary:** is "inferred-from-fixed-allowlist = trusted, recipe =
   untrusted-never-auto" the right line? Is running `npm ci` itself safe given a
   malicious `package.json` can run arbitrary install scripts (lifecycle hooks)?
   Should hydrate default to `--ignore-scripts` / `npm ci --ignore-scripts` and
   require opt-in for lifecycle scripts? (This may be the real footgun — the
   "trusted" path still executes repo-controlled code via postinstall.)
2. Monorepo hydration order / workspace-aware managers (pnpm workspaces install
   from the root, not per-package) — does per-lockfile-dir hydration double-run
   or miss workspace roots?
3. `go mod download` / cargo populate a *global* cache, not a workspace dir —
   does "reconstruct in the project dir" model break for them, and is that fine?
4. Version compatibility: how far to go? (engines/go-directive/rust-version are
   cheap; full semver range satisfaction is a rabbit hole.)
5. Should `detect`/`doctor` read the live disk or the synced manifest? (Manifest
   = what WILL sync; disk = ground truth on this host. Probably disk for
   detect/doctor, manifest-awareness only for the "deps are ignored" reassurance.)
