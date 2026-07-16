# §134 — second-device clarity

> **Status: IMPLEMENTED — 2026-07-16.** Copy and guidance only. No command,
> enrollment, encryption, account-link, or sync protocol behavior changes.

## Problem and evidence

Paying-customer feedback asks “how/what/where a pairing token is found in the
dashboard,” says “I am unclear about how I get the folder I set up to sync” on the
new MacBook, and observes that the link option calls its value a code rather than a
pairing token. The read-only recon at
`/tmp/claude-1000/-home-via-Development-Personal-rbox-core/0c3d02b0-fc6c-40c8-b9b3-36893ae901c6/tasks/a2c03bff7fbb31092.output`
confirms three distinct mechanisms:

- a terminal-only pairing token from `rbox pair`, redeemed on the new machine,
  which authorizes it and carries its encryption key;
- a confirmation code from `rbox login`, approved elsewhere, which authorizes
  the device but carries no encryption key; and
- an account-link code from the dashboard, redeemed by `rbox account link`, which
  links the web login for management and billing rather than enrolling a device.

Today the two setup choices sit together without that distinction
(`src/cli/setup-cmd.ts:250-257`), the encryption-only prompt does not rule out the
dashboard as a token source (`src/cli/setup-cmd.ts:331-335`), and successful login
or pairing stops before the workspace-attachment instruction
(`src/cli/auth-cmd.ts:30-31, 251-256, 385-388`). The web confirmation page calls
its value a “Confirmation code” (`apps/web/src/routes/cli-login/+page.svelte:91-99`),
while `/devices` has no add-machine guidance (`apps/web/src/routes/devices/+page.svelte:124-231`).

## Copy contract

Define and export `WORKSPACE_SYNC_NEXT_STEP` with this exact instruction:
`Run \`rbox setup\` and choose "Sync an existing workspace" to get your existing folder syncing here.`
Reuse it instead of maintaining variants.

- Both setup pairing-token choices reuse this exact description: `run \`rbox pair\`
  in a terminal on an already-set-up machine — never shown in the dashboard because
  it carries your encryption key`. “Approve a code” preserves its operational
  guidance and adds the distinction: `this machine shows a confirmation code you
  approve elsewhere — different from a pairing token: it authorizes but does not
  carry encryption`.
- `DEVICE_CODE_ENROLLMENT_NOTE` becomes the exact three-line sequence
  `note: device-code login authorized this machine, but encryption is not enrolled.`,
  `1. Run \`rbox pair\` on an enrolled machine or \`rbox key recover\`.`, and
  `2. ${WORKSPACE_SYNC_NEXT_STEP}`. It owns the workspace instruction for both
  `existing-keys` and race-result `already-setup`.
- Every `login()` success emits `WORKSPACE_SYNC_NEXT_STEP` exactly once. The
  `RBOX_PAIR_TOKEN` branch delegates ownership to `redeemPair()`; bootstrap prints
  it after either genesis result; device-code `existing-keys`/`already-setup` let
  the note own it, while `headless-command`/`declined`/`enrolled` print it after the
  post-approval handler. `redeemPair()` prints it after the existing
  `device authorized + encryption enrolled: <id>` line.
- `/cli-login` adds the exact clause: `This confirmation code is different from a
  pairing token: it authorizes the device, while a pairing token also carries
  encryption.` It preserves the existing explanation that approval does not unlock
  encrypted files and pairing still finishes on the device. `/link` adds: `This dashboard-link code only connects your web
  login; it is not a device confirmation code or pairing token.`
- `/devices` gets a persistent `Add another machine` hint with: `In a terminal on
  an enrolled machine, run \`rbox pair\`. On the new machine, run \`rbox connect\`
  and paste the token.` It and the
  `/link`, `/cli-login`, and dashboard “New to rbox?” surfaces link to
  `https://rbox.to/docs` with label `Read the rbox docs`. The existing external-link style in
  `apps/web/src/lib/components/api-keys-section.svelte:4, 88-93` is the model.
  The local published-site source at
  `/home/via/Development/Personal/rbox-home-page/src/pages/docs.astro:122-131` and
  built HTML give “Devices & account” no id while explicitly assigning `#agents`;
  therefore the docs root is the deepest stable device target.
- `docs/usage.md` §8 opens with: `Use a pairing token to authorize another machine
  and carry its encryption key, a device confirmation code to authorize a login
  without carrying encryption, or a dashboard account-link code to connect your web
  login for management and billing.`

## Verification and scope guard

Update exact-copy CLI tests for both setup descriptions, the numbered
enrolled-elsewhere sequence, all `login()` emission owners (including bootstrap),
and `redeemPair()` success. Run `bun run typecheck`; run `bun test src/cli` and
accept only `account status --json emits JSON` (the local signed-in-account cache
leak) and `same-SHA size mismatch commits a metadata heal without re-encrypting or
conflicting`; then in `apps/web`
run the actual scripts, `npm run check` and `npm run build`. Review the final diff
for copy/guidance-only scope: no endpoint, payload, persistence, cryptography,
polling, prompt routing, or command-flow changes. This narrow copy bundle does not
require a fleet deployment or rig scenario.
