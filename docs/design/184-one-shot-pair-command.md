# Design 184 — One-shot pairing command

**Status:** implemented — focused validation green; live rig handoff pending

## Problem

`rbox pair` currently prints a raw pairing token and tells the user to enter the
setup wizard on the new machine. The clipboard shortcut copies only the token.
This makes a flow that is already capable of authorizing and enrolling a device
feel like a multi-step setup procedure, and users have tried to execute the raw
token as though it were a command.

The existing direct redemption path, `rbox connect`, already consumes a pairing
token, saves the new device credential, installs the carried encryption key, and
then points the user at existing-workspace setup. The missing piece is a clear,
copyable command and matching dispatch.

## Decision

Keep one verb per action:

- `rbox pair` creates a ten-minute, single-use pairing token on an enrolled
  machine.
- `rbox connect <pairing-token>` redeems that token on the new machine,
  authorizing the device and enrolling its encryption key in one operation.

Creation prints the complete command:

```text
On the new machine, run:

    rbox connect rbox-pair_<id>.<secret>
```

On an interactive terminal, `[c]` copies that complete command rather than the
bare token. Calling `rbox connect` without an argument remains supported as the
masked-prompt/stdin form for scripts and users who prefer not to place the token
in argv.

## Accepted security tradeoff

The complete command places a bearer pairing token in shell history and briefly
in process arguments. This intentionally relaxes the previous no-argv invariant
in favor of onboarding completion. The exposure is bounded by the token's
existing properties: ten-minute expiry, atomic single use, account binding,
creator-authority revalidation, and device revocation after redemption.

Documentation must describe argv as an accepted convenience path, not claim
that tokens never enter argv. Masked prompt/stdin via `rbox connect` remains the
lower-exposure alternative.

This design explicitly supersedes design 10 resolution 4, design 12 C11, and
the 2026-06-27 `docs/learnings.md` no-bearer-in-argv rule **for short-lived
pairing tokens only**. It does not relax argv restrictions for recovery phrases,
workspace keys, long-lived device credentials, or other secrets.

## Executable-output boundary

Creation currently receives a server-returned token identifier. Turning that
response into a copyable shell command creates a command-injection boundary:
the response must never be interpolated blindly. Before displaying anything,
the client must require the server token to equal the locally requested
`rbox-pair_${tokenId}` exactly. A mismatch, newline, terminal escape, or shell
metacharacter therefore fails before output/copy. The locally appended secret
is base64url and needs no shell quoting.

## Command behavior

1. `rbox pair` retains the existing token-creation flow and rejects positional
   arguments rather than ignoring them.
2. `rbox connect <token>` dispatches directly to the existing `redeemPair` flow.
   Do not route through `rbox setup` or browser authorization.
3. Bare `rbox connect` retains the masked interactive prompt / stdin behavior.
4. More than one `connect` positional argument fails with command usage rather
   than ignoring input.
5. A successful redemption retains the existing explicit result:
   `device authorized + encryption enrolled`, followed by the existing-workspace
   setup next step.
6. Invalid, expired, or consumed tokens retain existing redemption semantics.

## Surfaces

- `src/cli/auth-cmd.ts`: generate and copy the complete command.
- `src/cli/main-dispatch.ts`: direct-argument or prompt/stdin connect dispatch.
- `src/cli/help-registry.ts`: document both forms and retain `rbox connect`.
- `README.md`, `src/cli/init-cmd.ts`, `src/cli/setup-cmd.ts`,
  `docs/customer-onboarding.md`, `docs/usage.md`, and `docs/funnel.md`: make the
  one-shot command canonical on active onboarding surfaces.
- `docs/INVARIANTS.md`, `docs/learnings.md`, and supersession notes in designs 10
  and 12: record the accepted, pairing-token-only argv exposure.
- Active comments in `auth-cmd.ts` and `main-dispatch.ts`: stop claiming that all
  pairing redemption avoids argv.
- Focused CLI tests: exact presentation/copy payload, dispatch contract, help,
  and existing authorization-plus-enrollment success output.

This changes no module ownership, API route, token format, cryptography, server
state transition, or sync-engine responsibility; `docs/CODEMAP.md` is unchanged.

## Acceptance criteria

1. `rbox pair` displays `rbox connect <token>` as the primary next-machine
   action.
2. Pressing `c` copies exactly that complete command.
3. `rbox connect <token>` invokes the existing redemption implementation.
4. Successful redemption both authenticates and encryption-enrolls the device.
5. `rbox connect` continues to read a token from a masked prompt or stdin.
6. The server token is validated against the client-requested identifier before
   it is displayed or copied; hostile and mismatched responses fail closed.
7. Tests prove `pair <arg>` fails before minting; `connect <token>` bypasses
   prompt/stdin and redeems once; bare `connect` retains TTY and stdin input;
   `connect <token> <extra>` fails before redemption; `--remote` reaches direct
   redemption; and `[c]` copies exactly the validated complete command.
8. Existing pairing integration proof must continue to show that successful
   redemption persists the device credential and carried E2EE device/master-key
   secrets, and completes `/v1/keys/admit`; a success-message-only test is not
   sufficient.
9. Focused tests, CLI typechecking, and the repository's practical validation
   suite pass.
