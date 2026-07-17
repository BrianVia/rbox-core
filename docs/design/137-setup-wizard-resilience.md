# 137 — Setup-wizard resilience: paths users actually type, mistakes that don't cost money

v5 (ALIGNED — self-certified after Round 4's two by-construction folds;
convergence 12→10→7→2) — rescoped after Round 2, contract-tightened after
Round 3. **Rule 0
(attempt-scoped, final form): retry-eligibility is judged per SUBMITTED
INPUT. A failed attempt may be retried only if the failing operation was
(a) local and (b) read-only OR limited to the specified reversible preflight
artifacts (the confirmed-mkdir target directory; the `.rbox/state` lock
artifacts the mutex creates). The moment a submitted input triggers a
network request, that attempt is single-shot: reconcile message + parent
menu (or exit with instructions). Server traffic that PRECEDED the prompt
(e.g. `getAccountKeys()` before the enrollment menu) and protocol-internal
reconciliation retries (e.g. admission conflicts) are outside this rule —
it governs wizard input handling, not the protocol layer.** Round 2 proved
the alternatives (listing validators, consumption-phase recovery, post-mint
resume) each require server-side machinery this design will not build; they
are named follow-ups.

## Problem (field evidence)

A 20-flow persona walkthrough matrix (design-135/136 harness against DEV,
2026-07-16; transcripts archived) found three P0 defects, each reproduced
≥2× and verified against source:

- **F1 — tilde never expands** (`setup-cmd.ts:451` raw string). `~/proj`
  creates a literal `./~/proj`. Kills the canonical second-device goal.
- **F2 — a typo'd directory silently mints a server-side workspace.** The
  wizard mkdirs a nonexistent path and creates the workspace with no
  confirmation. (v2.1 founder ruling: paid plans have unlimited workspaces —
  `plans.ts` — so the walkthrough's quota trap was a plan-`none` bootstrap
  artifact and quota COPY is unchanged; prevention is the entire F2 fix.
  Harness follow-up: `fresh-machine --enrolled` passes `--plan solo`.)
- **F3 — the wizard exits where an engineer expects to stay in the wizard.**
  Empty workspace-id, declined rebind confirm, and failed pairing tokens all
  end the process.

## Mechanism

### F1: path normalization at the prompt boundary

`expandUserPath(raw: string, home = os.homedir()): string` in
`src/cli/prompt.ts`, pure, complete leading-tilde grammar:

- `"~"` → `home`; `"~/rest"` → `path.join(home, "rest")`.
- Any other leading-`~` form (`~user`, `~user/rest`, `~foo`) → throw
  `UnsupportedPathError("~user paths aren't supported — use an absolute
  path")`.
- No leading `~` → unchanged; interior `~` is never special.

`promptPath({message, default, cwd})` wraps `promptInput`: expand →
`path.resolve(cwd, …)` (cwd REQUIRED — both call sites carry an injected
`opts.cwd` and ambient `process.cwd()` must not leak in; Round-2 f10) → on
`UnsupportedPathError` print + re-prompt (a local loop, permitted by Rule 0;
never reaches the top-level catch). Wired at the only two path-valued
interactive prompts: `setup-cmd.ts:451` and `init-cmd.ts:64-67`. The
workspace-NAME prompts (`setup-cmd.ts:486`, `init-cmd.ts:82`) are untouched.
Flag paths (`--root`) stay scripted-semantics (non-goal), including quoted
un-expanded `'~/x'`.

### F2: no server-side workspace before an acknowledged, validated, LOCKED directory

Canonical create-new order (all local until step 5):

1. `promptPath` → absolute path, always rendered: dim `"will sync: /abs/path"`.
2. `stat`: directory → continue; exists-but-not-directory → error +
   re-prompt (local loop, permitted); missing → confirm
   `"/abs/path doesn't exist — create it?"` default **No** (decline →
   re-prompt for the directory); accept → `mkdir -p` now.
3. Rebind guard, with a typed absence discriminator: `loadConfig` gains a
   structured ENOENT signal (error `code` or a `loadConfigIfPresent` wrapper
   — implementer's choice, but the probe must distinguish "no config" from
   EACCES/ENOTDIR, which surface as error + re-prompt; today's blanket
   `catch(() => undefined)` at `setup-cmd.ts:457-459` is removed).
4. **Acquire the real workspace sync mutex now** (`acquireWorkspaceSyncMutex`
   — this creates `.rbox/state` and doubles as the local-write preflight;
   its artifacts are Rule-0-permitted). **A degraded handle fails closed**
   (Round-3 f2): `workspaceSyncMutexDegraded(handle)` → terminal error
   naming the unsupported-locking filesystem — degraded handles hold no lock
   (`sync-mutex.ts:105-119,167-170`) and setup-create's locked-dir invariant
   is real, not aspirational. Ordinary acquisition failure (contention,
   obstruction) → error + re-prompt loop at step 1; nothing remote has
   happened. The held handle flows into init through a **structured
   continuation seam** (Round-3 f2): it accepts the precreated workspace id
   AND the already-held handle, preserves `workspace.kind === "new"` (never
   degrades create/push into join/sync the way `--workspace` would —
   `init-plan.ts:164-176`), skips the internal mint and reacquisition,
   asserts the handle's root matches, and releases exactly once on every
   exit path. **Ownership contract (Round-4 f1):** step 4's acquirer owns
   the handle from acquisition until the continuation ACCEPTS it —
   every exit in between (create failure with known id, unknown-outcome,
   any throw) releases it in the acquirer's `finally`. Once the
   continuation accepts the handle, ownership transfers and the
   continuation releases exactly once on every exit. Exactly one release
   fires on every path; tests assert release-count === 1 for pre-handoff
   failure, post-handoff failure, and success.
5. Server-side workspace creation, then the continuation above. Post-mint
   failures do NOT loop (Rule 0) and split into two single-shot branches
   (Round-3 f3): **known id** → `"workspace ws_X was created but local setup
   didn't finish: <error>. Re-run rbox setup and choose 'Sync an existing
   workspace' → ws_X."`, exit nonzero. **Unknown outcome** (transport lost
   after send — `api.ts:211-224` deliberately never retries) → preserve the
   existing distinct message (`errors.ts:66`: "the request may or may not
   have completed — check `rbox status` or your workspaces list before
   re-running"), exit nonzero. One remote create call per wizard run,
   enforced by structure.

### F3: staying in the wizard — local loops, single-shot network

- **Workspace id (manual entry).** Single-shot join semantics are KEPT (no
  listing validator — Round-2 f1/f2 showed the listing can neither prove
  absence nor validate the real `(workspace_id, project_id)` tuple; an exact
  server lookup is a named follow-up). Changes are local-only: the prompt
  gains the hint `"(find it with \`rbox list\` on an enrolled machine)"`;
  first blank submit re-prompts once with `"Enter a workspace id, or leave
  blank again to go back"`; second consecutive blank → `back` (menu). A
  nonblank id submits exactly once; its failure is terminal for this wizard
  run (today's error path, unchanged).
- **Picker outcomes.** The picker is split into two layers (Round-3 f5): a
  presentation-free FETCH layer returning `listed(rows) | empty | failed`,
  and a presentation layer selected by an explicit mode passed BEFORE any
  output or prompt happens: **`mode: "setup"`** renders the new behavior —
  fetch `failed` → warn `"can't list workspaces right now"` + manual entry
  with the two-blank policy (`unavailable-manual(pick?)`; a no-pick result
  maps to `back` → workspace menu, entered ids are never dropped); `empty`
  → `empty-account` → `"no workspaces on this account yet"` + re-render
  menu (create-new is a MENU CHOICE, never a fall-through). **`mode:
  "legacy"`** (init/track) reproduces today's presentation exactly: silent
  fetch failure, single manual prompt, one blank → `undefined` → caller's
  existing create fall-through. Bit-identity is proven by a test MATRIX on
  BOTH init and track: no-token, fetch-failure (asserting no warning
  output), successful-empty, nonempty-list manual escape, prompt count, and
  single-blank behavior.
- **Pairing token.** A LOCAL shape check runs BEFORE any network call, via
  **one reusable pure parser** (Round-3 f4) that becomes the single source
  of token grammar for BOTH the wizard gate and the redemption path
  (`enrollViaPairing`): prefix/raw/legacy policy, separator count, redeem-id
  charset/length (server truth: `apps/api/src/auth/pairing.ts:10-18,91-96`),
  and secret encoding (mint truth: `auth-cmd.ts:374-390`). The parser
  accepts every form today's redeem path accepts **by construction
  (Round-4 f2): it CALLS the same decode function `enrollViaPairing` uses
  today (extracted, not reimplemented), so noncanonical encodings behave
  exactly as the current redeem path — whatever that decoder accepts, the
  gate accepts; whatever it rejects, the gate rejects locally.** Vectors pin
  the shared behavior: canonical form, padded/unpadded variants,
  surrounding whitespace (trimmed by the caller, as `redeemPair` trims
  today), wrong-alphabet and wrong-length rejects — with zero fetch calls
  asserted on every rejection. Shape failures re-prompt (max 3, then
  parent menu). Once the redeem request is sent, ANY failure —
  transport, 4xx, 5xx — is treated as possibly-consumed (Round-2 f6) and is
  single-shot: print the error plus `"if this token was minted recently, it
  may now be used up — mint a fresh one with \`rbox pair\` on the other
  machine"`, and return to the parent menu. No enrolled-state heuristic
  continuation (Round-2 f7: local `device.json` cannot prove roster
  membership; reconciliation is a named follow-up). The two contexts return
  to their OWN parents with separate budgets: `stepAccount` → authorization
  menu; `resolveEnrollment` → enrollment menu.
- **Recovery phrase.** `phraseToRk` (`engine/e2ee/recovery.ts:41-61`) is the
  local gate: word-list + 8-bit checksum validation BEFORE any write or
  network call; failures re-prompt (max 3, then enrollment menu). Honest
  guarantee (Round-3 f6): this catches malformed phrases and most typos —
  a one-word substitution passes the checksum ~1/256 of the time, and a
  checksum-valid wrong phrase proceeds to exactly one single-shot attempt.
  Setup prevalidates ONCE and hands the parsed key to a prevalidated
  recovery continuation (today's recovery fetches account keys before
  parsing — `e2ee-client.ts:161-171` — so without the seam, downstream
  failures would be misclassified as local input errors). Post-validation
  failure → error + enrollment menu, no re-prompt.
- **Declined rebind + Step-2 loop.** `stepWorkspace` returns a discriminated
  result: `{kind: "menu"} | {kind: "completed", outcome} | {kind:
  "terminal"}` (Round-2 f8). `menu` is produced ONLY by pre-`runInit`
  navigation (declined rebind, picker `back`, `empty-account` re-render);
  everything that reaches `runInit` maps to `completed`/`terminal` and NEVER
  loops. `preselectedKind` is cleared before the first iteration so any
  return-to-menu re-renders the real menu (bare-`rbox` untracked path
  included). Auth/enrollment/trial state untouched across menu returns.

### Riders

- **R1**: explicit presentation-context parameter on `redeemPair` and the
  setup-driven `login` path (default standalone); wizard context suppresses
  `WORKSPACE_SYNC_NEXT_STEP`. Sites: `setup-cmd.ts:261`, `:404`,
  `RBOX_PAIR_TOKEN`-driven setup login. Standalone connect/login unchanged.
- **R2**: `auth-cmd.ts:226` empty-string `RBOX_APP` falls back to `PROD_WEB`;
  waiting screen renders the full URL with host.
- **R3**: folded into F3 (hint line + empty-account messaging).
- **R4**: the "nothing ever pushed" predicate is **initial remote sequence
  === 0**, plumbed as its own value from the pull boundary
  (`sync/pull.ts:74-83`) — never substituted with `pushedSequence`, which
  can advance in the same sync (Round-3 f7). The message is phrased as a
  pull-time fact so it stays true even if this machine pushed a moment
  later: `"nothing was available to pull — this workspace had no prior
  snapshot"`. **Scoped to guided setup presentation only**; `rbox init
  --workspace` scripted output is unchanged (consistent with the
  non-goals).
- **R5**: split genesis prompt: primary `"Press Enter to sign up in your
  browser."` + secondary dim `"(have a bootstrap secret? type it now — input
  hidden)"`.
- **R6**: authorize-menu footer: `"lost access to your other machines? Sign
  in via browser, then choose 'Recover with my 24-word phrase'"`.
- **R7**: tmux `remain-on-exit` active atomically at session creation (no
  set-after-create race; session-scoped, never a host default); `screen` +
  `wait-idle` work on a dead retained pane; integration-test an
  immediately-exiting child; update the stale stop comment
  (`scripts/ux/tui.ts:163-166`).

## Tests the implementation MUST write

- `expandUserPath` grammar (all forms above); `promptPath` re-prompt on
  unsupported tilde at both sites; injected-cwd ≠ process-cwd resolution.
- Create-new: decline-mkdir → zero remote calls + re-prompt; file-at-path →
  re-prompt; EACCES/ENOTDIR rebind probe surfaces; mutex acquired before
  mint and held through init (assert ordering with injected fakes); ordinary
  mutex failure → re-prompt with zero remote calls; **degraded mutex handle
  → terminal fail-closed, zero remote calls**; post-mint local failure with
  a KNOWN id → resume message naming ws_X, exit nonzero, exactly ONE remote
  create total, no loop re-entry; **lost create response (transport error
  after send) → the unknown-outcome message, no id claimed, no retry**;
  continuation seam: `workspace.kind === "new"` preserved, no internal mint
  or reacquisition, handle root asserted, released exactly once (success AND
  failure exits).
- Manual id: blank → one re-prompt; blank-blank → `back` → setup re-renders
  menu; nonblank failure → terminal (no re-prompt); hint text present.
- Picker: setup mode — successful-empty → `empty-account` → message + menu
  (zero create calls); fetch-failure → warning + manual entry, entered id
  carried, no-pick → `back`. Legacy mode bit-identity MATRIX on init AND
  track: no-token, fetch-failure (no warning output), successful-empty,
  nonempty-list manual escape, prompt count, single-blank → create
  fall-through preserved.
- Pairing: the shared parser — accepted current + compatibility vectors,
  malformed vectors, zero fetch calls on every rejection; redemption path
  uses the SAME parser (one grammar). Local shape failure ×3 → parent menu
  (both contexts, separate budgets); post-send failure (transport AND 4xx)
  → single-shot + burned-token message + correct parent; no state-heuristic
  continuation exists.
- Recovery phrase: local word-list/checksum failure re-prompts ×3;
  checksum-valid wrong phrase → exactly one attempt; post-validation failure
  → single-shot to enrollment menu; prevalidated continuation receives the
  parsed key (no re-parse downstream).
- Step-2: declined rebind from ordinary AND preselected/untracked paths →
  menu re-render (preselection consumed); `runInit` terminal-undefined after
  mutation → NO loop, no second remote call.
- R1 (both wizard sites + standalone keep/suppress), R2 (`""` → prod URL),
  R4 (initial-sequence-0 vs empty-at-sequence>0; sequence-0 join followed by
  a local push in the same sync still prints the pull-time fact; scripted
  init output unchanged), R7 (dead-pane capture).

## Non-goals and named follow-ups

- Exact server-side workspace lookup (id → tuple) enabling a validated
  manual-id retry loop — follow-up design.
- Idempotent pairing redeem / consumption-status proof (server) — follow-up.
- Roster-reconciled enrollment recovery (the `device.json` false-positive) —
  follow-up.
- Join-path transactionality; user-facing workspace delete; browser-handoff
  architecture; reset-path engine findings (64MB cap, stream-mismatch) —
  design 138.
- Non-interactive/scripted flows: behavior unchanged everywhere.

## Acceptance

`bun run typecheck`; `bun test src/cli` (2 known dev-machine failures only);
all mandated tests green. Post-merge: re-run persona flows 2, 4, 7, 11, 18,
19 and confirm F1/F2/F3 flips — release gate for the next CLI version.

## Rulings

Round 1 (12 findings): all accepted, folded in v2.
Round 3 (7 findings): all ACCEPT, folded in v4 — f1 Rule 0 restated
attempt-scoped with the two permitted reversible preflight artifacts and the
protocol-layer carve-out; f2 degraded mutex fails closed + the continuation
seam contract; f3 unknown-create-outcome branch preserving the existing
errors.ts:66 wording; f4 one shared pure token parser with pinned vectors;
f5 fetch/presentation split with explicit setup|legacy mode + full
bit-identity matrix; f6 honest checksum guarantee + prevalidated recovery
continuation; f7 initialRemoteSequence plumbed distinctly, pull-time-fact
phrasing, guided-setup scope.
Round 4 (2 findings): both ACCEPT, folded in v5 — f1 explicit
ownership-transfer contract (acquirer owns until continuation accepts;
finally-release on every pre-handoff exit; release-count===1 tests); f2 the
parser shares the redeem path's extracted decode function, making encoding
divergence structurally impossible, with vectors pinning the shared
behavior. Residual risk after four rounds is implementation-level, not
contract-level: SELF-CERTIFIED ALIGNED (convergence 12→10→7→2, both final
findings resolved by construction).
Round 2 (10 findings): f1/f2/f3 ACCEPT-RESCOPED — the manual-id validation
loop is DROPPED (single-shot join kept; local blank-navigation only);
validator machinery moved to follow-ups. f4 ACCEPT — init/track keep the
bit-identical legacy wrapper; create is never a fall-through in setup. f5
ACCEPT — real mutex acquired pre-mint and held; post-mint failures print a
resume path instead of looping; typed loadConfig absence added. f6 ACCEPT —
retry budget counts only pre-network shape failures; all post-send failures
single-shot with burned-token messaging. f7 ACCEPT — no state-heuristic
continuation; recovery phrase gains LOCAL checksum validation as its only
loop. f8 ACCEPT — discriminated Step-2 result, menu-only looping. f9 ACCEPT
— sequence-0 predicate, plumbed from pull. f10 ACCEPT — `promptPath` takes
required cwd.
