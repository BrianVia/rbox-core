# Simplify pass for PR #163 (apply exactly; no scope creep)

Quality cleanups only — no behavior changes except items explicitly marked
BEHAVIOR. Repo-wide: after edits run `bun run format` on touched files, then
`npm test`, `npm run test:api` (tolerate ONLY the pre-existing install.sh
loopback failure + the json-output real-~/.rbox flake), `npm run typecheck`.

## Shared helpers (reuse)

1. **`readPlan` reuse.** Delete `accountPlan()` in `apps/api/src/auth/api-keys.ts`;
   export `readPlan` from `apps/api/src/auth/mint.ts` and use it. (authenticate
   already rejects tombstoned accounts, so the lost `deleted_at` clause is
   covered upstream — say so in a one-line comment.)
2. **`isPaidPlan()` in plans.ts.** Add `export function isPaidPlan(plan: string | null | undefined): boolean`
   to `apps/api/src/plans.ts` (true for solo/pro/team — derive from a single
   local list next to PLANS, not a dup in auth/). Replace `PAID_PLANS` in
   api-keys.ts with it.
3. **Shell quoting.** New `src/cli/shell-quote.ts` exporting `shQuote(s)`.
   Replace the three copies: `src/cli/key-cmd.ts:57` (`quoteSh`),
   `src/cli/deps-notify.ts:163` (`q`), `src/cli/completions.ts:28` (`sq`).
4. **Stdin drain.** Move `readStdinTrimmed()` out of `src/cli/setup-cmd.ts`
   into new `src/cli/read-stdin.ts`; point `src/cli/auth-cmd.ts:380-383` and
   `src/cli/index.ts:339-342` (their inline drain-stdin idioms) at it too.
5. **b64url single source.** New `src/engine/encoding.ts` holding
   `toB64url`/`fromB64url` moved verbatim from `src/engine/e2ee/primitives.ts`
   (primitives.ts re-exports them so all existing importers are untouched;
   encoding.ts must import NOTHING — worker-safe). `src/engine/pat-token.ts`
   deletes `bytesToBase64url` and imports from encoding.js.
6. **Shared TTL constant.** `export const PAT_MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000`
   in `src/engine/pat-token.ts`; both `src/cli/key-cmd.ts` (`MAX_EXPIRES_MS`)
   and `apps/api/src/auth/api-keys.ts` (`ONE_YEAR_MS`) use it.
7. **Label sanitizer.** Generalize `sanitizeWorkspaceName` in
   `apps/api/src/authz.ts` to take a max-length param (default preserving
   current behavior), and use it for `label` + `displayPrefix` in api-keys.ts
   instead of `cleanString` (control chars must not reach the dashboard).
8. **Agent id mint.** One `newAgentId()` helper exported from
   `src/cli/e2ee-client.ts`, used by key-cmd.ts:126 and e2ee-client.ts:208.

## Structure (altitude)

9. **`classifyKind` single owner.** Export it from
   `apps/api/src/auth/authenticate.ts`; `apps/api/src/auth/account-surface.ts:98`
   uses it (mapping `device` → `"cli"` at the surface). Leave the NULL fallback
   itself in place (deploy-window shim) but add a `TODO(migration 0023): kind NOT NULL, drop fallback` comment.
10. **Daemon pull-only choke point.** In `src/cli/daemon.ts`, every `want.push`
    mutation must flow through one seam: add `private requestPush(): void`
    that no-ops when `this.pullOnly`, and replace the direct writes at ~201,
    ~367, ~371, ~377 (including the currently-unguarded ones — BEHAVIOR:
    pull-only daemons must never set want.push even from scan ops). Keep
    `request()` calling it.
11. **`admitWithRetry` un-fork.** Collapse `admitWithRetryInner` back into
    `admitWithRetry(api, deviceId, initial, build, persist = true)`; delete
    the wrapper.
12. **Keyed setup module + flag guard.** Move the keyed flow out of
    `src/cli/setup-cmd.ts` into new `src/cli/setup-keyed.ts`
    (`runKeyedSetup`, `resolveKeyedWorkspace`, `ensureKeyedTargetDir`,
    `slugifyWorkspaceName`, key-input reading). BEHAVIOR: `rbox setup
    --workspace=<x>` with NO key input (no RBOX_KEY, no --key-file, no --key)
    must ERROR ("--workspace requires a key: set RBOX_KEY or pass
    --key-file/--key -") instead of silently entering the interactive flow.
    Add a unit test for that error.
13. **Bundle format module.** Move `AgentKeyBundle`, encode/decode,
    `bundleSecrets`, `materializeAgentKey` from key-cmd.ts into new
    `src/cli/agent-key-bundle.ts`; key-cmd and setup-keyed import it. Add a
    comment on `materializeAgentKey` naming the deliberate coupling: it
    mutates process.env because `credentials.ts`/`e2ee-keystore.ts` read the
    env — that IS the headless seam.
14. **Daemon options object.** `RboxDaemon` constructor: replace the 4th/5th
    positional optionals with a trailing `opts: { bootId?: string; pullOnly?: boolean } = {}`;
    update all construction sites (no more `undefined` placeholders).

## Dead weight (simplification)

15. **Drop `mkWrap` from `AgentKeyBundle`** (written, never read):
    `admitAgentDevice` returns plain `DeviceSecrets`; create-ci stops
    serializing it. Keep `keks` (design 20 §5.2 wire format — warm-bundle
    producer is a named fast-follow); add `// producer: warm bundles (design 20 §5.2 fast-follow)` where it's emitted empty.
16. **`materializeAgentKey` env contract**: set the env vars once,
    unconditionally, at the top of the write phase; delete the
    save-and-restore-on-error juggling (an error aborts the command anyway;
    env-as-output is the documented contract per item 13's comment).
17. **`deviceId` only, drop `id` twins** from `POST /v1/keys/api` response,
    `listApiKeys` rows, and CLI `ApiKeyRow` (`src/cli/remote/keys.ts`) +
    key-cmd list rendering + any tests asserting `id`.
18. **pat-token exports**: delete the unused `export` of `PAT_PREFIX` (keep
    the const internal if used).
19. **`src/cli/autostart-cmd.ts`**: delete redundant `pullOnly` redeclaration
    on `StartStopDeps` (~:57); fix the mangled indentation in `parseDesired`
    (~:150-156).
20. **`src/cli/index.ts` key case**: hoist ONE `await import("./key-cmd.js")`
    above the create-ci/materialize/list/revoke branches.
21. **agent.sh without the cache hop** (`apps/api/src/routes/release.ts`):
    serve the `AGENT_SH` constant directly from `releaseRoutes` after the
    rate-limit check (same headers as today); only `/install.sh` keeps the
    CachedReleases gateway (it amortizes R2 reads; agent.sh has none). Update
    the agent.sh test if it asserted the gateway path.

## Explicitly SKIPPED (do not do)

- Folding the plan gate into the INSERT WHERE (keeps plan knowledge in
  plans.ts; creation is a cold route).
- Removing the `api_keys` sidecar table (design 20 §3 is normative;
  created_by is audit provenance).
- Removing the PAT checksum (design 20 §4 normative — secret-scanner story).
- Deleting the in-handler api_key self-checks in list/revoke (repo idiom:
  layered self-rejection, same as webTokenAllowed routes).
- revokeApiKey pre-check query merge (would push api_key semantics into
  shared revokeDevice for a cold route).
- Skipping the workspace-list fetch for raw ws_ ids.

Do NOT commit. Leave changes in the working tree. Don't delete this spec.
