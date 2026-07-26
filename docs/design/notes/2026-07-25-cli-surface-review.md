# rbox CLI surface review — inventory for annotation

Date: 2026-07-25
Commit: `77329d9d` (`main`)
Trigger: Max Howell (Homebrew creator) CLI feedback, 2026-07-23
Method: five parallel agents documenting each command against its
**implementation**, not its help entry; no product code changed

Status: **INVENTORY FOR FOUNDER ANNOTATION.** This document deliberately
contains no redesign proposal. It records what the CLI does today, where help
and behavior disagree, and where Max's assumptions match or miss the code.

## How to annotate

Each command section carries an `ANNOTATE:` line. Mark it up freely — suggested
shorthand:

- `KEEP` — name and shape are right, leave it
- `RENAME → x` — behavior is right, name is wrong
- `RESHAPE` — args/flags/scope are wrong
- `MERGE → x` / `SPLIT` — collides with, or is doing the job of, another command
- `HIDE` / `DROP` — plumbing or dead
- `HELP-ONLY` — behavior is fine, help is the whole problem

Findings are labelled so they can be cited later: `L<lane>-<n>`.

---

## Executive summary

Max's headline — "I assumed start and stop referred to the ENTIRE DAEMON" — is
correct as a criticism, but **both his diagnosis and yours were wrong about the
code**, in opposite directions. That is the single most important result here.

1. **There is no whole-daemon object to refer to.** rbox runs **one daemon per
   workspace**, at `~/.rbox/daemons/<workspaceKey(root)>` (`rbox-paths.ts:43`).
   `rbox stop` with no argument stops only the **cwd's** workspace daemon
   (`main-dispatch.ts:427-429` → `resolveRoot(undefined)` → `findRoot(cwd)`),
   and outside a workspace it stops nothing and errors. **No command stops all
   daemons.** So Max's assumption describes an object that does not exist, and
   the reply in the thread — that no-arg *should* stop the whole daemon, "that's
   how I treat them" — does not describe today's behavior either.

2. **The help defect is real but is not the one identified.** Every registry
   `usage:` string already shows its positional — `rbox start [path]`
   (`help-registry.ts:134`) is literally already there. The problem is that
   **nobody sees it**: `renderEssentialHelp()` (`help-registry.ts:650-704`) —
   what `rbox help`, `rbox --help`, bare non-TTY `rbox`, and *every unknown
   command* print — is a **hand-written literal listing 11 bare command names
   with no usage strings at all**. Full usage lives only behind
   `rbox help --all` or `rbox <cmd> --help`. Max's fix (`start [PATH]`) is
   already implemented one screen deeper than the screen he was shown.

3. **`[path]` is a locator, not a scope** (`workspace-config.ts:107-119`). On
   `start`/`stop`/`status`/`sync`/`logs`/`untrack` the path is ancestor-walked
   to find the enclosing workspace and then discarded as scope — `rbox sync
   ./src` syncs the *entire* enclosing workspace. Only `track` treats the path
   literally. **Adopting Max's "always require a path" shape without changing
   this would make the CLI more misleading, not less**, because a required path
   implies a scope the engine does not honor.

4. **`rbox status` has no all-workspaces view** — it only ever reports the cwd's
   workspace. The nearest thing is `rbox autostart status`, which lists
   *desired* state, human-only, no `--json`. Max's "no path = status for all
   workspaces" is a **new feature**, not a default change. There is no
   `workspace list` anywhere.

5. **`setup` earns his criticism, for a bigger reason than the verb.** It is two
   commands under one name: `--workspace` + a key runs fully headless, anything
   else is a TTY-only Ink wizard that exits 1 without a TTY
   (`setup-cmd.ts:185-192`). Six of its seven documented flags apply only to the
   keyed path. And it does far more than "account → workspace → start syncing" —
   it can mint encryption keys, **open a Stripe checkout and block up to five
   minutes polling for a plan** (`setup-cmd.ts:455-492`), start a daemon, and
   enable autostart. "What will it do…?" currently has no answer available from
   help.

## Cross-cutting findings

These recur across lanes and are probably better fixed as classes than
command-by-command.

### A. Destructive commands with no confirmation, inconsistently

`device revoke` (L1), `trash empty` (L3, no `--yes` flag at all), and
`key revoke` (L4) destroy state with zero confirmation — while `key create-ci`,
which is *less* dangerous, does gate on a confirm. `untrack` auto-proceeds with
no confirmation in any non-interactive context (`prompt.ts:104-105`) while its
help attributes that skip to `--force`. The inconsistency is the defect;
Max's "remove sounds destructive ofc" instinct is pointed at exactly this class.

### B. The `--no-interactive` allowlist is a bug, not a design

`--no-interactive` is a global argv toggle (`prompt-policy.ts:17`) but is
whitelisted for only `track`/`init`/`setup` (`flags.ts:95-99`). So
`rbox key recover --no-interactive` errors out, and **`rbox init --no-sync` is
rejected as an unknown flag despite being implemented and unit-tested**
(`flags.ts:97` vs `init-plan.ts:176`, verified live). The mechanism exists; the
allowlist is stale.

### C. Positional args are silently swallowed

Ten commands (`setup`, `login`, `init`, `export`, `upgrade`, …) accept and
ignore extra positionals with no arity check — `rbox export ~/code/myapp`
silently acts on cwd. This is the same failure mode as (3) above and is the most
likely source of quiet user confusion.

### D. Path-relativity is inconsistent, and one case is a wrong answer

`versions`, `restore`, and `trash restore` treat their path argument as
**workspace-root-relative** while users type it **cwd-relative** (L3-D8).
`versions` then prints "no changes … (or the file is unknown here)", which is
indistinguishable from a genuinely empty history. This is a silent wrong answer
from a plausible invocation, and is the one item here that reads as a bug
rather than a naming problem.

### E. Usage strings are load-bearing for behavior

Flag arity and the unknown-flag gate are **derived from the registry's usage
strings** (`flags.ts:67-113`), and `completions.ts:74-76` grants file completion
by regexing the word `path` out of the usage string. Editing a usage string
therefore changes parsing and completion — this is good (help cannot drift from
arity) but means **no usage-string change in this review is cosmetic**.

### F. Verb collisions, from code

`status` exists as five different things; `restore` / `recover` / `list` as two
to four each. Group modeling uses three incompatible styles: `key` is a group
with 9 leaves, `device`/`account` are groups only, `trash`/`autostart`/`git` are
leaves only. Noun-first (`git deferrals`, `trash list`, `autostart enable`) and
bare-verb forms coexist. `doctor` overloads three unrelated jobs. `init` vs
`track` differ in exactly **one** substantive way: whether a first sync runs.

### G. Dead vs staged surface

The commented-out `deps *` block (`help-registry.ts:336-374`) is **staged work
with a decision record** — design 51 §5 (`docs/design/51-rbox-yml-config.md:254-294`).
The commented-out `hydrate`/`detect` aliases are **dead**: their targets no
longer exist and `doctor` was reassigned to support diagnostics. Treat these
differently.

### H. Scriptability gaps (founder standing rule: every flow needs a twin)

Nine gaps found. The load-bearing ones: the guided `setup` entirely; `login`'s
device-code and key-delivery fallback, which off-TTY aborts and demands a
terminal for a pairing token or 24-word phrase with **no flag form**
(`auth/device-login.ts:393-436`); 1Password and clipboard key destinations,
reachable only from the interactive genesis checkbox
(`auth/genesis-destination-flow.ts:74-109`); and no way to discover a workspace
id without an interactive picker. Note `key save`/`key recover` *do* accept the
phrase on stdin, but that channel is **documented nowhere**, so an agent reading
`--help` would wrongly conclude they are interactive-only.

### I. Answering the `key save` question directly

`key save` supports exactly **two** destinations: macOS login Keychain (darwin,
no `--kit-path`) or a plaintext 0600 file. **No 1Password.** Its help overstates
platform support, so on Linux it **silently writes the recovery phrase in
plaintext**. The 1Password / Keychain / file / clipboard multi-select described
in the thread exists only in the interactive genesis flow.

## Max's claims mapped to code

| His claim | Verdict | Reality |
|---|---|---|
| "I assumed start and stop referred to the ENTIRE DAEMON" | **Assumption wrong, criticism right** | One daemon per workspace; no-arg = cwd's workspace only; no all-daemon command exists |
| "if the help was `start [PATH]` it would be clearer" | **Already done, never shown** | `usage: "rbox start [path]"` exists at `help-registry.ts:134`; the essential screen prints bare names |
| `rbox sync ./src` — "I would always require a path" | **Would mislead as-is** | Path is a locator, not a scope; syncs the whole enclosing workspace |
| `rbox status` no-path = all workspaces | **Feature request** | No all-workspaces view exists; no path outside a workspace errors |
| "add and remove verbs though remove sounds destructive" | **Points at a real gap** | Three destructive commands have no confirmation at all |
| "track/untrack don't quite communicate everything that happens" | **Correct** | `init` vs `track` differ only in whether a first sync runs; `untrack` skips confirmation non-interactively |
| "setup is not a great cli verb… What will it do?" | **Correct, and worse than he knew** | Two commands under one name; can open a Stripe checkout and block 5 min |
| `rbox auth login` grouping | **Not modeled** | `login`/`logout` are bare top-level verbs; no `auth` group exists |

---

# Per-command inventory

The five lane documents follow verbatim. Each was produced independently
against the implementation, with `file:line` citations.


---

# Lane 1 — onboarding + identity commands

Scope: `setup`, `login`, `logout`, `pair`, `connect`, `recover`, `device`, `account`.
Sources: help text `src/cli/help-registry.ts`; dispatch `src/cli/main-dispatch.ts`;
flag parsing `src/cli/flags.ts`; implementations under `src/cli/setup-cmd.ts`,
`src/cli/setup-keyed.ts`, `src/cli/auth/*.ts`, `src/cli/account-cmd.ts`,
`src/cli/recover-cmd.ts`.

## Cross-cutting mechanics (apply to every command below)

- **Flag arity is derived from the help registry itself** (`flags.ts:54-65`): a flag
  declared as `--x <v>` consumes the next argv token; a flag declared bare does not.
  A flag the code reads but the registry does not declare falls back to the
  registry-wide union arity (`flags.ts:26-40`), pinned to valueless on collision.
- **Undeclared flags are rejected** (`flags.ts:101-113`) except `--json`, `--help`,
  and a per-command `HIDDEN_FLAGS` allowlist (`flags.ts:95-99`).
- **Short flags** are global, not per-command (`flags.ts:3-8`): `-f`→follow,
  `-n`→lines, `-y`→yes, `-w`→workspace. So `-w` is accepted on *any* command.
- **`--no-interactive` is read globally from argv** (`index.ts:46-47`,
  `prompt-policy.ts:18`) and disables every prompt surface — but it is only on the
  per-command allowlist for `track`/`init` (`flags.ts:96-97`). On the other
  commands in this lane it fails the unknown-flag gate *before* it can take effect.
- **`isInteractive()` requires stdin TTY *and* stderr TTY** plus the policy
  (`prompt.ts:58-62`).
- Env overrides seen in this lane: `RBOX_API` (server, `api-base.ts:3`),
  `RBOX_APP` (approval URL host, `auth/device-login.ts:154`), `RBOX_TOKEN` /
  `RBOX_DEVICE_ID` / `RBOX_ACCOUNT_ID` (credential from env, `credentials.ts:189-194`),
  `RBOX_PAIR_TOKEN` (see `login`), `RBOX_KEY` (see `setup`),
  `RBOX_ADOPT_OVERLAY=0` (suppresses the setup adopt offer, `setup-cmd.ts:725`).

---

## setup

**Help entry** (`help-registry.ts:51-66`) — group `GETTING STARTED`, not hidden, no alias.
summary: "guided onboarding: account → workspace → start syncing".
usage: `rbox setup [--workspace <name|id>] [--dir <path>] [--key -] [--key-file <path>] [--daemon] [--pull-only] [--force]`.

**Dispatch**: `main-dispatch.ts:186-189` → `runSetup({ cwd: process.cwd(), defaultRemote, flags })`.
Implementation `setup-cmd.ts:162-294` (guided) and `setup-keyed.ts:75-116` (keyed).

| arg/flag | declared? | parsed at | behavior / default |
|---|---|---|---|
| positional args | no | — | **none accepted, none validated** — extra positionals are silently ignored |
| `--workspace <name\|id>` / `-w` | yes | `setup-cmd.ts:177-181` | switches to the **keyed, non-interactive** path; requires a key or throws |
| `--key -` | yes | `setup-keyed.ts:24` | read bundle from stdin. `--key=<value>` is refused (`setup-cmd.ts:174-176`) |
| `--key-file <path>` | yes | `setup-keyed.ts:25-28` | `--key-file` with no path → "requires a path" |
| `RBOX_KEY` (env) | mentioned in flag prose | `setup-keyed.ts:20,29-30` | third key source |
| `--dir <path>` | yes | `setup-keyed.ts:83` | keyed only; default is the workspace-name slug, else the workspace id (`setup-keyed.ts:37-39`), resolved against cwd |
| `--daemon` | yes | `setup-keyed.ts:108-115` | keyed only; starts background sync after first pull |
| `--pull-only` | yes | `setup-keyed.ts:109-114` | keyed only; **without it, `--daemon` starts read-write and only prints a warning** |
| `--force` | yes | `setup-keyed.ts:94` | keyed only; allow non-empty target dir |
| `--new` | **no (hidden allowlist)** | `flags.ts:98` | accepted, **never read** by `runSetup` — silently ignored |
| `--name` | **no (hidden allowlist)** | `flags.ts:98` | accepted, **never read** — silently ignored |
| `--no-sync` | **no (hidden allowlist)** | `flags.ts:98` | accepted, **never read** at the `runSetup` entry (it is set internally at `setup-cmd.ts:695,882`) |
| `--respect-gitignore` | **no (hidden allowlist)** | `flags.ts:98` | accepted, **never read** — the guided flow asks interactively instead (`setup-cmd.ts:841-845`) |
| `--json` | implicit | `flags.ts:104` | accepted by the gate; `setup` emits no JSON |
| `--no-interactive` | no | — | **rejected** with "unknown flag --no-interactive for `rbox setup`" |

**Path semantics**: `setup` takes **no path argument at all**. The guided flow
*prompts* for the directory (`setup-cmd.ts:690` join / `setup-cmd.ts:750` create),
defaulting to `opts.cwd`. The keyed flow derives the directory from `--dir` or from
the workspace slug (`setup-keyed.ts:83`) — it does **not** default to cwd-as-root; it
creates a *subdirectory* of cwd named after the workspace.

**Interactive vs scriptable**: the guided flow is a full Ink TUI on stderr. If stdin
is not a TTY it prints "rbox setup is interactive. For scripts/CI use `rbox init`…"
and exits 1 (`setup-cmd.ts:185-192`). The **only** non-interactive twin inside
`setup` is the keyed path (`--workspace` + key), and that check runs *before* the TTY
check (`setup-cmd.ts:177-181`), so it works headless. Everything else — account
creation, plan/trial checkout, workspace choice, gitignore policy, adopt consent,
start-sync choice — has no flag form; `rbox init` is the documented scripting twin.

**What `setup` actually does, step by step** (relevant to the "setup is not a great
CLI verb" note):

1. Reject `--key=<value>`; if `--workspace` is present, run keyed setup and return
   (`setup-cmd.ts:174-181`).
2. Warn that `--dir/--daemon/--pull-only/--force` are ignored outside keyed setup
   (`setup-cmd.ts:182-184`).
3. Bail out with exit 1 if not a TTY (`setup-cmd.ts:185-192`).
4. Load credentials, decide whether this machine is already *enrolled* (has key
   material) — `enrolledAccountId`, `setup-cmd.ts:297-306`. If enrolled, print
   "skipping account setup" and renumber the wizard from 3 steps to 2
   (`setup-cmd.ts:242-247`).
5. **Step 1 · Account** (`stepAccount`, `setup-cmd.ts:401-420`): select "Create a new
   account" vs "Log into an existing account".
   - Create: hidden-input prompt that doubles as *either* a bootstrap secret *or*
     bare Enter → browser device-code login (`setup-cmd.ts:411-416`).
   - Existing: menu of "Sign in via browser" (device-code) vs "Paste a pairing
     token" (`AUTHORIZATION_CHOICES`, `setup-cmd.ts:506-509`).
   - If authorized but not enrolled, `resolveEnrollment` (`setup-cmd.ts:539-614`)
     offers genesis / pairing token / 24-word phrase / "I'll do this later".
6. **Trial + checkout**, only when a new account was created with a bootstrap secret
   (`setup-cmd.ts:455-473`): 4-way plan select, opens a Stripe checkout in the
   browser, then **polls `/v1/account/usage` for up to 5 minutes**
   (`setup-cmd.ts:475-492`). If the poll fails, sync is disabled and the flow warns
   "Sync is disabled until you run `rbox subscribe`" (`setup-cmd.ts:251-255`).
7. **Step 2 · Workspace** (`stepWorkspace`, `setup-cmd.ts:642-905`): choose create-new
   vs join-existing; pick a directory (prompt, default cwd); create the directory if
   missing; detect a prior binding and ask to rebind; offer adoption of existing
   contents; acquire the workspace sync mutex; prompt for an optional server-visible
   workspace name; prompt for gitignore handling; create the remote workspace; hand
   off to `runInit`, which performs the first populate-sync.
8. **Step 3 · Start syncing** (`setup-cmd.ts:257-275`): a 3-way select — start daemon
   + autostart / start daemon only / not now.
9. **Finish** (`finishSetup`, `setup-cmd.ts:917-945`): summary, then "Set up another
   machine now" (runs `pairCreate`) vs "Exit".

**Divergences**

- Usage string implies a flat flag set; in reality **six of the seven flags are
  keyed-setup-only** and are explicitly ignored (with a stderr note) in the guided
  flow (`setup-cmd.ts:182-184`). Only `--workspace` changes the mode.
- `--key`/`--key-file`/`RBOX_KEY` **without** `--workspace` are silently ignored —
  no note is printed (the note at `setup-cmd.ts:182` covers only `--dir/--daemon/--pull-only/--force`).
- Four undocumented flags are accepted and then ignored: `--new`, `--name`,
  `--no-sync`, `--respect-gitignore` (`flags.ts:98`).
- `--no-interactive` — the standard escape hatch elsewhere in the CLI — is rejected
  for `setup`.
- Help never mentions that `setup` **hard-fails off a TTY** (exit 1), that the guided
  flow can **charge money** (opens a Stripe checkout and blocks up to 5 min polling),
  or that it may **start a background daemon and enable autostart**. Summary says
  "account → workspace → start syncing"; billing is invisible.
- Help does not say `setup` takes no path and instead *prompts* for one; the keyed
  path's default target is a **new subdirectory of cwd** named after the workspace,
  which is not stated anywhere.
- `--pull-only` is described as "with --daemon, never push local changes"; with
  `--daemon` alone the daemon starts **read-write** on a credential the code itself
  calls "pull-only fleet credentials" (`setup-keyed.ts:112`).
- Bare `rbox` in a TTY also lands here (`main-dispatch.ts:618-620` → `runGuidedFrontDoor`
  → `runSetup`), as does `rbox start` outside a workspace on a TTY
  (`main-dispatch.ts:420-421`). Neither is in the `setup` help entry (the `start`
  entry notes it, `help-registry.ts:139`).

---

## login

**Help entry** (`help-registry.ts:67-80`) — group `GETTING STARTED`, not hidden.
summary "authorize this machine".
usage: `rbox login [--bootstrap <secret>] [--plan <solo|pro>] [--label <text>] [--kit] [--kit-path <path>]`.

**Dispatch**: `main-dispatch.ts:222-229` → `login(flags.remote ?? DEFAULT_REMOTE, flags.bootstrap, flags.plan, recoveryKitOptionsFromFlags(flags), flags.label)`.
Implementation `auth/device-login.ts:619-678`.

| arg/flag | declared? | parsed at | behavior / default |
|---|---|---|---|
| positional args | no | — | **none accepted, none validated** — ignored |
| `--bootstrap <secret>` | yes | `main-dispatch.ts:226-227` | valueless `--bootstrap` is rejected with an explicit message; with a value → `POST` bootstrap, save credentials, run genesis enrollment (`device-login.ts:635-650`) |
| `--plan <solo\|pro>` | yes | `device-login.ts:636` | forwarded verbatim to the server; **the CLI does not validate the value** despite the `<solo\|pro>` usage hint |
| `--label <text>` | yes | `device-login.ts:628` | defaults to `os.hostname()`; empty/whitespace falls back to hostname |
| `--kit` | yes | `recovery-kit.ts:100-105` | `--kit <path>` is rejected ("does not take a path") |
| `--kit-path <path>` | yes | `recovery-kit.ts:102-104` | implies `kit: true` |
| `--remote <url>` | **declared in flags, absent from the usage string** | `main-dispatch.ts:227` | default `DEFAULT_REMOTE`; `RBOX_API` also overrides (`api-base.ts:3`) |
| `RBOX_PAIR_TOKEN` (env) | **undocumented** | `device-login.ts:630-634` | **short-circuits the entire login**: redeems the pairing token and returns. Nothing in help mentions it |

**Path semantics**: no path, no cwd dependency. Purely account/device scoped.

**Interactive vs scriptable**:

- `--bootstrap <secret>` is fully non-interactive (unless the recovery-kit offer
  prompts; `recoveryKitAction` returns `write-suppress-echo`/`none` when
  non-interactive, `recovery-kit.ts:108-111`).
- `RBOX_PAIR_TOKEN` is fully non-interactive.
- Bare `rbox login` is the **device-code flow**: it prints an approval URL, tries to
  open a browser, offers "press [c] to copy", and polls until approval or expiry
  (`device-login.ts:472-482`, `685-699`). It can *complete* headless (the poll loop
  itself needs no TTY), but it requires a human in a browser.
- **Branch that cannot be driven non-interactively**: the key-delivery *fallback*.
  If no enrolled machine delivers keys before expiry and stdin is not interactive,
  it aborts with "no enrolled machine delivered keys before expiry — run `rbox login`
  in a terminal to use a pairing token or recovery phrase" (`device-login.ts:393-396`).
  The interactive branch prompts for a pairing token or a 24-word phrase
  (`device-login.ts:397-436`) — there is **no flag form** for either.
- Also non-scriptable: after a legacy device-code approval on an account with no
  keys, the "Set up encryption on this first machine now?" confirm
  (`device-login.ts:138`); headless prints a note and leaves the machine unenrolled
  (`device-login.ts:133-136`).

**Divergences**

- `--remote` appears in the flag list but not the usage line (`help-registry.ts:71` vs `:78`).
- `RBOX_PAIR_TOKEN` is a completely undocumented control path that changes what
  `rbox login` does.
- Summary "authorize this machine" understates it: with `--bootstrap` it **creates an
  account, mints the account's first encryption keys, and prints/writes a 24-word
  recovery phrase** (`device-login.ts:642-647`). The flag description mentions account
  creation; the summary line in the grouped screen does not.
- `--plan` is unvalidated client-side.
- Login persists a resumable attempt journal and sweeps stale attempts
  (`device-login.ts:653-654`); a re-run may **resume** a prior attempt rather than
  start a fresh one (`resumeLoginAttempt`, `device-login.ts:654`). Undocumented.
- Device-limit and rate-limit failures produce distinct errors
  (`device-login.ts:508-510`, `:82`) not mentioned in help.

---

## logout

**Help entry** (`help-registry.ts:81-86`) — `GETTING STARTED`, usage `rbox logout`, no flags.

**Dispatch**: `main-dispatch.ts:230-233` → `logout()` (`auth/session.ts:7-13`).

| arg/flag | declared? | parsed at | behavior |
|---|---|---|---|
| positional args | no | — | **accepted and silently ignored** — no arity check (contrast `pair`, `main-dispatch.ts:235`) |
| `--json` | implicit | `flags.ts:104` | accepted, no JSON output |

**Path semantics**: none.

**Interactive**: fully non-interactive, no prompts, no confirmation.

**Divergences**

- Help says "remove this machine's credential". It also **clears the cached account
  profile** (`session.ts:10`, `clearAccountProfile`) and prints "autostart still
  enabled" when autostart is on (`session.ts:8,12`) — i.e. logout does **not** stop
  daemons or disable autostart, and the only hint of that is a conditional runtime line.
- No confirmation and no `--yes`; a logged-out machine loses the credential but keeps
  its local keystore/device material (nothing in `logout` touches `e2ee-keystore`).

---

## pair

**Help entry** (`help-registry.ts:375-380`) — group `DEVICES & ACCOUNT`,
summary "create a token to add another machine", usage `rbox pair`, no flags.

**Dispatch**: `main-dispatch.ts:234-239` → `pairCreate()` (`auth/pairing-command.ts:15-42`).

| arg/flag | declared? | parsed at | behavior |
|---|---|---|---|
| positional args | no | `main-dispatch.ts:235` | **strictly rejected**: any positional → `usage: rbox pair` |
| `--json` | implicit | `flags.ts:104` | accepted, no JSON output |
| anything else | — | `flags.ts:101` | rejected as unknown flag |

**Path semantics**: none.

**Interactive vs scriptable**: minting is non-interactive; the token command is
printed on **stdout** via `console.log` (`pairing-command.ts:61-65`), so it is
pipeable. The trailing "Press [c] to copy…" keypress prompt only runs when
`isInteractive()` (`pairing-command.ts:67-76`), so a scripted run completes cleanly.

**Behavior detail**: requires an enrolled device — errors if the credential has no
`accountId` (`pairing-command.ts:17`) or no local key material
(`pairing-command.ts:20`), and refuses while a genesis is pending
(`assertNoPendingGenesis`, `pairing-command.ts:18`). Token TTL is **10 minutes**
(`pairing-command.ts:26`) and single-use. 429 → "too many active pairing tokens"
(`pairing-command.ts:34`).

**Divergences**

- Help does not state the **10-minute, single-use** lifetime, that the token
  **carries the account's encryption key**, or that there is an active-token cap. All
  three appear only in runtime output (`pairing-command.ts:63`, `:34`).
- Help does not say the output is a **complete `rbox connect …` command** to paste,
  which is the actual UX (`pairing-command.ts:44-48`).
- No `--json`, no `--label`, no TTL flag; the token cannot be minted with a custom
  expiry or machine-readable form.

---

## connect

**Help entry** (`help-registry.ts:381-389`) — group `DEVICES & ACCOUNT`,
summary "authorize + encrypt this machine with a pairing token",
usage `rbox connect [<pairing-token>]`, flag `--remote <url>`,
notes/examples cover the stdin form.

**Dispatch**: `main-dispatch.ts:457-466`.

| arg/flag | declared? | parsed at | behavior |
|---|---|---|---|
| `<pairing-token>` (positional 0) | yes, optional | `main-dispatch.ts:462` | optional; **>1 positional is rejected** (`main-dispatch.ts:460`) |
| `--remote <url>` | yes | `main-dispatch.ts:464` | default `DEFAULT_REMOTE`; `RBOX_API` also overrides |
| `--json` | implicit | `flags.ts:104` | accepted, no JSON output |

**Path semantics**: none.

**Interactive vs scriptable**: fully scriptable three ways — token in argv, token on
stdin (`echo <token> \| rbox connect`), or a masked interactive prompt. The branch is
chosen by `isInteractive()` in `readPairingTokenInteractive`
(`auth/pairing-command.ts:95-100`): TTY → masked prompt, otherwise read stdin. Empty
input → an explicit error naming `rbox pair` (`main-dispatch.ts:463`).

**Divergences**

- Help does not mention that a redeemed token both **authorizes the device and
  enrolls encryption** in one step in the sense that the local device label is not
  settable here — `redeemPair(remote, token)` is called with `label` undefined
  (`main-dispatch.ts:464`), so the device is labeled by the server/`enrollViaPairing`
  default. `login` has `--label`; `connect` has no equivalent.
- Success output is "device authorized + encryption enrolled: <deviceId>" plus a
  "Run `rbox setup` and choose …" next step (`auth/presentation.ts:21-24`,
  `:3-4`) — i.e. `connect` deliberately dead-ends into `setup`, which help does not say.
- Putting the token in argv leaks a bearer secret into shell history/process lists.
  The same codebase refuses `--key=<value>` for exactly that reason
  (`setup-cmd.ts:174-176`) and refuses to accept pairing tokens in argv for `login`
  (env only, `device-login.ts:630`), but the documented primary `connect` example is
  `rbox connect rbox-pair_<id>.<secret>` (`help-registry.ts:388`).

---

## recover

**Help entry** (`help-registry.ts:390-400`) — group `DEVICES & ACCOUNT`,
summary "clear the local head pin and re-baseline a halted workspace",
usage `rbox recover [path] [--yes] [--repair-chain] [--allow-mass-delete]`.

**Dispatch**: `main-dispatch.ts:467-475` → `recoverWorkspaceCmd(positional[0], {...})`
(`recover-cmd.ts:41-132`).

| arg/flag | declared? | parsed at | behavior / default |
|---|---|---|---|
| `[path]` (positional 0) | yes | `recover-cmd.ts:42` | `findRoot(pathArg ?? process.cwd())` — **implicit cwd**; walks up to the workspace root. Extra positionals ignored |
| `--yes` / `-y` | yes | `recover-cmd.ts:48` | skips the confirm **and** silently auto-approves the chain-repair supersede confirm (`recover-cmd.ts:99`) |
| `--repair-chain` | yes | `recover-cmd.ts:99` | auto-approves only the supersede confirm |
| `--allow-mass-delete` | yes | `recover-cmd.ts:69,73` | sets **both** pull-side and push-side consent |
| `RBOX_ALLOW_MASS_DELETE=1` (env) | **undocumented for this command** | `recover-cmd.ts:73` | push-side consent only |
| `--json` | implicit | `flags.ts:104` | accepted, no JSON output |

**Path semantics**: optional path, **implicit cwd**, resolved by walking up to the
workspace root (`findRoot`). Not inside a workspace → "Not inside an rbox workspace.
Run `rbox setup` … or `rbox track <path>`" (`recover-cmd.ts:43`).

**Interactive vs scriptable**: fully scriptable with `--yes`. Without it and off a
TTY, `confirmDestructive({headless: "throw"})` throws rather than proceeding
(`recover-cmd.ts:52`, `prompt.ts:104-111`). The chain-repair supersede prompt is
covered by `--yes` or `--repair-chain`, so there is **no** un-scriptable branch.

**Divergences**

- The summary says "clear the local head pin and re-baseline". What it actually does
  is a **full sync ceremony**: confirm → strict credential check → acquire the
  workspace sync mutex → pull (with a rebaseline retry on `NeedsRebaselineError`) →
  optional chain repair → `postSyncNudge` → **push local diffs**
  (`recover-cmd.ts:64-131`). The confirmation message itself says "then pushes
  remaining local diffs" (`recover-cmd.ts:45`) — the help does not.
- `--yes` is documented only as "skip the confirmation prompt"; it *also* grants the
  chain-repair supersede consent that `--repair-chain` exists to grant
  (`recover-cmd.ts:99`), i.e. `--yes` is strictly stronger than advertised.
- Grouped under **DEVICES & ACCOUNT**, but it is a workspace/sync repair command with
  a `[path]`; every other path-taking sync command lives in `SYNCING`.
- Name collision: `rbox recover` (workspace re-baseline) vs `rbox key recover`
  (re-enroll this machine from the 24-word phrase, `help-registry.ts:450-459`). The
  two are unrelated operations sharing a verb, and `rbox key recover` is what most of
  the onboarding copy points users at (`presentation.ts:2-6`, `setup-cmd.ts:588`).
- Env consent `RBOX_ALLOW_MASS_DELETE` is documented on `push`
  (`help-registry.ts:218`) but not on `recover`, which also honors it.

---

## device

**Help entry** (`help-registry.ts:401-407`) — group `DEVICES & ACCOUNT`,
summary "manage devices",
usage `rbox device <approve <user-code> | list [--json] | revoke <device-id>>`,
flag `--json` ("with `list`, print JSON").

**Dispatch**: `main-dispatch.ts:248-257`. Implementation `auth/device-commands.ts`.

| arg/flag | declared? | parsed at | behavior |
|---|---|---|---|
| `approve <user-code>` | yes | `main-dispatch.ts:250` | missing code → passes `""` to the server rather than a local usage error |
| `list` | yes | `main-dispatch.ts:251` | prints `id  label  version  last-seen`, `*` marks self (`device-commands.ts:34-37`) |
| `revoke <device-id>` | yes | `main-dispatch.ts:252` | missing id → passes `""` to the server |
| unknown/absent subcommand | — | `main-dispatch.ts:253-255` | `fail(usage…)`, exit 1 |
| extra positionals | no | — | ignored (no arity check) |
| `--json` | yes | `main-dispatch.ts:251` | honored **only** for `list`; on `approve`/`revoke` it is accepted and dropped (`main-dispatch.ts:160-162` demotes it because the registry declares it) |

**Path semantics**: none.

**Interactive vs scriptable**: fully non-interactive. No confirmation on `revoke`.

**Divergences**

- `rbox device` with no subcommand exits 1 with a usage line — it is not a listing
  default, which the `<a | b | c>` usage form makes ambiguous.
- `approve ""` / `revoke ""` are sent to the server instead of failing locally
  (`main-dispatch.ts:250,252`) — the resulting error is an HTTP error, not a usage error.
- `list` JSON hard-codes `kind: "cli"` and `revoked: false` for every device
  (`device-commands.ts:25,29`) and drops the `label`/`isSelf` fields that the human
  output shows — the two renderings are not the same data.
- `revoke` is destructive (cuts a machine off the account) with **no confirmation and
  no `--yes`**, unlike `untrack`/`recover`/`uninstall`.

---

## account

**Help entry** (`help-registry.ts:408-414`) — group `DEVICES & ACCOUNT`,
summary "link this CLI to your web login",
usage `rbox account <link <code> | status [--json] | unlink>`, flag `--json`.

**Dispatch**: `main-dispatch.ts:258-269`. Implementation `account-cmd.ts`.

| arg/flag | declared? | parsed at | behavior |
|---|---|---|---|
| `link <code>` | yes | `main-dispatch.ts:262` | empty code → local usage error (`account-cmd.ts:18`). 403 → must run from a non-revoked OWNER device; 401 → expired code (`account-cmd.ts:25-26`) |
| `status` | yes | `main-dispatch.ts:263` | prints account id, signed-in-as, plan, web-login-linked |
| `unlink` | yes | `main-dispatch.ts:264` | 404 no linked login; 409 active billing; 403 needs owner device (`account-cmd.ts:170-172`) |
| unknown/absent subcommand | — | `main-dispatch.ts:265-267` | `fail(usage…)`, exit 1 |
| extra positionals | no | — | ignored |
| `--json` | yes | `main-dispatch.ts:263` | honored only for `status`; the JSON path makes an **extra** `/v1/account/usage` call and can fail with "usage failed: <status>" (`account-cmd.ts:141-142`) |

**Path semantics**: none.

**Interactive vs scriptable**: fully non-interactive. `link` is a two-phase flow —
the CLI records a *pending proposal* and the user must approve it in the web
dashboard (`account-cmd.ts:29-30`); there is no CLI-side completion or polling.

**Divergences**

- Summary "link this CLI to your web login" describes only one of three subcommands;
  `unlink` **moves the web login to a fresh empty account** (`account-cmd.ts:174`)
  and is gated on billing state — none of that is in help.
- Help does not say `link` requires an **OWNER device** (one created via
  `rbox login --bootstrap`) — a 403 is the only signal (`account-cmd.ts:25`).
- `status --json` and plain `status` return different data: JSON adds
  `graceUntil`/`readOnly` from a second endpoint (`account-cmd.ts:141-152`), the human
  form does not show them.
- `status` writes a local account-profile cache as a side effect
  (`scheduleAccountProfileWrite`, `account-cmd.ts:133`) — undocumented but harmless.
- Naming: `rbox account link` (web↔CLI identity) vs the deprecated `rbox link <path>`
  (→ `rbox track`, `deprecations.ts:29`, `help-registry.ts:593`). The source
  explicitly notes the collision (`main-dispatch.ts:259`, `account-cmd.ts:10-12`).

---

## Lane-level observations relevant to the path/verb review

- **No command in this lane takes a required path.** `recover` is the only one that
  takes a path at all, and it is optional + implicit-cwd (`recover-cmd.ts:42`).
  `setup` prompts for a directory instead of accepting one; the keyed form's `--dir`
  is the only flag path in the lane.
- **Three different "get this machine working" verbs** exist with overlapping
  meaning: `setup` (guided, TTY-only), `init` (documented scripting twin,
  `help-registry.ts:99-117`), and `login` + `connect` (identity only). `setup`'s
  non-TTY error message is the only place the `setup`↔`init` relationship is stated
  (`setup-cmd.ts:186-188`).
- **`recover` is overloaded**: `rbox recover` (workspace) vs `rbox key recover`
  (encryption) vs the in-wizard "Recover with my 24-word phrase" branch
  (`setup-cmd.ts:520`).
- **Non-scriptable branch inventory** (founder priority): guided `setup` in its
  entirety except the keyed path; the `login` key-delivery fallback prompt
  (`device-login.ts:397`); the `login` first-machine-encryption confirm
  (`device-login.ts:138`). Everything else in this lane can be driven end-to-end by
  an agent.


---

# Lane 2 — daemon + workspace lifecycle

Repo `/home/via/Development/Personal/rbox-core`, branch `main` @ `77329d9d`.
Sources: help text `src/cli/help-registry.ts`; dispatcher `src/cli/main-dispatch.ts`
(one `switch (cmd)`, lines 180–624); flag parser `src/cli/flags.ts`.

## Cross-cutting facts (read first)

**There is no whole-daemon surface.** rbox runs one daemon *per workspace*, keyed
by workspace root under `~/.rbox/daemons/<key>/` (`autostart-cmd.ts:85-88`,
`daemon-control.ts` re-exports `daemonRuntimeDir`). Every command in this lane
that takes `[path]` resolves it to exactly ONE workspace root and acts on that
workspace's daemon only. The only code paths that iterate every workspace are
`bootResume()` (autostart-cmd.ts:573-595, hidden `__boot-resume` verb),
`rbox upgrade` (upgrade-cmd.ts:110-160), and the read-only listing in
`rbox autostart status`.

**`[path]` is a LOCATOR, not a SCOPE.** All of `start`/`stop`/`status`/`sync`/
`logs`/`push`/`pull` funnel the positional through `resolveRoot()`
(main-dispatch.ts:71-75), which calls `findRoot()` — and `findRoot` walks *up*
the ancestor chain looking for `.rbox/workspace.json`
(`workspace-config.ts:107-119`). So `rbox sync ./src` inside a workspace does
**not** sync `./src`; it locates the enclosing workspace root and syncs the whole
workspace. A path *outside* any workspace is an error. Verified live.

**No-arg = the cwd's workspace, never "everything".** `resolveRoot(undefined)`
= `findRoot(process.cwd())`, error if none.

### HEADLINE: `stop` with no argument does NOT stop the entire daemon

Max assumed `start`/`stop` referred to the entire daemon; the founder said with
no arg it *should* stop the entire daemon and "that's how I treat them at
least". **The code disagrees.**

```
case "stop": {
  await stopDaemonAndRecordDesired(await resolveRoot(positional[0]));
```
— main-dispatch.ts:427-429.

* `rbox stop` inside workspace A stops **only workspace A's** daemon. Workspaces
  B and C keep running, keep their `desired.state = "running"`, and will be
  resumed at next login if autostart is on.
* `rbox stop` **outside** any workspace does not stop anything — it errors:
  `✗ rbox: Not inside an rbox workspace. Run 'rbox setup' to get started, or 'rbox track <path>' to bind a directory.` (main-dispatch.ts:67-69, verified live, exit 1).
* There is **no** command that stops every daemon. Nothing in the CLI surface
  offers it. The closest is `rbox autostart status`, which only *lists* them.
* `rbox stop` additionally **fails when logged out**, even with a live daemon:
  `stopDaemonAndRecordDesired` → `desiredContext` throws
  `"not logged in — run 'rbox login' before changing background sync state"`
  (autostart-cmd.ts:176-180) *before* `stopDaemon` is reached
  (autostart-cmd.ts:463-483). Signing out therefore strands running daemons.

So the founder's mental model ("no arg = the whole daemon") is not what ships,
and the help string `rbox stop [path]` doesn't disambiguate either way.

---

## start

**Help entry** — help-registry.ts:130-140. Group `SYNCING`, not hidden, not an alias.

| field | value |
|---|---|
| summary | `start background sync for this workspace` |
| usage | `rbox start [path] [--pull-only \| --read-write]` |
| note | "Run outside a workspace with no path, on a terminal, and rbox opens the guided setup to create or join one." |

**Implementation** — dispatcher case main-dispatch.ts:404-426 →
`startDaemonAndRecordDesired` (autostart-cmd.ts:448) → `startDaemon`
(`daemon/process-control.ts:240`).

| arg/flag | parsed at | semantics |
|---|---|---|
| `[path]` (positional[0]) | main-dispatch.ts:413 | resolved via `resolveRoot` (ancestor walk); extra positionals are **silently ignored** (no arity check) |
| `--pull-only` | :405, :408 | daemon watches remote, never pushes |
| `--read-write` | :405, :411 | pull + push |
| neither | :412 (`mode = undefined`) | **preserve prior mode** from `desired.json`, defaulting read-write (`resolveStartMode`, autostart-cmd.ts:230-242; `desiredMode`, :206-210) |
| both | :405-407 | error `choose only one background sync mode: --pull-only or --read-write` |

Any other `--flag` is rejected up front by `unknownFlagError` (flags.ts:101-113;
`start` has no hidden-flag allowlist).

**Path/arg semantics.** Three-way branch:
1. `positional[0]` present → `resolveRoot(arg)` → that workspace (main-dispatch.ts:413-416).
2. no arg, cwd is inside a workspace → that workspace (main-dispatch.ts:417-419).
3. no arg, cwd is NOT in a workspace → **TTY: launches the interactive guided
   front door / setup wizard**; non-TTY: throws the "Not inside an rbox
   workspace" error (main-dispatch.ts:420-424).

Branch 3 is a genuine mode switch: `rbox start` in an untracked directory on a
terminal starts an onboarding wizard, not a daemon (`runGuidedFrontDoor`,
main-dispatch.ts:86-101 → `front-door.ts:55-61`).

**Interactive vs scriptable.** Branches 1 and 2 are fully non-interactive.
Branch 3 is interactive-only and has no non-interactive twin (`rbox init` /
`rbox track` are the scriptable equivalents, but they are different commands).
Note `start` may print `re-run 'rbox start' in a moment` and return without
starting when a previous daemon hasn't exited, or when a live daemon's mode is
not yet witnessed (process-control.ts:264-265, :274) — an agent driving `start`
must poll, and exit code is 0 in those cases.

**Divergences.**
* Usage says `[path]` but never says what no-path means, nor that a path is a
  *workspace locator* (a subdirectory silently means the whole workspace).
* The note describes branch 3 but omits the non-TTY error and the fact that
  branch 3 runs `setup`, not `start`.
* Mode-preservation (bare `start` re-uses the previously recorded `--pull-only`)
  is undocumented; the help reads as if the default were read-write.
* The two retry-later outcomes are undocumented and exit 0.

## stop

**Help entry** — help-registry.ts:141-146. Group `SYNCING`. `summary: "stop
background sync"`, `usage: "rbox stop [path]"`, **no flags, no notes**.

**Implementation** — main-dispatch.ts:427-430 → `stopDaemonAndRecordDesired`
(autostart-cmd.ts:463-483) → `stopDaemon` (process-control.ts:343+).

| arg/flag | semantics |
|---|---|
| `[path]` | workspace locator via `resolveRoot`; extra positionals silently ignored (verified: `rbox stop /tmp /var` uses only `/tmp`) |
| any flag | rejected — allowlist is `{json, help}` only |

**Path/arg semantics.** See HEADLINE above: no-arg = cwd's workspace; never
global. `stopDaemon` sends SIGTERM and waits (60s default), re-reading pidfile
ownership before each signal; it never SIGKILLs (process-control.ts:376-390).
If no pidfile: prints `background sync is not running` and exits 0
(process-control.ts:357-360).

Side effect beyond stopping: it writes `desired.state = "stopped"` so autostart
will not resume it (autostart-cmd.ts:466-482). That durable-intent write is the
reason a logged-out `stop` fails (see HEADLINE).

**Interactive vs scriptable.** Fully non-interactive. Agent-drivable.

**Divergences.**
* Nothing in the help says the scope is one workspace. This is the single
  highest-value divergence in the lane, given Max's reading.
* Undocumented login requirement.
* Undocumented durable side effect (suppresses autostart resume) — `stop` is not
  a symmetric inverse of `start`; it also edits boot policy for that workspace.

## status

**Help entry** — help-registry.ts:87-97. Group **`GETTING STARTED`** (not
`SYNCING`, unlike start/stop/logs/sync). `usage: "rbox status [path] [--json |
--verbose | --git]"`; flags `--json` (print JSON), `--verbose` (complete legacy
status detail), `--git` (per-repository Git deferral detail).

**Implementation** — main-dispatch.ts:368-387 → `statusCmd`
(status-cmd.ts:330-336 → `statusCmdWithDeps`:347).

| arg/flag | parsed at | notes |
|---|---|---|
| `[path]` | :378 | `resolveRoot`; **arity IS checked** here — `positional.length > 1` → `fail("usage: rbox status [path] …")` (:369-372). The only lane command that does this. |
| `--json` | :381 | mutually exclusive with the other two (:373-377) |
| `--verbose` | :382 | |
| `--git` | :383 | valueless for `status`, but `--git <true\|false>` for `init`/`track` — arity is resolved per-command (flags.ts:54-65) |

**Path/arg semantics.** Single workspace only. `rbox status` outside a workspace
errors (verified live). Status reads **only** this workspace's daemon
(`daemonBindingStatus(root, cfg.remoteWorkspaceId)`, status-cmd.ts:358) — it
never enumerates `~/.rbox/daemons`, so it cannot tell you that three other
daemons are running. `rbox autostart status` is the only fleet view.

**Interactive vs scriptable.** Non-interactive; `--json` is the machine twin
(brief/verbose/git renderings are human text). `status` is also the one command
excluded from the update nudge (main-dispatch.ts:176).

**Divergences.**
* Help doesn't say status is workspace-scoped and gives no hint that other
  workspaces' daemons exist.
* `--git` here means "show git deferral detail" while `--git` on `init`/`track`
  means "enable git sync" — same token, unrelated meanings, different arity.
* Grouped under GETTING STARTED though it is the primary daemon-observability
  command.

## init

**Help entry** — help-registry.ts:98-117. Group `GETTING STARTED`.
`summary: "headless/CI onboarding (the scripting form of setup)"`.
`usage: rbox init [--new | --workspace <id>] [--root <path>] [--adopt]
[--respect-gitignore] [--new-device] [--bootstrap <secret>] [--kit]
[--kit-path <path>] [--no-interactive]`. Documented flags also include
`--remote <url>` and `--git <true|false>`.

**Implementation** — main-dispatch.ts:181-185 → `runInit` (init-cmd.ts:191) →
pure planner `resolveInitPlan` (init-plan.ts:126-187) → `executeInitPlan`
(init-cmd.ts:363).

| flag | read at | effect / default |
|---|---|---|
| `--new` | init-plan.ts:131 | create; mutually exclusive with `--workspace` (:132-138) |
| `--workspace <id>` / `-w` | :130 | join |
| `--root <path>` | :169 | default cwd |
| `--project <id>` | :159 | **hidden** (flags.ts:97), default `"root"` |
| `--name <text>` | :163 | **hidden**; server-visible label, create-path only |
| `--remote <url>` | :170 | default = creds' remote, else `DEFAULT_REMOTE` |
| `--git <true\|false>` | :184 | default true |
| `--respect-gitignore` | :185 | default false |
| `--pull-only` | :176 | **hidden** (flags.ts:97); on a join, first sync becomes pull-only |
| `--no-sync` | :176 | **read by the planner but UNREACHABLE from the CLI** — see divergence |
| `--adopt` | init-cmd.ts:224 | retain + overlay local content on a non-empty join |
| `--bootstrap <secret>` | init-plan.ts:147 | headless account creation |
| `--kit` / `--kit-path` | init-cmd.ts:241 | recovery-kit write |
| `--new-device` | init-cmd.ts:242 | mint a fresh device id |
| `--no-interactive` | init-cmd.ts:210 | never prompt |

**Path/arg semantics.** `init` takes **no positional** — the directory comes
from `--root` (default cwd), unlike `track`/`start`/`stop` which take a
positional. No ancestor walk: `--root` is used verbatim (`path.resolve(cwd,
flags.root ?? cwd)`, init-plan.ts:169).

First-sync semantics (init-plan.ts:175-176): new → `push`; join → `sync`;
join + `--pull-only` → `pull`; `--no-sync` → `none`.

**Interactive vs scriptable.** Both. On a TTY without `--no-interactive` it
prompts for new-vs-join, directory, workspace name, and gitignore handling
(`promptMissing`, init-cmd.ts:86-152) and may prompt to confirm adoption
(init-cmd.ts:233-237). Headless requires creds/`--bootstrap`, else it fails with
a copy-pasteable `headlessHint` (init-plan.ts:151-157) — a good scriptable twin.

**Divergences.**
* **`rbox init --no-sync` is rejected as an unknown flag** even though
  `resolveInitPlan` implements it (init-plan.ts:176) and unit tests cover it
  (init-plan.test.ts:75). `unknownFlagError` allows only documented flags plus
  `HIDDEN_FLAGS.init = ["name","project","pull-only"]` (flags.ts:97) — `no-sync`
  is in `HIDDEN_FLAGS.setup` but not `init`. Verified live:
  `✗ rbox: unknown flag --no-sync for 'rbox init'`, exit 1. Dead surface.
* `--pull-only`, `--name`, `--project` work but are undocumented.
* The `--adopt` usage line doesn't mention it is invalid with `--pull-only` /
  `--no-sync` (init-cmd.ts:226-228).
* Summary calls init "the scripting form of setup", but init prompts by default
  on a TTY — the scripting form requires `--no-interactive`.

## adopt

**Help entry** — help-registry.ts:118-127. Group `GETTING STARTED`.
`summary: "inspect or recover a retained non-empty join"`.
`usage: rbox adopt <status|resume|abort|clean> [path] [--json] [--yes]`.

**Implementation** — main-dispatch.ts:191-196 → `adoptCmd` (adopt-cmd.ts:174-214).

| arg/flag | notes |
|---|---|
| `positional[0]` subcommand | must be one of status/resume/abort/clean, else throw (adopt-cmd.ts:179-181) |
| `positional[1]` path | default `process.cwd()` (main-dispatch.ts:194); `positional.length > 2` → usage error (:192) |
| `--json` | status only (adopt-cmd.ts:188) |
| `--yes` | clean only (adopt-cmd.ts:212, :159-165) |

**Path/arg semantics.** Path is resolved by `findAdoptRoot(start)` — a *separate*
ancestor walk for `.rbox/adopt/journal.json`, not `findRoot`
(adopt-cmd.ts:182-183). No journal → `no .rbox/adopt/journal.json found from this path`.

**Interactive vs scriptable.** `status`/`resume`/`abort` are non-interactive.
`clean` prompts via `confirmDestructive({… yes, default:false, headless:"deny"})`
(adopt-cmd.ts:159-165) — headless without `--yes` **denies** and throws
`adoption clean requires explicit confirmation (--yes)`. `--yes` is the
scriptable twin. Good.

**Overlap.** `adopt` is not an onboarding verb despite its GETTING STARTED
group; it is the recovery console for `init --adopt`. Blocks `untrack` while a
journal exists (untrack-cmd.ts:53-55).

## track

**Help entry** — help-registry.ts:242-256. Group `SYNCING`.
`summary: "bind a directory to a workspace (create/join; no first sync)"`.
`usage: rbox track [path] [--workspace <id>] [--respect-gitignore]
[--new-device]`; documented flags also `--remote`, `--git <true|false>`;
note "[path] defaults to the current directory".

**Implementation** — main-dispatch.ts:197-201 → `track` (track-cmd.ts:39-140),
then `printTrackResult` (:143-151).

| flag | read at | notes |
|---|---|---|
| `[path]` positional[0] | track-cmd.ts:45 | `path.resolve(arg ?? cwd)` — **no ancestor walk**; binds exactly that dir |
| `--workspace <id>` / `-w` | :58 | join offline |
| `--project <id>` | :47 | **hidden**, default `"root"` |
| `--name <text>` | :91 | **hidden**, passed to `createRemoteWorkspace` |
| `--device <id>` | :123 | **hidden** device-id override |
| `--no-interactive` | :65 | **hidden**; suppresses the create-or-pick prompt |
| `--remote <url>` | :46 | |
| `--git <true\|false>` | :130 | default true |
| `--respect-gitignore` | :131 | default false |
| `--new-device` | :119 | |

**Path/arg semantics.** Unlike everything else in this lane, `track` does **not**
locate an enclosing workspace — it writes `.rbox/` at the given directory. It
refuses a rebind to a different workspace with `RebindConsentRequiredError`
(:87, :96-98, :111-113).

**Interactive vs scriptable.** On a TTY without `--workspace` it **prompts**
"Track a new workspace, or an existing one?" and may open a workspace picker
(track-cmd.ts:64-84). Non-TTY, or hidden `--no-interactive`, silently takes the
create-new path. Scriptable twin exists but its flag is undocumented.

**Divergences.**
* `--no-interactive` is load-bearing for scripting `track` and is **not in the
  help** (only in `HIDDEN_FLAGS.track`, flags.ts:96). Same for `--name`,
  `--project`, `--device`.
* Help doesn't mention the interactive prompt at all, so `rbox track ~/x` reads
  as a one-shot bind.
* `printTrackResult` (:150) advertises `rbox track <path> --workspace <id>` for
  a second machine, while `init`'s summary (init-cmd.ts:685) advertises
  `rbox init --workspace <id> --root <path>` for the same job.

## untrack

**Help entry** — help-registry.ts:257-263. Group `SYNCING`.
`summary: "stop syncing a directory (local unbind; remote untouched)"`.
`usage: rbox untrack [path] [--force]`; `--force` = "skip the confirmation
prompt and SIGKILL a stuck daemon".

**Implementation** — main-dispatch.ts:202-218 → `untrack` (untrack-cmd.ts:38-96).

| arg/flag | notes |
|---|---|
| `[path]` | `resolveRoot` → **ancestor walk**: `rbox untrack ./src` untracks the whole enclosing workspace |
| `--force` | untrack-cmd.ts:39; skips confirm AND escalates to SIGKILL after a 5s SIGTERM wait (:72-79) |

Sequence: refuse if `.rbox` is a symlink (:45-51) → refuse if an adoption journal
exists (:53-55) → confirm → SIGTERM daemon + wait 5s (:67-81) → guarded
recursive `rm` of `<root>/.rbox` after realpath check (:99-119) → remove
`~/.rbox/daemons/<key>` (:90).

**Interactive vs scriptable.** The confirm is
`confirmDestructive({ default:false, headless:"proceed" })`
(main-dispatch.ts:208-215 + prompt.ts:104-105) — **in any non-interactive
context it proceeds without asking**, no `--force` needed. So a destructive
unbind is the default headless behavior; `--force` is only needed for the
SIGKILL escalation.

**Divergences.**
* Help implies `--force` is how you skip the prompt; headless already skips it
  (prompt.ts:105). Undocumented and mildly alarming.
* Not stated that a subdirectory argument untracks the whole workspace.
* Not stated that it refuses while an adoption journal exists.

## sync

**Help entry** — help-registry.ts:176-186. Group `SYNCING`.
`summary: "sync once (pull, then push)"`.
`usage: rbox sync [path] [--allow-mass-delete] [--pull-only] [--verbose]`.

**Implementation** — main-dispatch.ts:344-352 → `runSyncCommand`
(sync-cmd.ts:74-111).

| flag | effect |
|---|---|
| `[path]` | `resolveRoot` locator; extra positionals ignored |
| `--allow-mass-delete` | sets **both** `allowMassDelete` (pull side) and `allowMassDeletePush` (sync-cmd.ts:82-83); env `RBOX_ALLOW_MASS_DELETE=1` also sets the push side |
| `--pull-only` | runs `pull` only, skips push (sync-cmd.ts:87-94) |
| `--verbose` | per-repo git apply/conflict/defer lines instead of a counter (sync-cmd.ts:19-29) |

**Path/arg semantics.** Whole-workspace, always. `rbox sync ./src` = `rbox sync`
from the workspace root (`findRoot` ancestor walk). Max's proposed
`rbox sync ./src` semantics are **not** what the current path argument does.
Runs under `withWorkspaceSyncMutex` so it serializes against the daemon.

**Interactive vs scriptable.** Non-interactive; no `--json`, so output is human
text only (`summarize`, sync-cmd.ts:46-53). No machine-readable twin — an agent
must parse prose or use `rbox status --json` afterwards. Mass-delete guards fail
closed with the hint `rbox sync --allow-mass-delete` (sync-cmd.ts:84).

**Boundary with push/pull** (other lane): `sync` = `pull` then `push` in one
mutex; `rbox push` (main-dispatch.ts:292-319) and `rbox pull` (:320-343) are the
half-operations, each with its own mutex and its own `--allow-mass-delete`
scoping (push-side consent is deliberately *not* inherited by the 409-recovery
pull, :300-302). `sync --pull-only` and `pull` differ: `sync --pull-only` reports
under the `pull` metrics label and shares sync's dual mass-delete consent.

## logs

**Help entry** — help-registry.ts:165-175. Group `SYNCING`.
`usage: rbox logs [path] [--follow] [--limit N]`; flags `--follow` (alias `-f`),
`--limit N` (default 50), `--lines N` (alias `-n`).

**Implementation** — main-dispatch.ts:435-441 → `logsDaemon`
(`daemon/log-reader.ts:247`).

| flag | parsed at | notes |
|---|---|---|
| `[path]` | :439 | `resolveRoot` locator |
| `--follow` / `-f` | :436, flags.ts:5 | |
| `--limit N` | :437 | |
| `--lines N` / `-n` | :437, flags.ts:6 | `flags.limit ?? flags.lines` — `--limit` wins if both given |
| value validation | :438 | non-integer or negative silently falls back to `DEFAULT_LOG_LINES = 50` (log-reader.ts:61); `--limit 0` is accepted and prints nothing |

**Path/arg semantics.** One workspace's log dir. Outside a workspace: the
standard "Not inside an rbox workspace" error (verified live). With no log file
and no `--follow`, prints `(no daemon log yet — start background sync with
'rbox start')` and returns (log-reader.ts:272-275).

**Interactive vs scriptable.** Non-follow is fully scriptable. `--follow` is a
long-running tail that ends on SIGINT/SIGTERM (log-reader.ts:280-282) or when the
daemon generation changes (`lifecycleMatches`, :284) — drivable by an agent, but
only with an external timeout. Output is plain text; no `--json`.

**Divergences.**
* `--lines`/`-n` documented as an alias, but `--limit` silently wins on conflict.
* Invalid `--limit` values are silently ignored rather than rejected.
* Not stated that logs are per-workspace, nor that `--follow` self-terminates on
  daemon restart.

## autostart enable / disable / status

**Help entries** — help-registry.ts:147-164, three separate entries in `SYNCING`:
`autostart enable` ("resume background sync after login"), `autostart disable`
("disable login resume"), `autostart status` ("show autostart state"). Usage
strings take no args and declare no flags. There is **no bare `autostart`
entry**, so `rbox autostart` → `fail("usage: rbox autostart <enable | disable |
status>")` (autostart-cmd.ts:726, verified live); `rbox autostart --help`
renders all three via the `helpFor` prefix match (help-registry.ts:611).

**Implementation** — main-dispatch.ts:431-434 → `autostartCmd(positional[0])`
(autostart-cmd.ts:716-728). Only `positional[0]` is read; extras ignored.

| subcommand | what it does |
|---|---|
| `enable` | macOS: writes `~/Library/LaunchAgents/to.rbox.daemon.plist` + `launchctl load -w` (:645-651). Linux: writes `~/.config/systemd/user/rbox.service` + `daemon-reload` + `enable` (:654-658). Both run `<rbox binary> __boot-resume`, resolved from `process.execPath` realpath with a fallback to `~/.rbox/bin/rbox` (:612-628). Other platforms throw (:597-600). |
| `disable` | unload/disable + remove the unit; prints "autostart disabled; desired state kept" (:661-677, :722) |
| `status` | prints enabled/disabled, credential degradation, then **every** workspace row from `~/.rbox/daemons/*/desired.json` with status `running`/`stopped`/`stale`/`mismatch` (:685-714) |

**Path/arg semantics.** No path argument anywhere. `autostart status` is the
**only fleet-wide view in the CLI** and works from outside any workspace
(verified live: prints `autostart: disabled` / `workspaces: none`).

**Interactive vs scriptable.** All three fully non-interactive. But `autostart
status` has **no `--json`** — the fleet listing is human-formatted only
(`${status.padEnd(8)} ${rootPath} (…)`, :702), so an agent has to scrape it.

What "running" means here: it is the *desired* state written by `start`/`stop`,
not liveness. `stale` = root or `.rbox/workspace.json` missing (:529-533);
`mismatch` = workspace id or account id no longer matches (:544-561).

**Divergences.**
* Help gives no hint that `autostart status` lists every workspace on the
  machine, i.e. that it is the answer to "what daemons are running?" (and that
  it reports *desired*, not observed, state).
* The `stale`/`mismatch` statuses are undocumented.
* On Linux, `status` may emit a `loginctl enable-linger` note (:706-713) that is
  not mentioned in help.
* `disable` keeps desired state, so re-enabling silently resumes every
  previously-running workspace — undocumented.

## link (deprecated alias)

**Help entry** — help-registry.ts:593: `{ name: "link", group: "SYNCING",
summary: "deprecated → rbox track", usage: "rbox link <path>", hidden: true,
alias: "track" }`.

**Implementation** — pure rewrite in `resolveAlias` (deprecations.ts:26-47):
`link` → `track`, positionals pass through unchanged, notice
`note: 'rbox link' is now 'rbox track'.` on **stderr** (main-dispatch.ts:151-158).

Notes: help rendering deliberately does **not** resolve the alias — `rbox link
--help` shows the alias block plus a yellow `deprecated: use 'rbox track'` line
(help-registry.ts:620-624, renderCommand :634). Flag parsing **does** resolve it,
so `rbox link --git false <path>` parses with `track`'s arity (flags.ts:54-56,
comment at :50-53). Slated for removal at v0.3 (deprecations.ts:4).

**Divergence.** Alias usage says `rbox link <path>` (required) while the target
`track` takes `[path]` (optional, defaults to cwd) — bare `rbox link` works.

## daemon (deprecated alias)

**Help entry** — help-registry.ts:594: `{ name: "daemon", summary: "deprecated →
rbox start/stop/logs", usage: "rbox daemon <start|stop|status|logs>", hidden:
true, alias: "start" }`.

**Implementation** — deprecations.ts:48-56:

| invocation | rewrites to | notice (stderr) |
|---|---|---|
| `daemon start [args]` | `start [args]` | `note: 'rbox daemon …' is now 'rbox start/stop/logs'.` |
| `daemon stop [args]` | `stop [args]` | same |
| `daemon logs [args]` | `logs [args]` | same |
| `daemon status [args]` | `status [args]` | `note: daemon status is now part of 'rbox status'.` |
| `daemon <anything else>` / bare `daemon` | stays `daemon` → falls to `default:` → essential help, **exit 0** (`daemon` is in `KNOWN_TOP_LEVEL`, command-catalog.ts:30-36) | rename notice |

All verified live.

**Divergences.**
* `alias: "track"`-style single-target metadata is wrong for `daemon`: the
  registry records `alias: "start"`, so `flags.ts`'s `resolveCommandAlias`
  parses `rbox daemon stop …` / `rbox daemon logs -n 5` against **`start`'s**
  flag arity, not the actual target's (flags.ts:55). `-n` still works (short
  flags are global, flags.ts:3-8), but `--limit`'s arity for `daemon logs` comes
  from the union fallback, not from `logs`.
* Bare `rbox daemon` / an unknown subcommand prints the top-level help and exits
  **0**, so a script cannot detect the mistake.
* The alias name `daemon` is the only place in the CLI that names the concept
  Max expected `start`/`stop` to control — and it forwards to per-workspace
  commands.

## Overlap summary: init vs adopt vs track vs link vs setup

| command | binds `.rbox/` | creates/joins remote workspace | first sync | prompts by default | notes |
|---|---|---|---|---|---|
| `setup` | yes (via init) | yes | yes | yes (guided) | the human front door |
| `init` | yes | yes (`--new`/`--workspace`) | yes (push/sync/pull) | yes on TTY unless `--no-interactive` | directory via `--root`, no positional |
| `track` | yes | yes (creates, or joins with `--workspace`) | **no** | yes on TTY unless hidden `--no-interactive` | positional path; "bind only" |
| `link` | — | — | — | — | pure alias of `track` |
| `adopt` | only via journal replay (adopt-cmd.ts:93-112) | no | resumes the join's sync | only `clean` | recovery console for `init --adopt` |
| `untrack` | removes it | no (remote untouched) | n/a | headless auto-proceeds | inverse of `track` |

The real difference between `init` and `track` is exactly one thing: **whether a
first sync runs**. Both create-or-join, both write the same `WorkspaceConfig`
shape (init-cmd.ts:454-469 vs track-cmd.ts:114-135), both resolve the device id
through the same `resolveWorkspaceDeviceId`. They differ in argument style
(`--root` vs positional), in which flags are documented, and in prompt copy
("New workspace, or join an existing one?" init-cmd.ts:107 vs "Track a new
workspace, or an existing one?" track-cmd.ts:69).

There is no `unsync`. The pairing Max suggested (`sync`/`unsync`) currently maps
onto four verbs with different scopes: `track` (bind), `start` (background on),
`stop` (background off, one workspace), `untrack` (unbind + delete `.rbox`).

## Divergence index (highest value first)

1. `rbox stop` with no arg stops only the cwd's workspace daemon, and outside a
   workspace stops nothing at all — contradicting the founder's stated model.
   main-dispatch.ts:427-429, :71-75.
2. No command stops (or lists liveness for) all daemons. `autostart status` is
   the only enumeration and reports *desired* state, in human-only format.
   autostart-cmd.ts:685-714.
3. `[path]` on start/stop/status/sync/logs/untrack is an ancestor-walk locator,
   so a subdirectory argument silently means the whole workspace.
   workspace-config.ts:107-119.
4. `rbox init --no-sync` is rejected as unknown though implemented and tested.
   flags.ts:97 vs init-plan.ts:176.
5. `rbox stop`/`rbox start` fail when logged out, even with a live daemon.
   autostart-cmd.ts:176-180.
6. `stop` durably suppresses autostart resume; `disable` durably keeps it —
   neither documented. autostart-cmd.ts:466-482, :722.
7. `untrack` auto-proceeds (no confirmation) in any non-interactive context;
   help attributes that to `--force`. prompt.ts:104-105.
8. `track`'s scripting escape hatch `--no-interactive` is undocumented, as are
   `--name`, `--project`, `--device`. flags.ts:96.
9. Bare `start` preserves the previous `--pull-only` mode; help implies a fixed
   default. autostart-cmd.ts:230-242.
10. `rbox daemon` (bare/unknown sub) prints top-level help and exits 0;
    `daemon logs`/`daemon stop` parse flags against `start`'s arity.
    command-catalog.ts:30-36, flags.ts:55.
11. Only `status` validates positional arity; `start`/`stop`/`sync`/`logs`
    silently ignore extra positionals. main-dispatch.ts:369 vs :413, :428.
12. `--git` means "git deferral detail" on `status` but "enable git sync" on
    `init`/`track`. help-registry.ts:95 vs :115, :252.
13. `sync` and `logs` have no `--json`; agents must scrape prose.
14. `logs --limit` silently overrides `--lines` and silently ignores invalid
    values. main-dispatch.ts:437-438.


---

# Lane 3 — data movement & history commands

Scope: `push`, `pull`, `export`, `ignore`, `versions`, `restore`, `trash list|restore|empty`, `git deferrals`, `git resolve`.

Shared machinery referenced throughout:

- Help registry: `src/cli/help-registry.ts` (`COMMAND_HELP`, line 49). Groups are only `GETTING STARTED | SYNCING | DEPENDENCIES | DEVICES & ACCOUNT | BILLING & MAINTENANCE` (`help-registry.ts:16-21`). **Every command in this lane is in `SYNCING`** — there is no data/history group.
- Dispatcher: `src/cli/main-dispatch.ts` — one `switch (cmd)` (line 180).
- Flag parsing: `src/cli/flags.ts:67` `parseFlags`. Flag *arity* is derived from the help registry's flag strings (`--foo <bar>` = takes a value, `--foo` = boolean), per-command, `flags.ts:54-65`. Unknown flags are rejected by `unknownFlagError` (`flags.ts:101`) — but `json` and `help` are **always allowed for every command** (`flags.ts:104`), even commands that ignore them.
- Short flags, global: `-f`→follow, `-n`→lines, `-y`→yes, `-w`→workspace (`flags.ts:3-8`). These apply to *any* command, not just the ones that document them.
- **Positional args are never arity-checked** except where a command explicitly counts them. Most commands in this lane silently ignore extra positionals.
- Workspace location helpers (`main-dispatch.ts:71-81`):
  - `resolveRoot(arg)` — `findRoot(arg ?? cwd)`; walks *up* from the path to the workspace root.
  - `resolvePathFlagRoot(flags.path)` — same, but keyed off `--path`. Note: `--path` is documented as "workspace root" in help but the code accepts **any directory inside the workspace** and walks up.

---

## push

**Help entry** (`help-registry.ts:213-219`)

| field | value |
|---|---|
| name | `push` |
| group | `SYNCING` |
| summary | "upload local changes" |
| usage | `rbox push [path] [--allow-mass-delete]` |
| hidden/alias | no |

**Implementation**: dispatcher case at `main-dispatch.ts:292-319`; engine entry `push()` from `src/cli/sync.ts` (re-export of `src/cli/sync/push.ts`).

| arg/flag | parsed at | semantics |
|---|---|---|
| `[path]` positional[0] | `main-dispatch.ts:293` | optional; `resolveRoot(positional[0])` → workspace root containing that path. **Defaults to cwd.** Extra positionals silently ignored. |
| `--allow-mass-delete` | `main-dispatch.ts:302` | boolean; sets `deps.allowMassDeletePush` only |
| env `RBOX_ALLOW_MASS_DELETE=1` | `main-dispatch.ts:302` | equivalent to the flag |
| `--json` | accepted by parser, never read | `commandSupportsFlag` is false, so `flags.json` is forced to `"false"` (`main-dispatch.ts:162`); push has no JSON output |

Runs under `withWorkspaceSyncMutex` (`main-dispatch.ts:296`). Progress is a spinner (`spinner("pushing")`); on success prints either "pushed … sequence N" or "already in sync". Case-collision warnings via `summarizeCaseCollisions` (`:311`).

**Path semantics**: implicit-cwd, path-anchored-but-workspace-scoped. `rbox push src/` pushes the **whole workspace**, not `src/` — the arg only *locates* the workspace. This is the exact ambiguity Max flagged; nothing in the help text says it.

**Interactive vs scriptable**: fully non-interactive. The push-side mass-delete guard *throws* (`src/cli/sync/push.ts:704-709`) rather than prompting, and names both the flag and the env var.

**Divergences**
- Help lists `--allow-mass-delete` as push-only consent and does mention the env var — accurate.
- Push does **not** accept `--verbose` (pull does). `rbox push --verbose` is a hard error via `unknownFlagError`.
- Push does not attach git-sync progress (`attachGitSyncProgress` is pull-only, `main-dispatch.ts:328`), so git-repo apply/defer lines never appear on push.

---

## pull

**Help entry** (`help-registry.ts:220-229`)

| field | value |
|---|---|
| name | `pull` · group `SYNCING` |
| summary | "apply remote changes" |
| usage | `rbox pull [path] [--allow-mass-delete] [--verbose]` |

**Implementation**: `main-dispatch.ts:320-343`; `pull()` from `src/cli/sync.ts`.

| arg/flag | parsed at | semantics |
|---|---|---|
| `[path]` positional[0] | `:321` | optional, implicit cwd, same walk-up behavior as push |
| `--allow-mass-delete` | `:329` | sets `deps.allowMassDelete` (pull-side guard, `src/cli/sync/pull.ts:276`) |
| `--verbose` | `:328` | per-repo git apply/conflict/defer lines instead of a running count |
| `--json` | forced to `"false"`, no JSON output | |

Post-run: `summarize("pulled", …)` then `postSyncNudge` (dependency-drift notice, `:336`).

**Divergence (asymmetry)**: `push` honors `RBOX_ALLOW_MASS_DELETE=1`; **`pull` does not** (`main-dispatch.ts:329` reads only the flag, vs `:302` which also reads the env). The two guards are deliberately separate fields (`src/cli/sync/deps.ts:105-112`), but the env-var escape hatch exists on only one side and no help text says so.

**Interactive vs scriptable**: fully non-interactive; the pull-side mass-delete guard throws.

---

## export

**Help entry** (`help-registry.ts:230-241`)

| field | value |
|---|---|
| name | `export` · group `SYNCING` |
| summary | "export decrypted files" |
| usage | `rbox export [--all \| --workspace <id>] [--out <dir \| file.tar.gz>]` |

**Implementation**: dispatcher `main-dispatch.ts:353-367`; `runExport` at `src/cli/export-cmd.ts:360`.

| arg/flag | parsed at | semantics |
|---|---|---|
| **no positionals at all** | — | `main-dispatch.ts:353-367` never reads `positional`. `rbox export ~/somewhere` **silently ignores the path**. |
| `--all` | `export-cmd.ts:361` | boolean. Used *only* to reject `--all` + `--workspace` (`:364`). All-workspaces is already the default, so `--all` is a no-op. |
| `--workspace <id>` / `-w <id>` | `export-cmd.ts:362-363` | export exactly one workspace; valueless `--workspace` is a hard error |
| `--out <path>` | `:365-366` | dir or `*.tar.gz` (case-insensitive suffix, `:66`); valueless is a hard error. `~` expansion at `:49-53`. |
| default `--out` | `export-cmd.ts:41-47` | `<Downloads or $HOME>/rbox-export-<accounthex16>-<YYYY-MM-DD>` — `defaultKitTargetDir` falls back to `$HOME` if `~/Downloads` is missing (`recovery-kit.ts:122-125`). Help says "default: ~/Downloads", which is only the common case. |

**Global, not path-scoped.** This is the only command in the lane that operates on the **account** (every workspace on the account via `fetchAccountWorkspaces`, `export-cmd.ts:378`), not on a workspace located from cwd. The dispatcher does look up a local workspace, but only to take that workspace's sync mutex (`main-dispatch.ts:355-356`) and to refuse while an adoption fence is active (`:358-363`).

Safety behavior worth noting for the inventory: it refuses to overwrite an existing target (`export-cmd.ts:112-120`), refuses to write **inside** any rbox workspace (`:122-127`), refuses if this machine has no encryption key (`:205-207`), and refuses on export-subdir name collisions (`:224-229`). Tarball mode shells out to system `tar` and errors if absent (`:334-346`).

**Interactive vs scriptable**: fully non-interactive; spinner only.

**Naming/grouping observation**: `export` sits under `SYNCING` next to `push`/`pull`, but it neither syncs nor touches the workspace — it's a whole-account decrypted dump to `~/Downloads`. Its `--workspace <id>` selector is an id, not a path, unlike every other command in the group.

---

## ignore

**Help entry** (`help-registry.ts:264-278`)

| field | value |
|---|---|
| name | `ignore` · group `SYNCING` |
| summary | "manage .rboxignore" |
| usage | `rbox ignore <glob> \| --list \| --respect-gitignore <on\|off> \| --purge [--yes] [--path <dir>]` |

**Implementation**: dispatcher `main-dispatch.ts:442-449`; `src/cli/ignore-cmd.ts`.

Dispatch is a strict if/else-if chain — **flags shadow each other and shadow the positional**:

```
main-dispatch.ts:444  if --respect-gitignore present   → setRespectGitignore
:445  else if --purge                                  → purgeIgnored
:446  else if --list  OR positional.length === 0       → listIgnoreRules({ full: --list })
:447  else                                             → addIgnorePattern(positional[0])
```

| arg/flag | parsed at | semantics |
|---|---|---|
| `<glob>` positional[0] | `:447` | only reached when no mode flag is set. positional[1..] ignored (`ignore-cmd.ts:17` takes one pattern). |
| `--path <dir>` | `:443` | any dir inside the workspace (help says "workspace root"); no positional path form |
| `--list` | `:446` | full rule dump; **without it, bare `rbox ignore` also lists** but collapses builtins to a count (`ignore-cmd.ts:51-57`) |
| `--respect-gitignore <on\|off>` | `:444` | writes `cfg.respectGitignore` |
| `--purge` | `:445` | dry-run preview, confirm, then push a manifest with the ignored paths deleted |
| `--yes` / `-y` | `:445` | required for `--purge` in headless mode |
| `--allow-mass-delete` | `:445` | sets `allowMassDeletePush` for the purge push (`ignore-cmd.ts:104`) |

**Path/arg semantics**: no positional path; workspace comes from cwd or `--path`. The single positional is a *glob*, not a path — the only command in this lane where positional[0] is not a path.

**Interactive vs scriptable**: only `--purge` prompts (`ignore-cmd.ts:83-89`, `confirmDestructive` with `headless: "require-yes"`). Non-interactive twin exists: `--yes`. Headless without `--yes` throws "refusing headless purge without --yes" — clean fail-closed. All other modes are non-interactive.

**Divergences / findings**
1. `rbox ignore --respect-gitignore` with **no value** silently turns it **ON**. Arity for this command marks the flag as value-taking (`flags.ts:54-65` from `--respect-gitignore <on|off>`), so with nothing following it the value becomes the literal `"true"` (`flags.ts:83`), and `parseOnOff("true")` returns `true` (`ignore-cmd.ts:152-156`). Help's `<on|off>` implies the value is required; `setRespectGitignore`'s own usage error (`ignore-cmd.ts:63`) is unreachable in that case.
2. `rbox ignore 'dist/**' --list` prints the list and **never adds the pattern** — no error, no warning (`main-dispatch.ts:446` wins).
3. `rbox ignore 'dist/**' --purge` likewise ignores the glob.
4. Help usage does not show the bare `rbox ignore` (no-args) form, which is valid and prints a condensed rule list.
5. `--allow-mass-delete` is documented under `ignore` but only has effect on the `--purge` branch.

---

## versions

**Help entry** (`help-registry.ts:307-318`)

| field | value |
|---|---|
| name | `versions` · group `SYNCING` |
| summary | "list version history (or a file's change history)" |
| usage | `rbox versions [file] [--limit <n>] [--json]` |
| notes | "[file] is a path INSIDE the current directory's workspace (it scopes history to that file); unlike other commands, it does not locate the workspace." |

**Implementation**: dispatcher `main-dispatch.ts:476-496`; `versionsCmd` at `src/cli/versions-cmd.ts:35`.

| arg/flag | parsed at | semantics |
|---|---|---|
| `[file]` positional[0] | `main-dispatch.ts:493` | optional. `.` or a path resolving to the workspace root → treated as "whole workspace". Otherwise passed through as a **file scope**, not a workspace locator. |
| `--limit <n>` | `:483-489` | must be a positive integer; `--limit` with no value (`"true"`), `0`, negatives, and non-integers all `fail(usage)` and exit 1. Default `DEFAULT_LIMIT = 50` (`versions-cmd.ts:18`). |
| `--json` | `:494` | `{ versions: [{ sequence, committedAt, path }] }` (`versions-cmd.ts:47`, `:68`) |

**Path semantics — the notable one**: the workspace is resolved from **cwd only** — `resolveRoot(undefined)` at `main-dispatch.ts:490`. The positional is *not* used to find the workspace, unlike `push`/`pull`/`status`. Help calls this out explicitly, which is itself an admission that this command breaks the lane's convention.

**Finding (silent wrong answer)**: the path argument is normalized by `toRelPath` (`versions-cmd.ts:23-27`) and matched against manifest paths, which are **workspace-root-relative**. But the user types it relative to cwd. Running `rbox versions app.ts` from `<root>/src` queries history for `<root>/app.ts`, and reports "no changes to app.ts in the last 50 versions (or the file is unknown here)" (`versions-cmd.ts:51`) — indistinguishable from a real empty history. Only the root-equality check at `main-dispatch.ts:493` uses `path.resolve` (cwd-relative); the scoping path does not.

**Interactive vs scriptable**: fully non-interactive, with `--json`.

---

## restore

**Help entry** (`help-registry.ts:319-329`)

| field | value |
|---|---|
| name | `restore` · group `SYNCING` |
| summary | "restore a file from a past version" |
| usage | `rbox restore <file>@<seq>` |
| flags | **none declared** |
| notes | "<file> is resolved inside the current directory's workspace." / "restores from synced version history — for files rbox moved to the local trash, see `rbox trash restore`" |

**Implementation**: dispatcher `main-dispatch.ts:497-507`; `restoreCmd` at `src/cli/versions-cmd.ts:82`.

| arg/flag | parsed at | semantics |
|---|---|---|
| `<file>@<seq>` positional[0] | `:502-503` | **required**; missing → throws the usage string. Split on the **last** `@` (`versions-cmd.ts:83`), so paths containing `@` work. `<seq>` must be a positive integer (`:87`). |
| extra positionals | — | silently ignored |
| flags | none | `--json` is accepted by the parser but unused; **any other flag is a hard error** (`flags.ts:101-112`, allowed set = `{json, help}`) |

Runs under `withWorkspaceSyncMutex` (`main-dispatch.ts:505`). Workspace root from **cwd only** (`resolveRoot(undefined)`, `:504`) — same non-locating behavior as `versions`, and the same cwd-vs-root-relative hazard (`versions-cmd.ts:85`).

Behavior details worth recording: if the target file currently exists, the previous copy is moved to the **local trash** before the restore, and the CLI prints an undo hint pointing at `rbox trash restore` (`versions-cmd.ts:108-118`). Restoring writes a *local change*; publishing requires a separate `rbox push`/`rbox sync` (`:119`). Aged-out sequences produce a retention-window error (`:96-98`).

**Interactive vs scriptable**: fully non-interactive. **No `--json`** despite `versions --json` producing the sequence numbers it consumes — an agent can enumerate versions as JSON but must parse prose to confirm the restore.

---

## trash list

**Help entry** (`help-registry.ts:279-288`)

| field | value |
|---|---|
| name | `trash list` · group `SYNCING` |
| summary | "list files rbox moved to the local trash" |
| usage | `rbox trash list [--path <dir>] [--json]` |

**Implementation**: dispatcher `main-dispatch.ts:450-456` (single `case "trash"`); `trashCmd` at `src/cli/trash-cmd.ts:14`, sub-dispatch at `:15-25`.

| arg/flag | parsed at | semantics |
|---|---|---|
| sub-verb positional[0] | `trash-cmd.ts:15` | **defaults to `list`** — bare `rbox trash` lists. Not documented anywhere in help (there is no bare `trash` registry entry). |
| `--path <dir>` | `main-dispatch.ts:452` | workspace locator; no positional path form |
| `--json` | `trash-cmd.ts:17,34` | `{ entries: [{path, deletedAt, size, batch}], totalBytes }` (`:37-45`) |

`deletedAt` is reverse-engineered from the batch directory name (`trash-cmd.ts:27-32`) and is `null` when the name doesn't match the timestamp shape.

**Note**: the essential help screen advertises a bare `trash` entry — "list/restore files rbox moved aside" (`help-registry.ts:683`) — but `COMMAND_HELP` has no `trash` entry; `rbox help trash` works only through the prefix match in `helpFor` (`help-registry.ts:611`).

---

## trash restore

**Help entry** (`help-registry.ts:289-299`)

| field | value |
|---|---|
| name | `trash restore` · group `SYNCING` |
| summary | "restore a trashed file back into the workspace" |
| usage | `rbox trash restore <path> [--batch <name>] [--path <dir>]` |
| notes | "restores files rbox itself moved to the local trash — to fetch an older synced version, see `rbox restore`" |

**Implementation**: `trash-cmd.ts:19` → `trashRestore` at `:61`; engine `restoreFromTrash` at `src/engine/trash.ts:235`.

| arg/flag | parsed at | semantics |
|---|---|---|
| `<path>` positional[1] | `trash-cmd.ts:19` | **required**; missing → throws usage (`:62`). Workspace-root-relative, validated by `assertSafeRel` (`engine/trash.ts:236`) — same cwd-vs-root-relative hazard as `restore`/`versions`. |
| `--batch <name>` | `trash-cmd.ts:19` | selects one batch; default is **newest-first across all batches** (`engine/trash.ts:237-239`) |
| `--path <dir>` | `main-dispatch.ts:452` | workspace locator |
| `--json` | not read | help declares `--json` only on `trash list`; `flags.json` is force-set to `"false"` for `trash restore` (`main-dispatch.ts:160-162`) since `commandSupportsFlag` keys on `trash restore` |

Never overwrites: if the destination is occupied it lands at a conflict-copy name and says so (`trash-cmd.ts:66-70`, engine `:248-258`). Failures print to stderr with a non-zero exit and no stack trace (`:72-74`).

---

## trash empty

**Help entry** (`help-registry.ts:300-306`)

| field | value |
|---|---|
| name | `trash empty` · group `SYNCING` |
| summary | "permanently delete trashed files (frees disk)" |
| usage | `rbox trash empty [--path <dir>]` |

**Implementation**: `trash-cmd.ts:21` → `trashEmpty` at `:77`; `pruneTrash(root, { days: 0, maxBytes: 0 })`.

| arg/flag | semantics |
|---|---|
| positionals beyond `empty` | ignored |
| `--path <dir>` | workspace locator |
| no confirmation flag | — |

**Finding**: `trash empty` is destructive and **has no confirmation prompt and no `--yes`** — it deletes immediately. Contrast `ignore --purge` and `untrack`, which both confirm. It is not a full wipe either: the engine protects the in-progress `.active` batch and anything younger than a 15-minute floor (`trash-cmd.ts:78-80`), so "empty" can legitimately report "nothing to empty" while `trash list` still shows files (`:82`).

---

### Overlap note: `versions`/`restore` vs `trash *`

From the code, these are two unrelated recovery planes, and the only thing tying them together is prose in the help notes (`help-registry.ts:298`, `:326`):

| | source of truth | scope | network | mutex |
|---|---|---|---|---|
| `versions` / `restore` | the **remote** signed commit chain, KEK-decrypted per epoch (`versions-cmd.ts:9-16`) | one file at one sequence | yes (`buildAuthedRemote`) | `restore` only (`main-dispatch.ts:505`) |
| `trash list/restore/empty` | the **local** `.rbox` trash tier written by the pull writer (`trash-cmd.ts:1-8`) | files rbox itself moved aside during a pull | no | none |

`restore` feeds `trash`: an overwritten file is trashed first, and the undo instruction printed is `rbox trash restore <path>` (`versions-cmd.ts:117`). So the two verbs named `restore` do different things, one is a top-level command and the other a subcommand, and one is the undo of the other.

---

## git deferrals

**Help entry** (`help-registry.ts:187-197`)

| field | value |
|---|---|
| name | `git deferrals` · group `SYNCING` |
| summary | "show deferred Git repos and copyable repair guidance" |
| usage | `rbox git deferrals [--brief \| --json]` |
| notes | "Run from anywhere inside the workspace; no repository argument is accepted." |

**Implementation**: dispatcher `main-dispatch.ts:525-537`; `gitDeferralsCmd` at `src/cli/git/deferrals-command.ts:84`.

| arg/flag | parsed at | semantics |
|---|---|---|
| positionals | `:528` | **exactly one** (`deferrals` itself). Any repo argument → `fail(usage)`, exit 1. |
| `--brief` | `:534` | full copyable diagnosis/repair brief (markdown-escaped fields, `deferrals-command.ts:37-40`) |
| `--json` | `:534` | `{ schemaVersion: 1, deferrals: [...] }` (`deferrals-command.ts:102-105`) |
| `--brief` + `--json` together | `:528` | rejected with the usage line |

Workspace root from **cwd only** (`resolveRoot(undefined)`, `:532`). Exit code: `0` for both "no deferred repos" and "N deferred repos"; `1` only on an internal error (config/state read failure, `deferrals-command.ts:140-142`). This command is also specifically excluded from the upgrade nudge so its output stays machine-parseable (`main-dispatch.ts:175-177`).

The `--brief` output embeds ready-to-paste `cd <root> && rbox git resolve …` commands, including a literal `<token-printed-by-show-me>` placeholder (`deferrals-command.ts:73-81`, `:132-135`).

**Interactive vs scriptable**: fully non-interactive, three output modes (default list / `--brief` / `--json`).

**Naming observation**: `git deferrals` is a **read-only status view** grouped under `SYNCING` alongside mutating verbs, and it is a sibling of `rbox status --git` (`help-registry.ts:95`), which shows overlapping per-repository deferral detail.

---

## git resolve

**Help entry** (`help-registry.ts:198-212`)

| field | value |
|---|---|
| name | `git resolve` · group `SYNCING` |
| summary | "inspect or resolve a deferred Git checkout" |
| usage | `rbox git resolve <repo> [show-me\|take-theirs\|keep-mine] [--json] [--confirm <token>] [--force-discard-incoming]` |
| notes | "The default verb is show-me." / "take-theirs quarantines and pins local Git work before following incoming metadata; working files are not rewritten." |

**Implementation**: dispatcher `main-dispatch.ts:538-552`; `gitResolveCmd` at `src/cli/git/resolve-command.ts:520` (1065 lines); output rendering in `src/cli/git/resolve-presentation.ts`.

### Args and flags

| arg/flag | parsed at | semantics |
|---|---|---|
| `<repo>` positional[1] | `main-dispatch.ts:538` | **required**. Two jobs at once: (a) `resolveRoot(repo)` walks *up* from it to find the workspace (`:544`); (b) `normalizedRepo(root, repoArg)` resolves it against **cwd** and re-expresses it workspace-root-relative, rejecting anything outside (`resolve-command.ts:192-198`). Workspace root itself normalizes to `"."`. |
| verb positional[2] | `:539-540` | optional; **default `show-me`**. Must be one of `show-me\|take-theirs\|keep-mine`; anything else → `fail(usage)`. |
| total positionals | `:540` | `> 3` → usage failure |
| `--json` | `:547` | typed JSON; all 40-hex commit OIDs are replaced with `[commit]` except the `snapshot` token (`resolve-command.ts:328-331`) |
| `--confirm <token>` | `:548` | the snapshot token printed by the previous run |
| `--force-discard-incoming` | `:549` | keep-mine only; must exactly match the report's `forceRequired` (see below) |

All output — human and JSON — passes through `safeResolveOutput`, which strips terminal control sequences, rewrites the absolute workspace root to `.`, and redacts URL credentials / `authorization|bearer|token|api_key|password|secret` values (`resolve-presentation.ts:95-111`).

### Interactive vs scriptable — the whole branch map

**There is no TTY prompt anywhere in this command.** No `confirmDestructive`, no `prompt`, no `isTTY` check in `resolve-command.ts` or `resolve-presentation.ts`. Confirmation is a **snapshot-token protocol**, not an interactive one, and every branch has a non-interactive form. What it *is* is inherently **multi-round**: an agent must run, parse a token out of the output, and re-run.

Every terminal branch, its exit code, and whether it is machine-drivable:

| # | branch | code path | exit | JSON `status` | non-interactive twin |
|---|---|---|---|---|---|
| 1 | repo arg outside workspace | `:531-535` | 1 | `refused`/`operation-failed` | n/a |
| 2 | journal recovery needed / repo unreadable | `:563-570` | 1 | `refused`/`journal-recovery` | yes — retry after sync |
| 3 | nothing deferred / no KEK | `:574-583` | 1 | `refused`/`no-incoming` | yes |
| 4 | keep-mine with git sync disabled | `:584-587` | 1 | `refused`/`unsupported` | yes |
| 5 | keep-mine while git is busy | `:588-591` | 1 | `refused`/`git-busy` | yes |
| 6 | keep-mine with in-progress op state | `:596-599` | 1 | `refused`/`local-operation` | yes |
| 7 | keep-mine, incoming branch owned by another worktree | `:600-610` | 1 | `refused`/`worktree-ownership` | yes |
| 8 | take-theirs P-artifact preflight hold | `:612-622` | 1 | `refused`/`artifact` | yes |
| 9 | **`show-me`** — prints snapshot + token | `:655-658` | **0** | `show-me` | **yes, `--json`** |
| 10 | keep-mine, comparison indeterminate | `:661-669` | 1 | `refused`/`proof-indeterminate` | yes |
| 11 | keep-mine, publisher branch deleted locally | `:707-713` | 1 | `refused`/`conflict` | yes |
| 12 | keep-mine, current branch diverged both sides | `:715-725` | 1 | `refused`/`conflict` | yes — but resolution requires git merge/rebase by hand |
| 13 | **keep-mine preview** (no `--confirm`) | `:726-735` | **1** | `preview` | yes — token in `confirm.snapshot` |
| 14 | keep-mine `--confirm` token stale | `:736-739` | 1 | `snapshot-mismatch` | yes — re-read fresh token |
| 15 | keep-mine `--force-discard-incoming` mismatch | `:740-751` | 1 | `preview` (again) | yes — `confirm.forceDiscardIncoming` says which |
| 16 | lock degraded | `:752-755`, `:881-884` | 1 | `refused`/`mutex-degraded` | yes |
| 17 | keep-mine boundary re-check failures (binding changed, git became busy, op started, worktree took the branch, discard decision changed) | `:759-801` | 1 | `snapshot-mismatch` / `refused` | yes — retry |
| 18 | **keep-mine published** | `:819-821` | **0** | `published` (+ `sequence`) | yes |
| 19 | keep-mine ack uncertain | `:823-831` | 1 | `ack-uncertain` | yes — run `push`/`pull` |
| 20 | keep-mine refused at publish | `:832-865` | 1 | `snapshot-mismatch`/`refused` | yes |
| 21 | take-theirs proof indeterminate | `:867-870` | 1 | `refused`/`proof-indeterminate` | yes |
| 22 | **take-theirs without `--confirm`, or stale token** | `:871-880` | **1** | `snapshot-mismatch`, message `"--confirm <snapshot> is required"` | yes |
| 23 | take-theirs snapshot changed at execution boundary | `:887-891`, `:1031-1042` | 1 | `snapshot-mismatch` | yes |
| 24 | **take-theirs resolved** | `:1044-1049` | **0** | `resolved` (+ quarantine path) | yes |
| 25 | sync busy / mutex timeout / unexpected throw | `:1051-1064` | 1 | `refused`/`sync-busy` or `operation-failed` | yes |

Confirmation-flow shapes, stated precisely:

- **take-theirs** is a 2-round protocol: `show-me` (or a bare `take-theirs`, branch 22) prints the token → `take-theirs --confirm <token>`.
- **keep-mine** is also 2-round but the first round is `keep-mine` *itself* (branch 13), which prints the discard report and the exact confirm command including whether `--force-discard-incoming` is needed (`resolve-presentation.ts:87-93`). `--force-discard-incoming` must be **exactly** present-or-absent per the report — passing it when not required is refused just as hard as omitting it when required (`:740-751`).
- The token is recomputed and re-checked **inside the lock immediately before mutation** (take-theirs `:887-891`; keep-mine `:771-776`), and again at a locked second-proof callback (`:1015-1028`). Concurrent repo activity therefore reliably invalidates a script's token, so any agent driving this needs a retry loop, not a single pass.

**Findings for the scriptable-path rule** (every branch does have a non-interactive form, so these are ergonomics, not gaps):

1. `keep-mine`'s preview — the *expected, successful* first half of the flow — exits **1** (`:735`). So does take-theirs' "token required" (`:879`). A CI wrapper cannot use exit code alone to distinguish "needs the second round" from "refused"; it must parse `status`.
2. `show-me` writes progress heartbeats to **stderr** (`:630-641`, "show-me: staging incoming bundle…", "still working (Ns)") unconditionally — no `--quiet`, and it is not suppressed by `--json`. `--json` output itself goes to stdout, so stdout stays clean.
3. There is no single-shot form (no `--yes`, no "confirm whatever the current snapshot is"). Two invocations are mandatory by design.
4. `git resolve` is excluded from the update-nudge suppression that `git deferrals` gets (`main-dispatch.ts:175-177` only special-cases `deferrals`), so a nudge line can appear on stdout ahead of `git resolve --json` output.

**Naming/grouping observations**

- `<repo>` is a **path** but is dual-purpose: it locates the workspace *and* names the repo, and it is resolved against cwd while being reported root-relative. `rbox git resolve .` from inside a nested repo means "the repo at cwd", while `rbox git resolve .` at the workspace root means the repo `"."` — the same token, different targets.
- The verbs `show-me` / `take-theirs` / `keep-mine` are the only hyphenated-English verbs in the CLI; every other subcommand uses single words (`list`, `restore`, `empty`, `status`, `approve`).
- `keep-mine` and `take-theirs` are not symmetric operations despite reading as a pair: `take-theirs` mutates local git state (quarantine + follow, `:893-1030`) and prints a quarantine path; `keep-mine` mutates nothing locally and instead **publishes a new remote sequence** via `pushManifest` (`:814-821`). One is a local checkout operation, the other is a push.
- `git deferrals` and `git resolve` are the only two-level `git *` commands; there is no bare `rbox git` entry, so `rbox git` falls through the switch's usage failure at `:540`.

---

## Cross-command divergence summary

| # | finding | file:line |
|---|---|---|
| D1 | `push` honors `RBOX_ALLOW_MASS_DELETE=1`; `pull` does not, and no help text says so | `main-dispatch.ts:302` vs `:329` |
| D2 | `export` accepts and silently ignores any positional path | `main-dispatch.ts:353-367` |
| D3 | `export --all` is a documented no-op (default behavior); used only for mutual exclusion | `export-cmd.ts:361-364` |
| D4 | `export` default out is `~/Downloads` **or `$HOME`** when Downloads is absent; help says only `~/Downloads` | `recovery-kit.ts:122-125` vs `help-registry.ts:238` |
| D5 | `ignore --respect-gitignore` with no value silently sets it **on** | `flags.ts:83` + `ignore-cmd.ts:152-156` |
| D6 | `ignore <glob>` is silently discarded when `--list` or `--purge` is also passed | `main-dispatch.ts:444-447` |
| D7 | bare `rbox ignore` (no args, no flags) is valid and lists rules; not in the usage string | `main-dispatch.ts:446` vs `help-registry.ts:268` |
| D8 | `versions` / `restore` / `trash restore` interpret their path argument as **workspace-root-relative** while the user types it cwd-relative; `versions` then reports an empty history indistinguishably from a real one | `versions-cmd.ts:23-27`, `:51`, `:85`; `engine/trash.ts:236` |
| D9 | `versions` and `restore` do not use their path arg to locate the workspace (cwd only), unlike `push`/`pull`/`status` | `main-dispatch.ts:490`, `:504` |
| D10 | `restore` has no `--json` although `versions --json` produces the sequences it consumes | `help-registry.ts:319-329` |
| D11 | bare `rbox trash` defaults to `list`; undocumented | `trash-cmd.ts:15` |
| D12 | essential help advertises a `trash` command with no registry entry | `help-registry.ts:683` vs `COMMAND_HELP` |
| D13 | `trash empty` is destructive with no confirmation and no `--yes`, unlike `ignore --purge` / `untrack` | `trash-cmd.ts:77-86` |
| D14 | `trash empty` can report "nothing to empty" while `trash list` shows files (15-minute floor + `.active` batch) | `trash-cmd.ts:78-82` |
| D15 | `git resolve` keep-mine preview and take-theirs "token required" — both normal steps of the flow — exit 1 | `resolve-command.ts:735`, `:879` |
| D16 | `git resolve show-me` writes unsuppressible progress lines to stderr even under `--json` | `resolve-command.ts:630-641` |
| D17 | `--json` is accepted by the parser for every command in the lane, including ones with no JSON output (`push`, `pull`, `export`, `ignore`, `restore`, `trash restore/empty`); it is silently neutralized rather than rejected | `flags.ts:104`, `main-dispatch.ts:160-162` |
| D18 | every command in this lane is filed under `SYNCING`, including the account-scoped `export` and the read-only `git deferrals` / `versions` / `trash list` | `help-registry.ts` |


---

# Lane 4 — key management, billing, meta/system commands

Repo: `/home/via/Development/Personal/rbox-core` @ `main` (v1.9.1).

## How this surface is wired (read this first)

- Single source of truth for help + the derived command catalog + zsh completions is
  `src/cli/help-registry.ts` (`COMMAND_HELP`, line 49). `src/cli/command-catalog.ts:16-36`
  projects it into `PUBLIC_COMMANDS` / `KNOWN_TOP_LEVEL`; `src/cli/completions.ts` generates
  the zsh script from it.
- The dispatcher is **`src/cli/main-dispatch.ts`** (there is no `main.ts`). The process
  entry is `src/cli/index.ts`, which intercepts `prompt-status` and `__tui-selftest`
  *before* `main()` (`src/cli/index.ts:5-14`).
- Flag parsing (`src/cli/flags.ts:67-93`) derives each flag's **arity from the registry's
  own usage strings**. A flag not declared in the registry for the resolved help key is
  rejected by `unknownFlagError` (`src/cli/flags.ts:101-113`), with a hardcoded always-allow
  list of `json`, `help`, plus per-command `HIDDEN_FLAGS` for `track`/`init`/`setup` only
  (`src/cli/flags.ts:95-99`).
- `--json` is downgraded to `false` when the resolved command doesn't declare it
  (`src/cli/main-dispatch.ts:161-163`), but `rawJsonMode` is still passed to `key save`.
- Interactivity gate: `isInteractive()` = policy enabled **and** stdin TTY **and** stderr TTY
  (`src/cli/prompt.ts:58-62`). The policy is set from argv `--no-interactive`
  (`src/cli/prompt-policy.ts:17-19`) — see the DIVERGENCE note under `key`.

---

## key

**Help entry** — `src/cli/help-registry.ts:415-425`. Group `DEVICES & ACCOUNT`, not hidden,
no alias.
Summary: "encryption and agent sync keys".
Usage: `rbox key <status | save | backup | genesis | recover | create-ci | materialize | list | revoke>`
Declared flags on the parent entry: `--json` (with status), `--kit` (with backup),
`--kit-path <path>` (with backup).

**Implementation** — dispatcher `case "key"` at `src/cli/main-dispatch.ts:508-524`. It is a
flat if/else on `positional[0]`; the first five subs come from the eagerly-imported
`auth-cmd.ts` barrel, the last four are lazily imported from `key-cmd.ts`
(`main-dispatch.ts:516`). Unknown/absent sub → `fail(...)` with a usage string
(`main-dispatch.ts:521`) that differs from the registry usage (it inlines
`genesis --yes` and `create-ci --expires <dur>`).

`src/cli/auth-cmd.ts` is a pure re-export barrel (50 lines); the real code lives in
`src/cli/auth/key-commands.ts`, `src/cli/auth/recovery-command.ts`,
`src/cli/auth/genesis-command.ts`, `src/cli/auth/genesis-destination-flow.ts`,
`src/cli/auth/recovery-kit-flow.ts`, and `src/cli/key-cmd.ts`.

Positional arity is **never validated** for `key`: `rbox key status foo bar` silently ignores
the extras; only `key revoke` reads `positional[1]` (`main-dispatch.ts:520`).

**User-facing vs advanced** (9 subcommands):

| sub | audience | why |
|---|---|---|
| `status` | normal | the only one surfaced on the essential help screen (`help-registry.ts:683` — "key — encryption: status, backup, recover") |
| `backup` | normal | re-show cached phrase |
| `recover` | normal | new machine without a pairing token |
| `save` | normal (macOS-centric) | post-hoc "put my phrase somewhere durable" |
| `genesis` | advanced / rescue | normally run implicitly by `login --bootstrap` / `setup` |
| `create-ci` | CI/agent | mints an **account-root-equivalent** bundle |
| `materialize` | CI/agent | unpacks `RBOX_KEY` into a keystore |
| `list` | CI/agent | lists agent keys |
| `revoke` | CI/agent | revokes an agent key |

---

## key status

**Help** — `help-registry.ts:426-432`. `rbox key status [--json]`.

**Implementation** — `keyStatus()` in `src/cli/auth/key-commands.ts:21-71`; dispatched at
`main-dispatch.ts:510`.

| arg/flag | parsed at | default | notes |
|---|---|---|---|
| `--json` | `main-dispatch.ts:510` (`jsonMode`) | false | emits `{enrolled, recoveryKit:{version:3,…}, genesisPending?}` (`key-commands.ts:33-58`) |

Reads credentials, pending-genesis state, device enrolment, cached recovery key, and the
recovery-kit record; probes the macOS Keychain artifact if one is recorded
(`key-commands.ts:30`). Human output prints device/account/encryption/cached-phrase lines
plus `recoveryKitStatusLines` (`auth/recovery-kit-flow.ts:179-216`).

**Interactive?** No prompts. Fully scriptable. One side effect: on macOS TTY sessions it may
print a nudge to run `rbox key save` and **mutates durable state** by claiming the
recovery-kit "offer" record (`maybePrintRecoveryKitNudge`, `auth/recovery-kit-flow.ts:218-236`
— gated on `process.platform === "darwin"` + both TTYs). Not documented in help.

Throws `not logged in — run \`rbox login\`` when no credential (`key-commands.ts:23`).

---

## key save

**Help** — `help-registry.ts:433-439`. Summary: "save a validated recovery phrase to Keychain
or an explicit file". Usage: `rbox key save [--kit-path <path>]`. Only `--kit-path` declared.

**Implementation** — `keySave()` in `src/cli/auth/key-commands.ts:112-135`, dispatched at
`main-dispatch.ts:511`.

| arg/flag | parsed at | default | notes |
|---|---|---|---|
| `--kit-path <path>` | `recoveryKitOptionsFromFlags`, `recovery-kit.ts:100-105` | unset | forces the plaintext-file branch |
| `--kit` | *rejected* | — | dispatcher hardcodes `kit: "true"` (`main-dispatch.ts:511`), and `unknownFlagError` rejects a typed `--kit` because the leaf entry doesn't declare it |
| `--json` | `main-dispatch.ts:511` (`rawJsonMode`) | false | explicitly refused: "`--json` is not supported by `rbox key save`" (`key-commands.ts:113`) |
| stdin | `readBoundedRecoveryPhraseStdin`, `key-commands.ts:137-153` | — | reads **fd 0 directly** via `readFileSync(0)`; ≤1 KiB; rejects embedded newlines |

**Phrase source, in order** (`key-commands.ts:117-129`):
1. Cached recovery key on disk → converted to a phrase, no prompt at all.
2. Else, if `stdin.isTTY` → **visible** (not masked) prompt; requires stderr TTY too, else
   errors "re-run in a terminal with stderr attached, or pipe the phrase on stdin"
   (`key-commands.ts:122-126`). The visibility is deliberate (comment at `:124-125`).
3. Else → read from stdin.

Then: 24-word count check (`:130-131`), canonicalization (`:132`), and
`validatePhraseForAccount` against the server-side account (`:133`).

**What it actually supports today** (`saveValidatedRecoveryPhrase`, `key-commands.ts:155-166`):
- `--kit-path` set **or** `process.platform !== "darwin"` → **plaintext file** via
  `writeKitSuccess` (`auth/recovery-kit-flow.ts:140-156`), default location
  `~/Downloads` if it exists else `$HOME` (`recovery-kit.ts:113,122-126`), mode `0600`,
  hardened atomic write with symlink/parent-inode re-validation (`recovery-kit.ts:269-314`).
- macOS with no `--kit-path` → **macOS login Keychain** via `writeKeychainKit`, then
  `recordKeychainArtifact`, then an interactive offer to delete matching old plaintext kits,
  then two stderr lines including: *"note: this item is not iCloud Keychain-synchronized —
  keep an off-machine copy too."* (`key-commands.ts:160-165`).

**DIVERGENCE / founder's question — `key save` has no 1Password path.** The three-way storage
choice (1Password / macOS Keychain / plaintext file / clipboard) exists **only** in the
genesis destination-set checkbox (`src/cli/auth/genesis-destination-flow.ts:74-109`).
`key save` offers exactly two outcomes: Keychain (macOS, no `--kit-path`) or a plaintext
file. On Linux the help's "Keychain or an explicit file" is misleading: with no `--kit-path`
it silently writes a plaintext kit to `~/Downloads`.

**Non-interactive twin:** yes — `RBOX_PHRASE | rbox key save --kit-path /tmp/kit.txt`, or
zero-input when the phrase is cached. Caveats: (a) the macOS Keychain branch can still raise
an OS-level authorization dialog outside rbox's control; (b) the plaintext-cleanup offer
(`offerPlaintextCleanupAfterKeychainSave`, `auth/recovery-kit-flow.ts:158-177`) is skipped
entirely when either stream is not a TTY, so a scripted run leaves stale kits in place.

---

## key backup

**Help** — `help-registry.ts:440-449`. `rbox key backup [--kit] [--kit-path <path>]`.

**Implementation** — `keyBackup()` in `src/cli/auth/key-commands.ts:87-99`, dispatched at
`main-dispatch.ts:512`.

| flag | parsed at | default | notes |
|---|---|---|---|
| `--kit` | `recovery-kit.ts:100-104` | false | `--kit=<path>` is rejected: "`--kit` does not take a path" (`recovery-kit.ts:101`) |
| `--kit-path <path>` | same | unset | implies `kit: true` (`recovery-kit.ts:104`); bare `--kit-path` errors (`:102`) |

Refuses while a genesis attempt is pending (`assertNoPendingGenesis`, `:90`). If no recovery
key is cached, prints a stderr message and sets `process.exitCode = 1` — it does **not**
throw (`key-commands.ts:92-96`).

**Interactive branches** (`showRecoveryPhrase`, `auth/recovery-kit-flow.ts:21-41`):
- non-interactive + `--kit`/`--kit-path` → writes the kit, does **not** echo the phrase
  ("write-suppress-echo", `recovery-kit.ts:108-111`, `recovery-kit-flow.ts:28-31`).
- interactive, no `--kit` → prints the phrase, then offers a save destination
  (Keychain on macOS, plaintext file otherwise, `recovery-kit-flow.ts:54-79`), then loops on
  "Have you saved this recovery phrase somewhere safe?" until an explicit yes
  (`recovery-kit-flow.ts:35-37`).
- non-interactive, no `--kit` → prints the phrase to **stderr** and a
  "(non-interactive: SAVE THE PHRASE ABOVE…)" line, no prompt (`recovery-kit-flow.ts:38-40`).

**Non-interactive twin:** yes, both forms (echo-to-stderr, or `--kit-path` file write).

---

## key recover

**Help** — `help-registry.ts:450-459`. `rbox key recover [--kit] [--kit-path <path>]`.
Summary notes it "requires `rbox login` first".

**Implementation** — `recoverCmd()` in `src/cli/auth/recovery-command.ts:35-111`, dispatched
at `main-dispatch.ts:514`. Same `--kit`/`--kit-path` parsing as `key backup`.

Phrase source (`recovery-command.ts:84-100`):
1. macOS Keychain candidate — **only** if both stdin and stderr are TTYs
   (`recovery-command.ts:130`), then an interactive "Found a recovery phrase for this account
   in the macOS Keychain — use it?" confirm (`:147`).
2. Else interactive → `promptInput({ message: "Enter your 24-word recovery phrase" })` (`:87`).
3. Else → `readStdinTrimmed()` (`:89`).

On a `RecoveryPreAdmissionError` after a Keychain-sourced attempt it falls back to manual
entry once (`:101-107`). After success it prints `recovered + enrolled this device: <id>` and
runs the recovery-kit offer (`offerRecoveryKitAfterRecover`,
`auth/recovery-kit-flow.ts:81-108`) — which in interactive mode prompts to save to Keychain
(macOS) or a plaintext file.

There is also a spawn-level test harness that runs this non-interactively
(`src/cli/recovery-process.test.ts:24`).

**Non-interactive twin:** yes — `echo "$PHRASE" | rbox key recover` (optionally with
`--kit-path`). Keychain discovery is skipped in that mode by design.

---

## key genesis

**Help** — `help-registry.ts:460-470`. `rbox key genesis --yes [--kit] [--kit-path <path>]`;
`--yes` (alias `-y`) described as "required to mint the account's first encryption keys".

**Implementation** — `keyGenesis()` in `src/cli/auth/key-commands.ts:74-84`, dispatched at
`main-dispatch.ts:513`. Without `--yes` it throws a usage error (`key-commands.ts:75`).
Delegates to `runGenesisEnrollment` (`src/cli/auth/genesis-command.ts:35-163`). Prints
`ENCRYPTION_ENROLLED_MESSAGE` on success, or an "already set up" message **on stderr**
(`key-commands.ts:79-83`).

| flag | parsed at | default |
|---|---|---|
| `--yes` / `-y` | `main-dispatch.ts:513`; `-y` mapped in `flags.ts:6` | false (required) |
| `--kit` | `recovery-kit.ts:100-104` | false |
| `--kit-path <path>` | same | unset |

**Destination selection** (`genesis-command.ts:66-133`):
- `--kit-path` → deterministic `kit-path` intent (`:69-72`).
- `--kit` → `completion.select(...)`: macOS ⇒ Keychain, otherwise default plaintext kit path
  (`genesis-command.ts:172-181`).
- non-interactive, or either stream not a TTY ⇒ `phrase-display` (print-only)
  (`:79`, `:115`).
- interactive TTY, no flags ⇒ the **multi-select destination checkbox**
  (`chooseGenesisDestinationIntent`, `genesis-destination-flow.ts:50-179`) offering
  1Password (only when the `op` CLI is detected, `:78-84`), macOS Keychain (`:85-91`,
  described as "saves on this Mac; it does not sync through iCloud"), Plain-text file
  (`:92-99`), and Copy to clipboard (`:100-106`). Failures drive a retry / continue / change
  select loop (`genesis-destination-flow.ts:382-397`).

**Non-interactive twin:** partially. `rbox key genesis --yes --kit-path <p>` and
`--yes --kit` are fully scriptable, and bare `--yes` in a pipe degrades to phrase-display.
**But there is no flag that selects 1Password or clipboard** — those destinations are
reachable only through the interactive checkbox, so that half of the storage-choice UX has
no agent/CI path to validate end to end.

---

## key create-ci

**Help** — `help-registry.ts:471-481`. `rbox key create-ci --expires <dur> [--label <text>]
[--accept-root-key]`.

**Implementation** — `createCiKey()` in `src/cli/key-cmd.ts:55-107`, dispatched at
`main-dispatch.ts:517` (receives the whole raw `flags` record).

| flag | parsed at | default | notes |
|---|---|---|---|
| `--expires <dur>` | `parseDuration`, `key-cmd.ts:13-24` | **required** | `^(\d+)(m\|h\|d\|w\|y)$`; `y` is treated as `PAT_MAX_TTL_MS`, hard cap 1y (`:19-22`) |
| `--label <text>` | `key-cmd.ts:71` | `"agent"` | a bare `--label` (value `"true"`) also falls back to `"agent"` |
| `--accept-root-key` | `key-cmd.ts:56` | false | skips the interactive confirm |

Writes an account-root warning to stderr, then `confirmDestructive({… headless: "throw" …})`
(`key-cmd.ts:40-53`) — in a non-TTY without `--accept-root-key` it fails with "refusing to
create an account-root key without --accept-root-key in non-interactive mode" (`:50`).
Requires login + an enrolled device (`:59-62`). On admission failure it best-effort revokes
the half-created key and warns about the cap (`:83-88`). Prints `RBOX_KEY=<bundle>` to
**stdout** (`:106`).

**Non-interactive twin:** yes — `--accept-root-key`.

---

## key materialize

**Help** — `help-registry.ts:482-492`. `rbox key materialize [--dir <path>] [--key -]
[--key-file <path>]`.

**Implementation** — `materializeCmd()` in `src/cli/key-cmd.ts:26-38`, dispatched at
`main-dispatch.ts:518`.

| flag / env | parsed at | default | notes |
|---|---|---|---|
| `--dir <path>` | `key-cmd.ts:33` | standard `RBOX_HOME` | bare `--dir` (value `"true"`) is treated as unset |
| `--key -` | `readKeyBundle`, `setup-keyed.ts:23-31` | — | stdin |
| `--key=<value>` | `key-cmd.ts:27-29` | — | **hard-rejected**: "argv leaks secrets via shell history and process listings" |
| `--key-file <path>` | `setup-keyed.ts:25-28` | — | bare `--key-file` errors |
| `RBOX_KEY` env | `setup-keyed.ts:29-30` | — | read automatically |

Prints four `export …` lines (`RBOX_HOME`, `RBOX_TOKEN`, `RBOX_ACCOUNT_ID`, `RBOX_DEVICE_ID`)
for `eval` (`key-cmd.ts:34-37`).

**Non-interactive twin:** it *is* the non-interactive path. No prompts anywhere.

---

## key list

**Help** — `help-registry.ts:493-499`. `rbox key list [--json]`.
**Implementation** — `listKeys()` in `src/cli/key-cmd.ts:109-121`, dispatched at
`main-dispatch.ts:519`. `--json` → `emitJson({ keys })`; human form prints
`deviceId  displayPrefix  expires <iso>  last-seen <iso|never>[  revoked]`.
No prompts. Requires login.

---

## key revoke

**Help** — `help-registry.ts:500-505`. `rbox key revoke <id>`. No flags declared.
**Implementation** — `revokeKey()` in `src/cli/key-cmd.ts:123-129`, dispatched at
`main-dispatch.ts:520` with `positional[1] ?? ""`. Empty id → usage error (`key-cmd.ts:124`).

**No confirmation prompt, no `--yes`, no dry run** — a single call revokes immediately and
prints `revoked <id>`. (Note the asymmetry with `key create-ci`, which *does* gate on a
destructive-confirm.) Fully scriptable.

---

## subscribe

**Help** — `help-registry.ts:508-516`. Group `BILLING & MAINTENANCE`.
`rbox subscribe <solo | pro> [--annual]`.

**Implementation** — `case "subscribe"`, `main-dispatch.ts:270-276` → `subscribe()` in
`src/cli/subscribe-cmd.ts:48-63`.

| arg/flag | parsed at | default | notes |
|---|---|---|---|
| `<plan>` positional | `subscribe-cmd.ts:56` via `normalizePlan` (`:21-25`) | required | valid: `solo`, `pro` |
| `team` positional | `subscribe-cmd.ts:52-55` | — | **undocumented third accepted value** — prints "Team plans are coming soon" and exits 0 |
| `--annual` | `main-dispatch.ts:274` | false | → `cadence=annual` |

POSTs `/v1/billing/checkout?plan=&cadence=`; `409` → "You're already subscribed…" (exit 0),
`501` → "billing isn't enabled on this server yet." Opens a browser via `openAndShow`
(`subscribe-cmd.ts:62`) which falls back to printing the URL.

**Interactive?** No prompts, but the success path *opens a browser* — there is no
`--print-url` / `--no-browser` flag; scriptability depends on `openAndShow`'s fallback.

---

## billing

**Help** — `help-registry.ts:517-522`. `rbox billing`. No flags.
**Implementation** — `case "billing"`, `main-dispatch.ts:277-281` → `billingPortal()`
(`subscribe-cmd.ts:66-77`). POSTs `/v1/billing/portal`; `409` → "no subscription yet — run
`rbox subscribe <plan>` first."; `501` → billing disabled. Opens a browser.
No positional validation — `rbox billing junk` is accepted and ignored.

---

## usage

**Help** — `help-registry.ts:523-529`. `rbox usage [--json]`.
**Implementation** — `case "usage"`, `main-dispatch.ts:287-291` → `usageCmd()`
(`src/cli/usage-cmd.ts:23-35`). GETs `/v1/account/usage`; `--json` echoes the raw server body
verbatim (`usage-cmd.ts:30-33`), otherwise renders plan / a 20-cell storage bar / workspaces /
retention, plus `grace:` and `read-only:` lines when present (`usage-cmd.ts:37-61`).
No prompts. Requires credentials.

---

## doctor

**Help** — `help-registry.ts:530-543`.
Usage: `rbox doctor [reset-journal] [--report | --quarantine | --restore <bundle>] [--path <dir>]`
Declared flags: `--report`, `--diagnostics`, `--yes` (`-y`), `--path <dir>`, `--quarantine`,
`--restore <bundle>`.

**Implementation** — `case "doctor"`, `main-dispatch.ts:388-403`; two different commands
behind one name:
- `rbox doctor reset-journal` → `resetJournalDoctorCmd` (`src/cli/reset-journal-doctor.ts`),
  accepting `--quarantine` and `--restore <bundle>` (`main-dispatch.ts:395-399`). Combining it
  with `--report`/`--diagnostics` throws (`main-dispatch.ts:394`).
- otherwise → `doctorCmd` (`src/cli/doctor-cmd.ts:748-771`). `--quarantine`/`--restore`
  without `reset-journal` throws (`main-dispatch.ts:400`).

| flag | parsed at | default | notes |
|---|---|---|---|
| `--report` | `main-dispatch.ts:389` | false | build the support bundle |
| `--diagnostics` | `main-dispatch.ts:390` | false | requires `--report` (checked twice: `main-dispatch.ts:391` and `doctor-cmd.ts:749`) |
| `--yes` / `-y` | `main-dispatch.ts:402` | false | consent to upload; **required** in non-interactive mode (`doctor-cmd.ts:710`) |
| `--path <dir>` | `main-dispatch.ts:392` | workspace from cwd | |
| `--quarantine` | `main-dispatch.ts:397` | false | reset-journal only |
| `--restore <bundle>` | `main-dispatch.ts:397` | unset | reset-journal only |
| `RBOX_DIAGNOSTICS=1` env | `doctor-cmd.ts:689` | — | **undocumented** — enables the upload path exactly like `--diagnostics` |

Sets `process.exitCode = 1` when any health check fails (`doctor-cmd.ts:770`).

**Interactive branch:** the diagnostics upload consent prompt (`doctor-cmd.ts:719-720`).
**Non-interactive twin:** `rbox doctor --report --diagnostics --yes`.

**DIVERGENCE:** the usage line omits `--diagnostics` and `--yes` even though both are
declared in the flag list and both are mandatory for the upload flow; and `RBOX_DIAGNOSTICS`
appears nowhere in help.

---

## upgrade

**Help** — `help-registry.ts:544-553`. `rbox upgrade [--check]`; flags `--check`,
`--remote <url>`.
**Implementation** — `case "upgrade"`, `main-dispatch.ts:240-247` → `upgradeCmd()`
(`src/cli/upgrade-cmd.ts:365+`).

| flag / env | parsed at | default | notes |
|---|---|---|---|
| `--check` | `main-dispatch.ts:243` | false | report-only |
| `--remote <url>` | `main-dispatch.ts:242` | `DEFAULT_REMOTE` | `RBOX_API` env also overrides |

Refuses when not running as an installed standalone binary (`upgrade-cmd.ts:366-368`) and
refuses non-HTTPS remotes except `http://localhost` (`:369-371`). Verifies a detached
signature over the manifest before trusting it (`:383-384`) and is forward-only against a
durable per-executable version floor (`:400-404`). Elevated (`euid 0`) runs are treated
specially — `main-dispatch.ts:114-121` skips the lock-identity ledger refresh for
`upgrade` when elevated. `upgrade` is also excluded from the update nudge
(`main-dispatch.ts:175`).

**Interactive?** No prompts. Fully scriptable.

---

## uninstall

**Help** — `help-registry.ts:554-560`. `rbox uninstall [--yes]`; "without it, print the steps
only".
**Implementation** — `case "uninstall"`, `main-dispatch.ts:282-286` → `uninstallCmd(flags)`
(`src/cli/uninstall-cmd.ts:132-156`).

| flag | parsed at | default | notes |
|---|---|---|---|
| `--yes` / `-y` | `uninstall-cmd.ts:138` | false | anything other than the literal `"true"` is a dry run |

Dry run prints a numbered plan (`uninstall-cmd.ts:124-130`). Real run: stop daemons from
`desired.json`, SIGTERM legacy pidfiles, disable autostart, `rm -rf ~/.rbox`, then instruct
the user to remove the PATH block from their rc file **themselves** (rc files are never
edited, `:152-155`).

Both paths first run `warnIfKeystoreAtRisk` (`uninstall-cmd.ts:60-70`), which computes
whether the recovery phrase is backed up outside the removal root
(`keystoreBackupAtRisk` `:26-58` + `recoveryKitSafety` `recovery-kit.ts:556-566`) and prints
a red warning — **it does not block the removal**.

**Interactive?** No prompts at all; `--yes` is the entire gate. Fully scriptable.

---

## version

**Help** — `help-registry.ts:561-566`. `rbox version`. Group `BILLING & MAINTENANCE`, visible.
**Implementation** — handled *before* the dispatcher switch, at `main-dispatch.ts:130-134`.
There is **no `case "version"`** in the switch.

Accepted spellings: `rbox version`, `rbox --version`, `rbox -v` (`main-dispatch.ts:130`).
Prints `RBOX_VERSION` from `src/cli/version.ts:16`, which is the compile-time
`__RBOX_DEV_VERSION__` if defined, else the checked-in literal (`version.ts:3`, currently
`"1.9.1"` — the release workflow's consistency gate reads the first quoted string in that file).

**DIVERGENCE:** `--version` / `-v` are real, documented nowhere in the registry (only a
comment at `command-catalog.ts:35`).

---

## shell-init

**Help** — `help-registry.ts:567-574`. `rbox shell-init zsh`, visible, group
`BILLING & MAINTENANCE`. Notes it "adds the rbox status segment to your prompt and installs
tab-completions".
**Implementation** — `case "shell-init"`, `main-dispatch.ts:554-566` → `shellInitZsh()`
(`src/cli/shell-init.ts:410`).

| arg | parsed at | notes |
|---|---|---|
| `zsh` positional | `main-dispatch.ts:558` | **required and exact**; anything else writes a usage line to stderr and sets exit 1 (`:559-562`) |

No flags. Emits a zsh prompt plugin that reads `.rbox/state/shell.line` directly (no
subprocess per prompt, `shell-init.ts:79`, `:117`) plus the completions script embedded
verbatim (`shell-init.ts:19`, `:409-410`). The plugin's fallback path shells out to
`rbox prompt-status` (`shell-init.ts:232`).

**Plumbing**, but visible in `rbox help --all`. A normal user types it once, from the
`eval "$(rbox shell-init zsh)"` example.

---

## completions

**Help** — `help-registry.ts:575-582`. `rbox completions zsh`, visible. The note says
`shell-init zsh` already includes these — "use `completions` only if you manage compdef
yourself".
**Implementation** — `case "completions"`, `main-dispatch.ts:567-577` → `zshCompletions()`
(`src/cli/completions.ts`).

| arg | parsed at | notes |
|---|---|---|
| `zsh` positional | `main-dispatch.ts:571` | required and exact; otherwise stderr usage + exit 1 |

Script is **generated from `COMMAND_HELP`**, deterministic, self-contained, and ends in a
guarded `compdef` (`completions.ts:14-24`). Only public commands appear — no `hidden`, no
deprecated aliases, no `__*` tokens (`completions.ts:22-23`).

**Plumbing.** Strictly a subset of `shell-init`; a normal user would never need it.

---

## prompt-status

**Help** — `help-registry.ts:583-590`. `rbox prompt-status [path] [--json]`,
**`hidden: true`** — the only hidden non-alias entry in this lane, so it is absent from
`rbox help --all` but still reachable via `rbox prompt-status --help`.

**Implementation** — intercepted in `src/cli/index.ts:5-9`, **before** `main-dispatch`.
It therefore bypasses `parseFlags`, `unknownFlagError`, the alias rewriter, the update nudge,
and the interaction-policy wrapper (`index.ts:42-45` returns before
`withInteractionPolicy`). It has its own hand-rolled parser
(`src/cli/prompt-status.ts:6-27`).

| arg/flag | parsed at | default | notes |
|---|---|---|---|
| `[path]` positional | `prompt-status.ts:23` | `process.cwd()` | more than one positional → stderr usage + exit 1 (`:18-22`) |
| `--json` | `prompt-status.ts:10` | false | |
| `--help` / `-h` | `prompt-status.ts:11-13` | — | prints its **own** two-line usage, not the registry block |

Errors are printed bare to stderr with exit 1 rather than through `fail()`
(`index.ts:52-56`). Prints nothing at all when the verdict is empty (`prompt-status.ts:26`).

**Plumbing.** Written for Starship/p10k; the default zsh integration deliberately does *not*
call it (`prompt-status.ts:3-4`).

---

## Divergences and rough edges (consolidated)

1. **`key save` help overstates platform support.** "save … to Keychain or an explicit file"
   (`help-registry.ts:436`) — on non-darwin with no `--kit-path` it writes a **plaintext**
   kit to `~/Downloads`/`$HOME` (`auth/key-commands.ts:156-158`). No 1Password path exists in
   `key save` at all; 1Password lives only in the genesis checkbox
   (`auth/genesis-destination-flow.ts:78-84`).
2. **`--no-interactive` is a global argv toggle but is only *allowed* on three commands.**
   `prompt-policy.ts:17-19` inspects raw argv for any command, yet `flags.ts:95-99` whitelists
   it for `track`/`init`/`setup` only — so `rbox key recover --no-interactive` dies with
   "unknown flag --no-interactive" before the policy can matter.
3. **1Password and clipboard destinations have no non-interactive twin.** Only the checkbox
   reaches them (`genesis-destination-flow.ts:74-109`); no CLI flag selects either. Violates
   the standing "every flow needs a scriptable twin" rule.
4. **`rbox key <bad-sub>` prints a usage string that doesn't match the registry.**
   `main-dispatch.ts:521` vs `help-registry.ts:419`.
5. **`key revoke` is destructive with zero confirmation** (`key-cmd.ts:123-129`), while
   `key create-ci` gates behind `confirmDestructive` (`key-cmd.ts:40-53`).
6. **`--kit` is advertised on the `key` parent entry but rejected on `key save`.**
   `help-registry.ts:422` lists `--kit`; `helpKeyFor` resolves `key save` to the leaf
   (`help-registry.ts:733-737`), whose flag list lacks it, so `unknownFlagError` rejects it
   (`flags.ts:101-113`). It is also redundant — the dispatcher hardcodes `kit: "true"`
   (`main-dispatch.ts:511`).
7. **`subscribe team` is an accepted, undocumented plan token** (`subscribe-cmd.ts:52-55`).
8. **`doctor`'s usage line omits `--diagnostics` and `--yes`**, and `RBOX_DIAGNOSTICS=1`
   (`doctor-cmd.ts:689`) is an undocumented equivalent of `--diagnostics`.
9. **`--version` / `-v` are undocumented** (`main-dispatch.ts:130`); the registry lists only
   `rbox version`, and there is no `case "version"` in the switch.
10. **`prompt-status` bypasses the whole dispatcher** (`index.ts:5-9`), so it has different
    flag parsing, different `--help` output, and different error formatting from every other
    command.
11. **`key status` mutates durable state as a side effect** on macOS TTYs — it claims the
    recovery-kit offer record while merely *printing* status
    (`auth/recovery-kit-flow.ts:218-236`).
12. **No positional-arity validation on `key`, `billing`, `usage`** — extra positionals are
    silently ignored (contrast `pair`, `main-dispatch.ts:235`, and `adopt`,
    `main-dispatch.ts:192`, which do check).
13. **`key backup` signals "no cached phrase" via `process.exitCode = 1` + stderr rather than
    a thrown error** (`auth/key-commands.ts:92-96`), so it does not go through `fail()` and
    prints in a different shape from every other failure in the family.


---

# Lane 5 — rbox help system + command-surface structure (facts only)

Repo `/home/via/Development/Personal/rbox-core`, branch `main` @ `f6013f2d`, rbox v1.9.1.
All line refs are current-tree.

---

## 1. The help architecture

### 1.1 Files

| File | Role |
|---|---|
| `src/cli/help-registry.ts` (747 lines) | The static `COMMAND_HELP` array (51 entries), group order, and all four renderers. |
| `src/cli/command-catalog.ts` (40 lines) | Projects `COMMAND_HELP` into `PUBLIC_COMMANDS`, `ALIAS_COMMANDS`, `HIDDEN_COMMANDS`, `KNOWN_TOP_LEVEL`. No second hand list. |
| `src/cli/main-dispatch.ts:25-32` | `printHelp()` — the only help-printing site. |
| `src/cli/main-dispatch.ts:139-147` | Help dispatch, before alias resolution and before any command runs. |
| `src/cli/flags.ts:1-113` | Parses argv using the registry's flag declarations for per-command arity, plus `HIDDEN_FLAGS` (see §2.4). |
| `src/cli/completions.ts` | zsh completions generated from `COMMAND_HELP` — including `takesPath()` at `completions.ts:74-76`, a **regex over the usage string**. |
| `src/cli/help-registry.test.ts` (139 lines) | Parity + snapshot tests. |

### 1.2 Groups

`HelpGroup` is a closed union (`help-registry.ts:16-21`); render order is `GROUP_ORDER` (`:41-47`):

1. **GETTING STARTED** — `setup`, `login`, `logout`, `status`, `init`, `adopt`
2. **SYNCING** — `start`, `stop`, `autostart enable`, `autostart disable`, `autostart status`, `logs`, `sync`, `git deferrals`, `git resolve`, `push`, `pull`, `export`, `track`, `untrack`, `ignore`, `trash list`, `trash restore`, `trash empty`, `versions`, `restore` (+ hidden `link`, `daemon`)
3. **DEPENDENCIES** — **zero live entries**; the whole block is commented out (`:331-372`). `renderGroupedHelp` skips empty groups (`:713`), so the header never prints.
4. **DEVICES & ACCOUNT** — `pair`, `connect`, `recover`, `device`, `account`, `key`, `key status`, `key save`, `key backup`, `key recover`, `key genesis`, `key create-ci`, `key materialize`, `key list`, `key revoke`
5. **BILLING & MAINTENANCE** — `subscribe`, `billing`, `usage`, `doctor`, `upgrade`, `uninstall`, `version`, `shell-init`, `completions` (+ hidden `prompt-status`)

SYNCING carries 20 of the 49 visible entries; DEVICES & ACCOUNT carries 15, nine of which are `key *`.

### 1.3 Three different screens

**(a) Essential screen — `renderEssentialHelp()` (`:650-704`).** Printed by:
- `rbox help` with no args (`main-dispatch.ts:139-142`),
- `rbox --help` / `-h`,
- bare `rbox` when stdin is **not** a TTY (`main-dispatch.ts:618-622`),
- any **unknown** command (same site, plus `process.exitCode = 1` at `:623`),
- `rbox help <unrecognized>` (`printHelp` falls back at `main-dispatch.ts:31`).

It is a **hand-written literal inside the render function** — five headings (`START`, `SYNC`, `ADD A MACHINE`, `IF SOMETHING'S WRONG`, `MORE`) with 11 command rows, each a `[name, summary]` tuple. **It contains no usage strings, no arguments, no flags.** Exact output is snapshot-pinned at `help-registry.test.ts:99-127`:

```
START
  setup   guided onboarding: account → workspace → syncing
  status  what's synced, what's running

SYNC
  start  begin background sync for this workspace
  stop   stop background sync
  sync   sync once, right now
  logs   follow the background-sync log
...
```

**(b) Full reference — `renderGroupedHelp()` (`:707-723`).** Reached **only** by `rbox help --all` (`main-dispatch.ts:140` requires `cmd === "help" && positional.length === 0 && flags.all === "true"`). Left column is `usageBody()` (`:727-729`) = the usage string minus the leading `"rbox "`, so this screen **does** show `start [path] [--pull-only | --read-write]`. Column width is `max(usageBody.length)` **per group** (`:716`), and the widest rows are ~130 chars (`init`, `setup`), so GETTING STARTED and SYNCING render very wide.

**(c) Per-command — `renderCommand()` (`:628-647`).** Reached by `rbox <cmd> --help` / `-h` (`main-dispatch.ts:144-147`) and `rbox help <cmd> [<sub>]` (`:141`). Layout:

```
<name> — <summary>

usage: <usage>
<notes…, dim>
deprecated: use `rbox <alias target>`   (only when alias set)

flags:
  --flag <v>  <desc>          (padded to max flag width)

examples:
  <example>
```

`helpKeyFor` (`:733-737`) picks the longest registered match, so `rbox key status --help` shows only the leaf. `helpFor` (`:609-614`) returns the exact entry **plus all `"<name> "`-prefixed subs**, so `rbox key --help` prints **ten** blocks (`key` + 9 sub-verbs) and `rbox trash --help` prints three (no bare `trash` entry exists). Alias help is deliberately NOT resolved (`:620-621`): `rbox link --help` shows the alias's own deprecated block.

### 1.4 Usage-string format conventions (as actually written)

- Always begins `rbox ` except… it always does; `usageBody` has a fallback for the case it doesn't (`:727-729`), currently unexercised.
- `[path]` / `[file]` lowercase in square brackets for optional positionals; `<repo>`, `<glob>`, `<id>`, `<file>@<seq>` angle-bracket for required.
- Sub-verb groups use two incompatible spellings:
  - inline alternation inside one entry: `rbox device <approve <user-code> | list [--json] | revoke <device-id>>`, `rbox account <link <code> | status [--json] | unlink>`, `rbox key <status | save | … | revoke>`;
  - one entry per sub-verb: `autostart enable/disable/status`, `trash list/restore/empty`, `git deferrals`/`git resolve`, `key status/save/…`.
  - `key` does **both** — a group entry AND nine leaf entries. `device` and `account` do only the first; `autostart`, `trash`, `git` do only the second (no bare-group entry at all).
- Mutually exclusive flags use `|` inside one bracket (`[--json | --verbose | --git]`); `ignore` uses top-level `|` alternation *outside* brackets, making its usage the only one that isn't a single grammar.

### 1.5 Design 29's "single source of truth" — does it hold?

Design 29 (`docs/design/29-cli-redesign.md:287`): *"The registry also feeds the grouped screen, so the help text has a single source of truth."*

**Holds for:** the grouped screen (`:710`), `command-catalog.ts` in full, zsh completions (`completions.ts:25`), per-command flag arity in the parser (`flags.ts:54-65`), unknown-flag rejection (`flags.ts:101-113`), and `--json` gating (`main-dispatch.ts:160`). Those are all genuine projections — no second list.

**Does not hold for three things:**

1. **The essential screen is a second hand-maintained list.** `renderEssentialHelp` (`:650-704`) hard-codes 11 command names and 11 summaries that are *not* read from `COMMAND_HELP`. They already diverge: registry `start` = "start background sync for this workspace" vs essential "begin background sync for this workspace"; registry `setup` = "guided onboarding: account → workspace → start syncing" vs essential "…→ syncing"; registry `status` = "workspace + background-sync state" vs essential "what's synced, what's running". Two of its rows (`trash`, `key`) name things that resolve to group-fanouts, and `trash` has no registry entry at all. The snapshot test pins the literal — it does not check consistency with the registry.
2. **Registry ↔ dispatcher parity is only partly enforced.** The comment at `command-catalog.ts:5-9` claims the catalog "can't drift from help by construction", and `KNOWN_TOP_LEVEL` guards the unknown-command exit code. But nothing asserts that a `switch` case exists for each entry, or that entry text matches behavior. Design 29 specified a "dispatcher↔registry parity test"; `help-registry.test.ts:70-77` only checks `PUBLIC_COMMANDS ∪ ALIAS ∪ HIDDEN`'s first words all live in `KNOWN_TOP_LEVEL` — i.e. registry→set, derived from the same array. It is self-referential.
3. **`prompt-status` bypasses the registry entirely.** It is intercepted in `src/cli/index.ts:5-9` before `main-dispatch` ever runs, and prints its **own** hard-coded usage string at `prompt-status.ts:12` (`"usage: rbox prompt-status [path] [--json]"`), duplicating the registry entry at `help-registry.ts:583-590`.

Additionally, ~20 dispatcher sites print their own ad-hoc `usage:` lines on misuse rather than calling `renderCommand` — e.g. `main-dispatch.ts:192, 254, 266, 370, 486, 503, 521, 529, 541, 559, 570`, plus `trash-cmd.ts:22` and `autostart-cmd.ts:726`. Several of these disagree with the registry (see §2.3).

---

## 2. Usage-string audit

Generated from `COMMAND_HELP` and then checked against `main-dispatch.ts` / each command module.

Legend for **Positional shown?**: `n/a` = implementation accepts no positional; `yes` = usage shows every positional the code reads; `partial`/`no` = defect.

| # | Command | `usage:` string | Positionals the code actually reads | Positional shown? |
|---|---|---|---|---|
| 1 | `setup` | `rbox setup [--workspace <name\|id>] [--dir <path>] [--key -] [--key-file <path>] [--daemon] [--pull-only] [--force]` | none — `runSetup({cwd, flags})` (`main-dispatch.ts:186-189`) | n/a (extra argv **silently ignored**) |
| 2 | `login` | `rbox login [--bootstrap <secret>] [--plan <solo\|pro>] [--label <text>] [--kit] [--kit-path <path>]` | none (`:222-228`) | n/a (ignored) |
| 3 | `logout` | `rbox logout` | none | n/a |
| 4 | `status` | `rbox status [path] [--json \| --verbose \| --git]` | `positional[0]` = path; `>1` rejected (`:369-372`) | yes |
| 5 | `init` | `rbox init [--new \| --workspace <id>] [--root <path>] [--adopt] …` | none — root comes from `--root` (`:181-184`) | n/a (ignored) |
| 6 | `adopt` | `rbox adopt <status\|resume\|abort\|clean> [path] [--json] [--yes]` | `[0]`=sub, `[1]`=path (`:191-196`) | yes |
| 7 | `start` | `rbox start [path] [--pull-only \| --read-write]` | `positional[0]` = path (`:413-415`) | **yes in registry / absent from the default help screen** |
| 8 | `stop` | `rbox stop [path]` | `positional[0]` (`:428`) | same as above |
| 9 | `autostart enable` | `rbox autostart enable` | `positional[0]`=sub only (`:431-434`) | yes |
| 10 | `autostart disable` | `rbox autostart disable` | ″ | yes |
| 11 | `autostart status` | `rbox autostart status` | ″ | yes |
| 12 | `logs` | `rbox logs [path] [--follow] [--limit N]` | `positional[0]` (`:439`) | yes (but `--lines`/`-n` undeclared in usage) |
| 13 | `sync` | `rbox sync [path] [--allow-mass-delete] [--pull-only] [--verbose]` | `positional[0]` (`:345`) | yes |
| 14 | `git deferrals` | `rbox git deferrals [--brief \| --json]` | none beyond the sub-verb; `positional.length !== 1` is rejected (`:528`) | yes; note at `:196` states no repo arg |
| 15 | `git resolve` | `rbox git resolve <repo> [show-me\|take-theirs\|keep-mine] […]` | `[1]`=repo, `[2]`=verb, default `show-me` (`:538-543`); `repo` also doubles as the workspace locator via `resolveRoot(repo)` (`:544`) | yes (the dual role of `<repo>` is undocumented) |
| 16 | `push` | `rbox push [path] [--allow-mass-delete]` | `positional[0]` (`:293`) | yes |
| 17 | `pull` | `rbox pull [path] [--allow-mass-delete] [--verbose]` | `positional[0]` (`:321`) | yes |
| 18 | `export` | `rbox export [--all \| --workspace <id>] [--out <dir \| file.tar.gz>]` | none — `runExport(flags)` (`export-cmd.ts:360`) | n/a (a path argument is **silently ignored**) |
| 19 | `track` | `rbox track [path] [--workspace <id>] [--respect-gitignore] [--new-device]` | `positional[0]` (`:197-200`) | yes |
| 20 | `untrack` | `rbox untrack [path] [--force]` | `positional[0]` (`:203`) | yes |
| 21 | `ignore` | `rbox ignore <glob> \| --list \| --respect-gitignore <on\|off> \| --purge [--yes] [--path <dir>]` | `positional[0]` = glob; **no path positional** — root only via `--path` (`:442-448`) | yes |
| 22 | `trash list` | `rbox trash list [--path <dir>] [--json]` | `[0]`=sub (`trash-cmd.ts:15-24`) | yes; no `[path]` positional exists |
| 23 | `trash restore` | `rbox trash restore <path> [--batch <name>] [--path <dir>]` | `[1]` = the *in-workspace* file path | yes (`<path>` here ≠ workspace path — collides with `--path`) |
| 24 | `trash empty` | `rbox trash empty [--path <dir>]` | `[0]`=sub | yes |
| 25 | `versions` | `rbox versions [file] [--limit <n>] [--json]` | `positional[0]`; `.`/root → whole workspace (`:493`) | yes; note at `:316` says it does **not** locate the workspace |
| 26 | `restore` | `rbox restore <file>@<seq>` | `positional[0]` = spec (`:502-503`) | yes |
| 27 | `pair` | `rbox pair` | none; `positional.length !== 0` throws (`:235`) | yes |
| 28 | `connect` | `rbox connect [<pairing-token>]` | `positional[0]`; `>1` throws (`:460`) | yes |
| 29 | `recover` | `rbox recover [path] [--yes] [--repair-chain] [--allow-mass-delete]` | `positional[0]` (`:469`) | yes |
| 30 | `device` | `rbox device <approve <user-code> \| list [--json] \| revoke <device-id>>` | `[0]`=sub, `[1]`=code/id (`:248-257`) | yes |
| 31 | `account` | `rbox account <link <code> \| status [--json] \| unlink>` | `[0]`=sub, `[1]`=code (`:258-269`) | yes |
| 32 | `key` (group) | `rbox key <status \| save \| backup \| genesis \| recover \| create-ci \| materialize \| list \| revoke>` | `[0]`=sub, `[1]`=id for revoke (`:508-524`) | partial — `revoke <id>` arg not shown at group level |
| 33 | `key status` | `rbox key status [--json]` | — | yes |
| 34 | `key save` | `rbox key save [--kit-path <path>]` | — (reads the phrase from **stdin** when non-TTY, `key-commands.ts:122-129`) | yes, but the stdin input channel is undocumented |
| 35 | `key backup` | `rbox key backup [--kit] [--kit-path <path>]` | — | yes |
| 36 | `key recover` | `rbox key recover [--kit] [--kit-path <path>]` | — (stdin phrase when non-interactive, `recovery-command.ts:58-60, 86-89`) | same undocumented stdin |
| 37 | `key genesis` | `rbox key genesis --yes [--kit] [--kit-path <path>]` | — | yes |
| 38 | `key create-ci` | `rbox key create-ci --expires <dur> [--label <text>] [--accept-root-key]` | — | yes |
| 39 | `key materialize` | `rbox key materialize [--dir <path>] [--key -] [--key-file <path>]` | — | yes |
| 40 | `key list` | `rbox key list [--json]` | — | yes |
| 41 | `key revoke` | `rbox key revoke <id>` | `[1]` | yes |
| 42 | `subscribe` | `rbox subscribe <solo \| pro> [--annual]` | `positional[0]` (`:274`) | yes |
| 43 | `billing` | `rbox billing` | none | n/a |
| 44 | `usage` | `rbox usage [--json]` | none | n/a |
| 45 | `doctor` | `rbox doctor [reset-journal] [--report \| --quarantine \| --restore <bundle>] [--path <dir>]` | `positional[0] === "reset-journal"` (`:393`); root only via `--path` | yes |
| 46 | `upgrade` | `rbox upgrade [--check]` | none | n/a |
| 47 | `uninstall` | `rbox uninstall [--yes]` | none | n/a |
| 48 | `version` | `rbox version` | none | n/a |
| 49 | `shell-init` | `rbox shell-init zsh` | `positional[0]` must be `zsh` (`:558`) | yes |
| 50 | `completions` | `rbox completions zsh` | `positional[0]` must be `zsh` (`:569`) | yes |
| 51 | `prompt-status` (hidden) | `rbox prompt-status [path] [--json]` | `positional[0]`; `>1` rejected (`prompt-status.ts:18-22`) | yes |
| — | `link` (hidden alias→`track`) | `rbox link <path>` | passthrough | yes (but `track`'s path is optional — the alias's usage is stricter than reality) |
| — | `daemon` (hidden alias→`start`) | `rbox daemon <start\|stop\|status\|logs>` | passthrough (`deprecations.ts:48-56`) | yes |

### 2.1 Verdict on "usage strings that hide a real positional"

**Zero registry usage strings omit a positional the implementation reads.** Every `[path]` a command accepts is in its `usage:` string. Checked exhaustively against the dispatcher `switch` (`main-dispatch.ts:180-624`) and the leaf modules.

The real defect Max hit is one level up: **the screen that is printed by default contains no usage strings at all.** `rbox help`, `rbox --help`, bare `rbox` in a pipe, and every unknown command render `renderEssentialHelp()` (`help-registry.ts:650-704`), which prints `start` / `stop` / `sync` / `logs` as bare words. The `[path]` exists only in `rbox help --all` and `rbox start --help`. The information is two flags away from the entry point that most users hit first.

Secondary defects found:

### 2.2 Positionals silently swallowed

`setup`, `login`, `init`, `export`, `logout`, `billing`, `usage`, `upgrade`, `uninstall`, `version` read **no** positionals and perform **no** arity check. `rbox export ~/code/myapp` and `rbox setup ~/code/myapp` are accepted, ignored, and act on `cwd` instead. Contrast `pair` (`:235`), `status` (`:369`), `connect` (`:460`), `adopt` (`:192`), and `git deferrals` (`:528`), which do reject extra args. `export` is the sharpest case: a user with the `--workspace`/`--out` shape in mind will reasonably try `rbox export ws_ab12cd34`.

### 2.3 Flags declared but absent from the usage line

From a mechanical diff of each entry's `flags[]` against its `usage` string:

| Command | Flags declared but not in `usage:` |
|---|---|
| `login` | `--remote` |
| `init` | `--remote`, `--git` |
| `track` | `--remote`, `--git` |
| `connect` | `--remote` |
| `upgrade` | `--remote` |
| `logs` | `--lines` (documented only as an alias of `--limit`) |
| `ignore` | `--allow-mass-delete` |
| `doctor` | `--diagnostics`, `--yes` |
| `key` (group) | `--json`, `--kit`, `--kit-path` |

### 2.4 Flags accepted but declared nowhere

`flags.ts:95-99` — `HIDDEN_FLAGS`: `track` also accepts `--project --name --device --no-interactive`; `init` also accepts `--name --project --pull-only`; `setup` also accepts `--new --name --no-sync --respect-gitignore`. These pass `unknownFlagError` but appear in no help output and no completion.

### 2.5 Divergence between registry usage and dispatcher error usage

- `trash-cmd.ts:22` prints `usage: rbox trash <list | restore <path> [--batch <name>] | empty> [--path <dir>]` — a group-shaped string that has no registry counterpart (the registry models trash as three leaves).
- `autostart-cmd.ts:726` prints `usage: rbox autostart <enable | disable | status>` — likewise no group entry exists.
- `main-dispatch.ts:521` `key` misuse prints `… genesis --yes … create-ci --expires <dur> …`, i.e. more detail than the registry's `key` usage at `:419`.
- `main-dispatch.ts:486` `versions` misuse prints `usage: rbox versions [path] …` while the registry says `[file]`.

### 2.6 Knock-on: completions inherit the usage string

`completions.ts:74-76`: `takesPath(c) = /(?:^|[\s<[])path\b/.test(c.usage)`. File completion is offered **only** where the literal token `path` appears in the usage. `versions` uses `[file]`, so `rbox versions <TAB>` offers no file completion; `trash restore <path>` matches and does. A usage string is therefore load-bearing for behavior, not just prose.

---

## 3. Aliases, hidden commands, deprecations

### 3.1 Live aliases (2)

| Alias | Target | Mechanism | Notice (stderr) |
|---|---|---|---|
| `link` | `track` | `deprecations.ts:26-32` `SIMPLE_ALIASES`, positionals pass through | `note: 'rbox link' is now 'rbox track'.` |
| `daemon` | `start` (registry) — really a **fan-out** | `deprecations.ts:48-56`: `daemon start\|stop\|logs` → that command with the sub stripped; `daemon status` → `status`; anything else stays `daemon` and hits `default:` | `note: 'rbox daemon …' is now 'rbox start/stop/logs'.` |

Both are `hidden: true` (`help-registry.ts:593-594`). Aliases are rewritten in one pass at `main-dispatch.ts:151-158`, *after* help dispatch, so `rbox link --help` shows the alias block with its `deprecated: use \`rbox track\`` line (`:634`). Notices go to stderr only, so piped stdout is unaffected (`deprecations.ts:3-5`). `flags.ts:55` resolves the alias before choosing flag arity — without that hop `rbox link --git false <path>` lost the path (comment at `flags.ts:50-52`).

The registry says `alias: "start"` for `daemon`, but `resolveAlias` maps four different sub-verbs to three different targets. `help-registry.test.ts:88-97` reconciles this by only checking the `start` case. The `daemon` alias's declared target is therefore approximate.

### 3.2 Hidden non-alias commands (1 in the registry)

- `prompt-status` (`:583-590`) — real command, intercepted in `index.ts:5-9`.

`HIDDEN_COMMANDS` (`command-catalog.ts:22-27`) adds `help`, `__daemon-run`, `__boot-resume`.

### 3.3 Internal tokens with no registry entry at all

Handled in the switch but absent from `COMMAND_HELP` **and** from `KNOWN_TOP_LEVEL`: `__watcher-selftest` (`main-dispatch.ts:592`), `__git-refwatch-platform-selftest` (`:599`), `__crypto-smoke` (`:605`), and `__tui-selftest` (`index.ts:10`). Because `isKnownTopLevel` is registry-derived, these run correctly but would be classified "unknown" by anything consulting the catalog.

### 3.4 The commented-out `deps *` block (`help-registry.ts:331-372`)

**Staged work, deliberately parked — not dead code by accident.** `docs/design/51-rbox-yml-config.md:254-294` §5 "Already done: the `deps` CLI group is commented out" is the decision record. It lists the exact coordinated set of comment-outs: `index.ts` `runDeps()` + `case "deps"`, the 5 registry entries + 3 alias entries, the setup prompt, `scripts/install.sh`'s `--with-dep-notify` block, and the corresponding test assertions. Rationale recorded there: `deps install` "isn't the right shape right now", and `deps notify`'s job (toggling the post-sync drift nudge) becomes a config key instead. Implementations (`hydrate-cmd.ts`, `deps-drift.ts`, `deps-notify.ts`) are untouched and still unit-tested (`deps-drift.test.ts`, `deps-notify.test.ts` carry header notes). Re-enabling is described as uncommenting the registry entries + the dispatcher function + `case "deps"`.

`postSyncNudge` is explicitly **unaffected** (`main-dispatch.ts:38-41`) — it is a sync behavior, not a `deps` command, and still runs after `pull` (`:336`).

Origin of the whole group: `c1e3e732 feat(cli): redesign — start/setup, track/untrack, deps group, --help, dep-drift (#9)`, i.e. it shipped with design 29 and was later parked by design 51.

### 3.5 The commented-out `hydrate`/`detect` aliases (`help-registry.ts:595-599`, `deprecations.ts:28-32`)

Commented out **because their forward targets no longer exist** — the comment states "their forward target no longer exists, so keeping them would dangle." A third alias, `doctor` → `deps check`, is called out as **intentionally not restorable**: `doctor` is now the support-diagnostics command (introduced by `5db9b790 feat: rbox doctor + opt-in diagnostics upload (design 56 §10 P3) (#70)`, 2026-07-03). So `rbox doctor` today means something entirely different from what design 29 mapped it to (`docs/design/29-cli-redesign.md:62`: old `doctor [path]` → `deps check [path]`). Same token, two meanings across two designs.

Consequence today: `rbox hydrate`, `rbox detect`, `rbox deps` are all unknown commands → essential help screen + exit 1.

---

## 4. Structural observations (from code)

### 4.1 `init` / `adopt` / `track` / `link` / `setup`

| Command | What it actually does |
|---|---|
| `setup` | Interactive wizard; composes login + workspace create/join + first sync + optional daemon start (`setup-cmd.ts`). Keyed non-interactive branch via `RBOX_KEY` + `--workspace` (`setup-keyed.ts`, gated at `setup-cmd.ts:175-183`). |
| `init` | Same outcome, flag-driven, no wizard (`init-cmd.ts`); `main-dispatch.ts:181-184`. Registry summary calls it "the scripting form of setup". Its plan/error layer (`init-plan.ts`) emits `headlessHint` strings. |
| `track` | **Binds a directory to a workspace and stops.** No first sync (registry summary `:245`), no daemon. `track-cmd.ts:64-90` will interactively pick/create a workspace if TTY. |
| `link` | Deprecated alias → `track`, unchanged args. |
| `adopt` | Not an onboarding verb at all — it is the **recovery surface for a non-empty join** (`<status\|resume\|abort\|clean>`), operating on the adoption fence/journal (`adopt-journal.ts`, `adopt-lifecycle.ts`). Related to `init --adopt` (`help-registry.ts:107`), which is where the adoption is *initiated*. |

So the overlap is real but narrower than the names suggest: `setup`/`init` are the same operation at two interaction levels; `track` is a strict subset of both (bind only); `adopt` is a noun-flag on `init` promoted to a top-level verb for its own state machine.

`setup` is also the fallback for `start` outside a workspace on a TTY (`main-dispatch.ts:417-424`) and for bare `rbox` when there's no workspace (`:98-100`).

### 4.2 `sync` / `push` / `pull` / `start`

- `push` (`main-dispatch.ts:292-319`) → `push(root, cfg, deps)` under the workspace mutex; push-side mass-delete consent only.
- `pull` (`:320-343`) → `pull(...)`; pull-side consent; runs `postSyncNudge`.
- `sync` (`:344-352`) → `runSyncCommand(root, {allowMassDelete, pullOnly, verbose})` (`sync-cmd.ts`) — the composed pull-then-push, and the only one where `--allow-mass-delete` covers **both** guards (registry `:182`).
- `start` (`:404-426`) → `startDaemonAndRecordDesired` — spawns/records a **long-lived per-workspace daemon**, plus a desired-state record.

`sync --pull-only` and `pull` are near-duplicates; `sync` differs by also running the push phase and by consent scope.

### 4.3 `start` / `stop` versus "the daemon"

There is **no whole-daemon object.** Runtime state is per-workspace: `rbox-paths.ts:43` `daemonRuntimeDir(root) = ~/.rbox/daemons/<workspaceKey(root)>`, and `autostart-cmd.ts:85` `daemonsDir()` enumerates that directory. `start`/`stop` each resolve exactly one workspace root (`main-dispatch.ts:414, 428` via `resolveRoot`) and mutate exactly that workspace's desired record (`autostart-cmd.ts:448-483`). `rbox stop` with no path and outside a workspace throws `Not inside an rbox workspace…` (`main-dispatch.ts:67-75`).

The only fleet-wide operations are `autostart enable/disable` (login-resume policy, `autostart-cmd.ts:716-728`) and `rbox upgrade`'s daemon snapshot/restart-all (per `docs/DEPLOYMENTS.md`).

### 4.4 `versions` / `restore` / `trash *`

Three restore-adjacent surfaces with two different backing stores:

- `versions [file]` + `restore <file>@<seq>` — **synced version history**, verified commit chain, KEK decrypt (`versions-cmd.ts`; `main-dispatch.ts:476-507`). Both resolve the root from **cwd only** — neither accepts a workspace path (`:490, :504`), unlike every other path command.
- `trash list/restore/empty` — the **local trash tier**, files rbox itself moved aside during a pull (`trash-cmd.ts`, `engine/trash.ts`). Root comes from `--path`, never a positional.

The registry notes cross-reference each other (`help-registry.ts:298`, `:326`), which is the only thing separating `rbox restore src/app.ts@3` from `rbox trash restore src/app.ts` for a user.

### 4.5 `doctor` overloading

`rbox doctor` is three things behind one token (`main-dispatch.ts:388-403`): health check (default), support-report builder/uploader (`--report [--diagnostics --yes]`), and a journal rescue sub-verb (`doctor reset-journal [--quarantine|--restore <bundle>]`). Flag combinations are validated with three separate throw sites (`:391, 394, 399`).

### 4.6 Noun-verb vs verb-noun

| Shape | Commands |
|---|---|
| bare verb | `setup` `login` `logout` `status` `init` `start` `stop` `sync` `push` `pull` `export` `track` `untrack` `ignore` `restore` `pair` `connect` `recover` `subscribe` `billing` `usage` `doctor` `upgrade` `uninstall` `version` `versions` `logs` |
| noun-first + verb | `autostart enable\|disable\|status`, `trash list\|restore\|empty`, `git deferrals\|resolve`, `device approve\|list\|revoke`, `account link\|status\|unlink`, `key status\|save\|backup\|genesis\|recover\|create-ci\|materialize\|list\|revoke`, `adopt status\|resume\|abort\|clean` |
| noun-only (state) | `git deferrals` — a **plural noun as the sub-verb**, the only one; `versions` — a plural noun as a top-level command |

Additional collisions inside that table:
- `status` is a top-level command, an `autostart` sub-verb, an `account` sub-verb, a `key` sub-verb, and an `adopt` sub-verb — five different `status`.
- `restore` is a top-level command **and** a `trash` sub-verb **and** a `doctor --restore <bundle>` flag.
- `recover` is a top-level command (`recover [path]` = re-baseline a halted workspace) **and** `key recover` (= re-enroll this machine from the recovery phrase). Completely unrelated operations, same verb.
- `list` appears as `trash list`, `device list`, `key list`, and `ignore --list`.
- `usage` is a top-level command (plan limits) while `usage:` is the help label (`help-registry.ts:632`).
- `key` is both a command namespace and a flag name (`--key -`, `--key-file`) on `setup` and `key materialize`.

### 4.7 Group modeling is inconsistent (three styles, already noted in §1.4)

- `key`: group entry **plus** 9 leaf entries → `rbox key --help` emits 10 blocks; grouped screen shows all 10 rows.
- `device`, `account`: group entry **only** → sub-verbs are undiscoverable except inside the one usage line, and `rbox device list --help` falls back to the group entry via `helpKeyFor` (`:733-737`).
- `autostart`, `trash`, `git`: leaf entries **only**, no group entry → `rbox trash --help` prints three blocks with no overview, and the dispatcher's own misuse string (`trash-cmd.ts:22`) invents a group usage the registry doesn't have.

---

## 5. Scriptability posture

Prompting is centrally gated: `prompt.ts:58-61` `isInteractive() = interactionPolicy.enabled && stdin.isTTY && stderr.isTTY`; `--no-interactive` anywhere in argv disables it (`prompt-policy.ts:17-19`). `confirmDestructive` (`prompt.ts:91-113`) takes an explicit non-interactive policy: `proceed | deny | require-yes | throw`.

### 5.1 Flows that have a working non-interactive twin

| Flow | Scriptable path |
|---|---|
| `setup` | `RBOX_KEY` (or `--key -` / `--key-file`) + `--workspace` → `runKeyedSetup` (`setup-cmd.ts:175-183`, `setup-keyed.ts`); or `rbox init --no-interactive` |
| account creation / first login | `rbox login --bootstrap <secret>` (`main-dispatch.ts:226-227`) |
| add a machine | `rbox pair` prints the token without prompting (`auth/pairing-command.ts:67-70` only waits for a keypress when interactive); `rbox connect <token>` or `echo <token> \| rbox connect` (`main-dispatch.ts:460-464`, `pairing-command.ts:96-97`) |
| `key genesis` | `--yes` required (`key-commands.ts:75`) |
| `key save` / `key recover` | phrase on **stdin** when non-TTY (`key-commands.ts:122-129` via `readFileSync(0)`; `recovery-command.ts:58-60, 86-89`) — **works but is documented nowhere in the usage or flags** |
| `key create-ci` | `--accept-root-key` skips the confirm (`key-cmd.ts:45-51`, `headless: "throw"` otherwise) |
| `untrack` | `--force`; the confirm is `headless: "proceed"` (`main-dispatch.ts:213`) so it also self-answers when piped |
| `ignore --purge` | `--yes` (`ignore-cmd.ts:87-88`, `headless: "require-yes"`) |
| `recover` | `--yes` (`recover-cmd.ts:52`, `headless: "throw"` otherwise) |
| `adopt clean` | `--yes` (`adopt-cmd.ts:163`, `headless: "deny"`) |
| `doctor --report --diagnostics` | `--yes` (`doctor-cmd.ts:709`) |
| `uninstall` | `--yes` (dry-run without it) |
| `git resolve` | `--json` + `--confirm <token>` + `--force-discard-incoming` (`main-dispatch.ts:546-550`) |
| machine-readable output | `--json` on `status`, `usage`, `versions`, `trash list`, `device list`, `account status`, `key status`, `key list`, `adopt status`, `git deferrals`, `prompt-status`; gated centrally at `main-dispatch.ts:160-162` |

### 5.2 Gaps — no non-interactive twin

1. **`rbox login` (device-code path).** Non-interactive it hard-fails: `auth/device-login.ts:393-395` throws *"no enrolled machine delivered keys before expiry — run `rbox login` in a terminal to use a pairing token or recovery phrase."* Only `--bootstrap` is headless. There is no `RBOX_TOKEN`-style twin for the ordinary "authorize this machine via the web" path (`init-plan.ts:154-155` suggests `RBOX_TOKEN=<device-token>` as an *input*, i.e. it presumes a credential obtained elsewhere).
2. **`rbox account link <code>`.** The code originates in the web dashboard; there is no CLI-only way to mint it. `main-dispatch.ts:262`.
3. **`rbox subscribe` / `rbox billing`.** Both open a browser; `browser-open.ts:33-35` degrades to *printing* the URL when stdout isn't a TTY, but the Stripe checkout / portal itself cannot be completed from a script. `subscribe-cmd.ts`.
4. **`rbox device approve <user-code>`.** Scriptable in form, but the `<user-code>` is produced by an interactive `rbox login` on the other machine, so the end-to-end enrollment cannot be driven headlessly except via `pair`/`connect` or a CI key bundle.
5. **Bare `rbox` (front door).** TTY-only by construction (`main-dispatch.ts:618-621`); non-TTY prints the essential help. `front-door.ts:34-48, 109-150`. Its menu actions (`login/sync/start/stop/setup/pair/usage/logs/exit`) all have CLI twins, so this is a UI, not a capability, gap.
6. **`rbox track` without `--workspace`.** In a TTY it prompts to create-vs-join and runs the workspace picker (`track-cmd.ts:64-90`). Headless it throws `run \`rbox login\` before creating a workspace` (`:90`) — but the actual gap is that a headless caller has no way to *choose* an existing workspace by name; `--workspace <id>` requires the id, and the id-discovery surface (`workspace-picker.ts`) is prompt-only. There is no `rbox workspace list` command.
7. **`rbox key backup`.** No `--json`; output is prose to stdout. Fine for humans, not parseable.
8. **`rbox key save` / `key recover` stdin twins are undiscoverable.** They work, but neither the usage string, the flags list, nor the notes mention that stdin is accepted — an agent reading `--help` would conclude the flow is interactive-only.
9. **No `--yes`/`--force` on `trash empty`.** It doesn't prompt today (`trash-cmd.ts:20`), so it's scriptable — recorded here only because it is the one destructive verb with no confirmation at all, i.e. the inverse asymmetry.

---

## 6. Max Howell's feedback → current-code reality

| # | Max said | Reality in code | Verdict |
|---|---|---|---|
| 1 | *"the cli could use some revisions on its command structure, but you can fix my confusion with some better help"* | The default help screen (`renderEssentialHelp`, `help-registry.ts:650-704`) lists 11 bare command names with no arguments, no flags, and no usage. Full usage exists but only under `rbox help --all` (`main-dispatch.ts:140`) or `rbox <cmd> --help`. | **Correct.** The help he saw genuinely omits everything he was missing. |
| 2 | *"for me I assumed start and stop referred to the ENTIRE DAEMON"* | Wrong assumption, but the CLI gives him nothing to correct it. There is no whole-daemon object: runtime state is `~/.rbox/daemons/<workspaceKey(root)>` (`rbox-paths.ts:43`), one daemon **process per workspace**; `start`/`stop` resolve a single root (`main-dispatch.ts:414, 428`) and update that workspace's desired record (`autostart-cmd.ts:448, 463`). Only `autostart enable/disable` and `rbox upgrade` are fleet-wide. | **His assumption is factually wrong; his diagnosis of why is correct.** The default screen's summaries — "begin background sync for this workspace" / "stop background sync" — do say "this workspace" for `start` and drop it for `stop`. |
| 3 | *"if the help was `start [PATH]` it would be clearer that it is related to paths and not the whole daemon"* | The registry usage **is already** `rbox start [path]` (`help-registry.ts:134`) and the code does accept it (`main-dispatch.ts:413-415`). It renders in `rbox help --all` and `rbox start --help`. It does **not** render on the screen he saw. | **Correct about the screen, and the fix already exists one layer down** — it's a rendering/routing choice (`renderEssentialHelp` hard-codes names, not `usageBody`), not missing data. |
| 4 | *"I would perhaps lean towards add and remove verbs though remove sounds destructive ofc"* | Today: `track` binds a directory (create/join, **no first sync** — `help-registry.ts:245`, `track-cmd.ts`); `untrack` locally unbinds and leaves both local files and the remote workspace intact (`help-registry.ts:260`, `untrack-cmd.ts`; the confirm text at `main-dispatch.ts:211` reads *"Stop syncing {root}? Local files stay."*). Deprecated `link`→`track` alias still exists. | His instinct that `remove` "sounds destructive" matches the actual semantics problem: `untrack` is **not** destructive, which is precisely why the current name was chosen over `remove`/`delete`. |
| 5 | *"track/untrack work but don't quite communicate everything that happens"* | Confirmed by the code: `track` may **create a remote workspace**, may **join an existing one**, may **mint a new device identity** (`--new-device`), sets `--respect-gitignore`, sets `--git <true\|false>` (git-state sync, default on — a flag not even in its usage line), and in a TTY runs an interactive create-vs-join picker (`track-cmd.ts:64-90`). It does **not** sync. `untrack` unbinds locally and may `SIGKILL` a stuck daemon (`--force`, `help-registry.ts:262`). The one-line summaries carry none of this. | **Correct, and understated.** `track`'s two undocumented-in-usage flags (`--remote`, `--git`) plus four fully hidden ones (`--project --name --device --no-interactive`, `flags.ts:96`) mean even `--help` doesn't show everything it does. |
| 6 | Suggested `rbox auth login` | Today: top-level `login` / `logout` (`help-registry.ts:68, 82`), plus `account <link\|status\|unlink>` (web↔CLI linking, a **different** concept — `main-dispatch.ts:259`), plus `device <approve\|list\|revoke>`, plus `key <9 sub-verbs>`, plus `pair`/`connect`/`recover`. Auth-adjacent surface is spread over 6 top-level tokens; there is no `auth` namespace. | His suggestion targets a real fragmentation. |
| 7 | Suggested `rbox sync ./src` — **always require a path** | Today `rbox sync [path]` is optional and falls back to `findRoot(cwd)`; outside a workspace it throws *"Not inside an rbox workspace. Run `rbox setup`… or `rbox track <path>`…"* (`main-dispatch.ts:67-75, 345`). | Path is accepted and documented; it's the *optionality* he's arguing with, not a missing arg. |
| 8 | Suggested `rbox status ./src` — **path optional, no path = all workspaces** | Path is optional (`main-dispatch.ts:369-386`) — but "no path" does **not** mean all workspaces. It means `findRoot(cwd)`, and **errors** if cwd isn't inside a workspace (`resolveRoot`, `:71-75`). There is **no** all-workspaces view anywhere in the CLI; no `rbox workspace list` exists either. | **He is describing behavior rbox does not have.** Half-right on the signature, wrong on the semantics. |
| 9 | Suggested `rbox unsync ./src` | Nearest today: `untrack [path]` (local unbind, remote untouched) and `stop [path]` (stop the background daemon, stay bound). His single `unsync` collapses two distinct operations that the code keeps separate (`untrack-cmd.ts` vs `autostart-cmd.ts:463`). | The distinction is real in code; whether it should be user-visible is the open question. |
| 10 | *"setup is not a great cli verb imo… It's less instructive. What will it do…?"* | `setup` is the wizard entry point and does a lot: login (or bootstrap), create-or-join a workspace, first sync, optionally start the daemon, optionally pick a plan (`setup-cmd.ts:259, 402, 457, 553, 647, 933`). Its registry summary is "guided onboarding: account → workspace → start syncing"; the **essential screen** shows a shortened "guided onboarding: account → workspace → syncing" (a hand-typed divergence, §1.5). It is also the implicit target of bare `rbox` outside a workspace (`main-dispatch.ts:98-100`) and of `rbox start` outside a workspace on a TTY (`:417-424`), so users reach it without typing it. `init` is its documented scripting twin (`help-registry.ts:101`). | **Correct that the verb is uninformative**; the code makes it worse by routing two *other* entry points into it silently. |

### 6.1 One additional item Max didn't raise but the code implies

`rbox <unknown>` prints the same low-information essential screen and exits 1 (`main-dispatch.ts:622-623`). Since `deps`, `hydrate`, and `detect` are all now unknown (§3.4/3.5), a user following older docs gets the 11-line screen with no "did you mean" and no mention that the command was removed.

