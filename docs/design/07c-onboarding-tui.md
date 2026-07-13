# Design 07c — Onboarding TUI / Terminal UX (Milestone 7c)

**Status:** v3 — IMPLEMENTED. Two codex passes resolved (v1 design flaws; v2
doc/impl-sync). Core call confirmed by review: **defer OpenTUI**, ship zero-dep
`style.ts` + a readline `rbox init` built on a **pure planner/executor**. The
v2 re-review's remaining items were doc-wording lag, not design flaws — the
implementation (`init-plan.ts`'s `ResolvedDeviceId` union, the shell loading
creds and passing a `CredsView` into the pure planner) already embodied the
correct contract; §1/§2/§6 below are now synced to the code.

**Implements:** roadmap M7c. First-time setup is the highest-leverage UX moment.

## 0. Scope call (confirmed by review)

Defer OpenTUI; build onboarding on zero new runtime deps. Codex agreed the
5-step linear wizard doesn't justify a terminal runtime, and sharpened the real
reason: **OpenTUI waits until there's genuine non-linear UI value** (multi-
workspace selection, conflict preview, a live transfer table, resumable first-
sync inspection). The deliverable that makes OpenTUI "slot in later" is NOT the
readline layer — it's a **pure, tested `resolveInitPlan()` core** that any UI
(flags, readline, or OpenTUI) drives. That core is the milestone; the prompts
are a thin shell over it.

## 1. Architecture — pure planner + executor (review finding #8)

```
// init-plan.ts — PURE. No I/O, no prompts, no network, no loadCredentials().
// The IMPURE shell loads creds (env or file) and PASSES a CredsView in.
resolveInitPlan(input: InitInput): InitPlan | InitError
  InitInput  = { flags, cwd, creds: CredsView | undefined,
                 interactive: boolean, defaultRemote }   // interactive = stdin.isTTY && !--no-interactive
  CredsView  = { deviceId, remoteUrl }                    // never the token (executor uses that)
  InitPlan   = { auth: "have"|"need-interactive-login";
                 workspace: {kind:"new", project} | {kind:"join", id, project};
                 root; remoteUrl; firstSync: "push"|"sync"|"none";
                 deviceId: {kind:"fixed", id} | {kind:"from-credentials"} }
  InitError  = { code, message, headlessHint }            // exit 2 with a precise fix

// init-cmd.ts — IMPURE shell. loadCredentials() + prompt (readline→stderr) ONLY
// to fill missing fields, then resolveInitPlan(), then executeInitPlan().
// Non-TTY/--no-interactive never prompts; a missing-required → InitError.
executeInitPlan(plan): login? → createRemoteWorkspace|adopt-join-id →
  write config → secrets-stay-ignored notice → first push|sync (spinner)
```

The shell collects answers into the same `InitInput` a flag-only invocation
produces, so **interactive and headless converge on one code path**, and the
pure planner stays I/O-free. Unit tests target `resolveInitPlan` across the
TTY/flag/creds matrix with zero process I/O — the tight feedback loop.
`executeInitPlan` reuses existing primitives (`login`, `createRemoteWorkspace`,
config write, `push`/`sync`).

## 2. Non-negotiable: scriptability / Host-B (review #2, #7)

- **Headless auth contract (explicit).** The shell calls `loadCredentials()`
  (which already honors `RBOX_TOKEN`(+`RBOX_DEVICE_ID`, `RBOX_API`)) and passes
  the resulting `CredsView` into the pure planner; `resolveInitPlan` itself does
  no I/O. Resolution:
  - creds present (env or `~/.rbox/credentials.json`) → `auth:"have"`.
  - no creds + **`--bootstrap <secret>`** → `auth:"bootstrap-login"` (one-shot
    headless login — the explicit CI/first-device path; works TTY or not).
  - no creds + **TTY + interactive** → `auth:"need-interactive-login"` (the
    shell runs the device-code flow).
  - no creds + **non-TTY or `--no-interactive`** (and no `--bootstrap`) →
    `InitError` with the exact fix (`set RBOX_TOKEN=…`, `--bootstrap <secret>`,
    or `rbox login` first). **Device-code login never starts implicitly in CI.**
- Non-TTY/`--no-interactive` with any required field missing → `InitError`, exit
  2, never a prompt, never a hang. `isTTY` is `process.stdin.isTTY` (can we read
  answers?). Prompts are written to **stderr**, so `rbox init > out.txt` doesn't
  pollute stdout.
- Color auto-disables off-TTY / under `NO_COLOR` (see §4).

## 3. First-sync semantics — new vs join (review #3)

`firstSync` is derived, not blunt:
- **new workspace** (`--new`, default) → `push` (publish the local tree we just
  created the workspace for).
- **join existing** (`--workspace <id>`) → `sync` (pull remote first, reconcile,
  surface conflicts via the normal `summarize()` conflict path, THEN push). Never
  blind-upload an arbitrary local tree onto someone else's workspace.
- `--no-sync` → `none`.

## 4. style.ts / spinner.ts — contracts tightened (review #5, #6)

`style.ts` (implemented): the TTY/NO_COLOR decision lives once. Precedence:
1. `NO_COLOR` present & non-empty → **off** (wins over everything; safety).
2. `FORCE_COLOR` present & not `"0"` → **on** (the documented, explicit user
   override — the *only* way ANSI appears when piped; `FORCE_COLOR=0` → off).
3. else → `stream.isTTY === true`.
Separate `style` (stdout) and `stderrStyle` (stderr) instances, each gated on
their own stream. So "no ANSI in redirected logs" holds *except* the explicit
`FORCE_COLOR` exception, which is standard and documented.

`spinner.ts` (implemented, plus one fix): writes to **stderr**; non-TTY/`NO_COLOR`
degrades to a single plain line; interval is `unref()`'d. **Fix from review #6:**
`stop()` must clear the current line (`\r\x1b[K`), not just `clearInterval` —
otherwise `pull`/`sync` (which call `stop()` then print a summary) leave a stale
half-drawn frame. (`succeed`/`fail` already clear the line.)

## 5. Secrets toggle — REMOVED from M7c (review #1, #4) ⚠️

The v1 "sync secrets (E2EE-only)" step was **unsafe and is cut**:
- **Metadata leak:** Design 05 keeps the manifest *plaintext* (paths, sizes,
  plaintext shas). "Never synced in cleartext" was false for `.env` — the
  filename and size still leak. Real secret-safe sync needs full *manifest*
  E2EE, which doesn't exist yet.
- **Mechanically handwaved:** secrets are already in `BUILTIN_IGNORE`
  (`.env`, `*.pem`, `*.key`, `id_*`, …). `addIgnorePattern` only *appends*
  ignores; there is no safe allowlist, and a broad `!.env`/`!*.pem` negation is
  dangerous (re-includes every machine's real secrets).

**M7c resolution:** the wizard's secrets step is **informational only** — it
confirms secrets stay ignored (the safe builtin default, the sole behavior) and
notes that opt-in *encrypted* secrets sync ships with the full-E2EE milestone.
No `--sync-secrets` flag, no allowlist, no negation. (Roadmap: opt-in encrypted
secrets sync is moved under the full-E2EE milestone, not M7c.)

## 6. Device identity (review #9)

`link` historically minted a throwaway `dev_<rand>` workspace `deviceId`
unrelated to the auth device id in `credentials.json`. The wizard **unifies
them**: `resolveInitPlan` sets `deviceId = creds.deviceId` (the server-issued
identity from `rbox login`), falling back to a generated id only when creds carry
the `"env"` placeholder (`RBOX_TOKEN` with no `RBOX_DEVICE_ID`). One device, one
id, across auth and sync.

## 7. `rbox init` flow (the shell over the plan)

| Step | Source | Flag/env override | Non-TTY behavior |
|---|---|---|---|
| Auth | `loadCredentials()` | `RBOX_TOKEN` / prior `rbox login` | error if absent (no implicit login) |
| Workspace | prompt new/join | `--new` / `--workspace <id>` | error if absent |
| Project | prompt | `--project <id>` (default `root`) | default `root` |
| Root | prompt | `--root <path>` (default `cwd`) | default `cwd` |
| Secrets | **info only** (stay ignored) | — | (printed once) |
| First sync | derived (§3) | `--no-sync` | runs (push/sync) unless `--no-sync` |

Prompts → stderr. A supplied flag skips its prompt. All answers feed one
`InitInput`.

## 8. chalk-style polish on existing output (implemented)

Applied via `style`/`spinner`: `status` (bold header, green/yellow/cyan,
conflicts red), sync conflict warnings (`sym.warn` + yellow), `push`/`pull`/
`sync` spinners → summary, `summarize()` conflict coloring, a `fail()` error
helper (stderr, red, non-zero exit). `versions`/`devices`/`auth-cmd` output gets
the same treatment in this milestone.

## 9. Files

| File | Change |
|---|---|
| `src/cli/style.ts` | done — zero-dep ANSI, single gate, stdout+stderr instances |
| `src/cli/spinner.ts` | done + `stop()` clear-line fix (review #6) |
| `src/cli/init-plan.ts` | **new** — pure `resolveInitPlan` (+ `InitInput/Plan/Error` types) |
| `src/cli/init-cmd.ts` | **new** — readline shell (stderr prompts) + `executeInitPlan` |
| `src/cli/index.ts` | `init` command + `--no-interactive`; styled output (done for status/push/pull/sync) |
| `src/cli/auth-cmd.ts`, `versions-cmd.ts` | styled output |
| `test/init-plan.test.ts` | **new** — unit-test the plan matrix (TTY×flags×env×creds) |
| `docs/roadmap.md` | M7c checkboxes; move encrypted-secrets-sync under full-E2EE |

## 10. Verification — ✅ DONE

Live-verified against the dev worker: headless `init --new --bootstrap` (fresh
account → workspace → push seq 1, **deviceId unified** to the credential id);
headless `init --workspace <id>` **pull-first sync** (1 pulled, not a blind
push); `.env` excluded from the synced manifest (builtin-ignore); non-TTY + no
creds + no bootstrap → **exit 2** with a precise hint (no hang); color
discipline (piped → 0 ANSI, `FORCE_COLOR=1` piped → ANSI present); interactive
prompt renders on a pty. 12 `resolveInitPlan` unit tests green; `bun test` 34/34;
both `tsc` projects clean; antislop clean. Original plan:

- **Unit (tight loop):** `resolveInitPlan` matrix — new-vs-join, missing field
  +TTY (→ prompt marker) vs +non-TTY (→ `InitError` with hint), creds present/
  absent/env-placeholder (→ device id unification), `firstSync` push-vs-sync.
- **Headless e2e (prod host):** `RBOX_TOKEN=… rbox init --new --root . --no-interactive`
  → zero prompts, workspace created, config written, secrets ignored, push done.
  Same minus a required flag → exit 2 + precise hint, no hang. Join an existing
  ws headlessly → it `sync`s (pull-first), doesn't blind-upload.
- **Interactive (PTY):** `rbox init` answered via `script`/`unbuffer` → same end
  state; prompts appear on stderr (`rbox init >/dev/null` still shows prompts).
- **Color/spinner discipline:** `rbox status | cat` and `NO_COLOR=1 rbox status`
  → zero `\x1b[`; `FORCE_COLOR=1 … | cat` → has color; `FORCE_COLOR=0` → none.
  `rbox sync` leaves no stale spinner frame before the summary (stop() clears).
- `bun test` + both `tsc` projects green; antislop clean.

## 11. Resolutions to codex must-fix (v1 → v2)

1. `--sync-secrets` **removed** from M7c; deferred to full-E2EE (metadata leak +
   no safe allowlist). §5.
2. Headless auth contract specified: env token / existing creds / explicit
   bootstrap only; **no implicit device-code wait** in non-TTY. §2.
3. First-sync split: new→push, join→sync (pull-first, surface conflicts). §3.
4. Secrets ignore handwave removed (toggle cut; builtin-ignore is the model). §5.
5. Color/spinner tightened: stream-specific styles, `FORCE_COLOR=0`/`NO_COLOR`
   precedence, `unref`, clear-line `stop()`, stderr prompts (no stdout pollution).
   §4, §2.
Plus #8 pure planner/executor (§1) and #9 device-id unification (§6).

## Code-comment provenance (113 wave 4)

Review citations relocated from code comments by design 113 wave 4 (comment
sweep). The invariant prose remains at each cited site; the review round that
produced it is recorded here.

- `src/cli/init-plan.test.ts` (device-id unification): was "review #9" — rewritten as a neutral section heading.
