# Design 205: status account-profile fallback

## Problem

The brief `rbox status` identity line is rendered by `briefIdentityLine` in
`src/cli/status-view.ts`. `statusCmdWithDeps` builds its `BriefAccountSummary`
through `cachedAccountSummary` in `src/cli/status-cmd.ts`.

The normal direct-command source is the local account profile
(`~/.rbox/account-profile.json` in a normal installation), read by
`readAccountProfile(accountId)`. The status command also has an injectable primary
identity seam, `readBriefIdentity`, used by `statusCmdWithBriefIdentity`. Today its
only in-tree production producer is the bare-`rbox` front door's transient
`/v1/account/status` result; it is not itself a durable workspace cache. That
primary source currently replaces the profile source wholesale. A missing-field
primary can therefore supply `{ email: null, plan: null }` and render
`Signed in · plan unavailable` even though the account-matched profile contains
both fields.

`rbox account status` renders its `/v1/account/status` response and populates this
same account profile as a write-through side effect through
`scheduleAccountProfileWrite`. The status brief must reuse the file only. It must
not add an account-plane network request.

The exact freshly rebound direct-`rbox status` report is not reproducible from the
current tree: without an injected primary, that command already reads the profile.
Issue 467's acceptance contract nevertheless requires the two-source fallback and
workspace-source precedence. The command-level regression therefore exercises the
public dependency boundary which represents that primary source. A front-door
integration test would not cover the state: `fetchColdFrontDoorIdentity` skips its
fetch when a matching profile already has a plan.

## Contract

For a valid credential with an account id, resolve brief identity per field:

1. Read the optional primary workspace/front-door identity source.
2. Read `account-profile.json` for the credential account id.
3. For both `email` and `plan`, use the workspace value when it is non-null;
   otherwise use the profile value; otherwise retain `null`.

Here, "stale" means missing/null field data; neither source has freshness
metadata. This makes an incomplete workspace value fall back without allowing a
profile for another account to leak across accounts (`readAccountProfile` already
enforces the account-id match). A complete workspace identity retains existing
precedence.

Signed-out, credential-degraded, and missing-account-id behavior is unchanged.
The renderer and its non-developer copy remain unchanged:

- resolved email and plan: `Signed in as <email> · <plan>`
- neither source: `Signed in · plan unavailable`

## Implementation

- Change `cachedAccountSummary` in `src/cli/status-cmd.ts` to treat
  `readBriefIdentity` as an optional primary source and always consult the local
  account-profile fallback.
- Keep `readCachedBriefIdentity` as the exact file adapter.
- Do not change `status-view.ts`: it remains a pure renderer.
- Do not add network calls or invoke `fetchAccountSummary` on the default status
  path.

## Tests

Add command-level regressions in `src/cli/status-cmd.test.ts`:

1. Fresh workspace, valid credentials, a missing-field primary, and populated
   account profile:
   `Signed in as owner@example.com · pro`.
2. Valid credentials with no profile and no workspace identity:
   `Signed in · plan unavailable`.
3. Populated primary identity plus a conflicting profile: primary email and plan
   retain precedence.
4. Two mixed-field rows prove fallback is per-field: primary email/profile plan,
   then profile email/primary plan.

Run:

- `bun run typecheck`
- `bun test src/cli/status-view.test.ts src/cli/status-cmd*`
- `bun run test:affected`
