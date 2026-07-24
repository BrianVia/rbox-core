# 195 — Auth command decomposition

Status: ALIGNED

## 1. Problem

`src/cli/auth-cmd.ts` is 2,171 lines and combines independently changing
domains: first-account genesis, device-code login and key delivery, pairing and
device administration, and recovery-key/recovery-kit commands. The size does
not protect one necessary shared closure; it forces unrelated reviewers and
changes to load every auth invariant at once.

This is a behavior-preserving source decomposition. It does not change command
output, exports, prompt order, persistence order, request bytes, retry policy,
durable formats, or server APIs.

## 2. Goals and non-goals

Goals:

- make `auth-cmd.ts` a stable explicit compatibility barrel with no logic;
- give each workflow and transaction one owner;
- preserve every existing runtime and type export;
- keep crash-sensitive genesis, recovery, and login-attempt ordering direct;
- move raw auth requests into an exact endpoint-shaped compatibility wire;
- stop after this auth decomposition.

Non-goals:

- no protocol, UX, retry, timeout, error-message, or policy changes;
- no generic command framework or dependency-injection container;
- no convergence of the legacy command wire with `RemoteContext`;
- no decomposition of another ranked CLI file.

## 3. Target ownership

### `src/cli/auth-cmd.ts`

Explicit named value/type re-exports only. Never: logic, state, wildcard
exports, or engine/remote dependencies.

### `src/cli/auth/presentation.ts`

Dependency leaf for `AuthPresentationContext`, shared enrollment/next-step
messages, and pure message projections. Never: I/O or auth implementation
imports.

### `src/cli/auth/session.ts`

Sole owner of strict credential loading for authenticated commands and
`logout`/session clearing. Never: login, pairing, enrollment, or transport.

### `src/cli/remote/auth-command-wire.ts`

Exact legacy command-wire compatibility owner for the raw auth requests
currently issued by `auth-cmd.ts`: device start/poll/bootstrap, delivery ACK,
approve, device list, pair creation, and revoke. Endpoint-shaped functions
construct the exact request and return raw `Response`.

It deliberately does not use `RemoteContext`. Preserve URL concatenation,
request counts, bodies, public `content-type`-only headers, bearer-only
authenticated additions, and the absence of thrown-fault retry, timeout, or
translation.

Never: prompting, persistence, response policy, retry/backoff interpretation,
friendly error decisions, or enrollment. Existing `remote/keys.ts::pairCreate`
and `RboxApi.pairCreate` remain untouched. Only `src/cli/auth/` command modules
may import this compatibility lane.

### `src/cli/auth/recovery-kit-flow.ts`

Ordinary recovery phrase presentation, kit/Keychain writing and discovery,
post-recovery offers, status projection, and plaintext cleanup. Never: genesis
intent, progress, or receipt manipulation.

### `src/cli/auth/genesis-destination-flow.ts`

Sole owner of the genesis destination transaction: destination selection,
verification/execution, intent replacement, progress events, and receipt-bound
completion. This module alone manipulates
`AtomicGenesisDestinationSetContext`, destination progress, or destination-set
receipts.

### `src/cli/auth/genesis-command.ts`

Owns `runGenesisEnrollment`, `completeAtomicGenesis` callback orchestration, and
`completeStagedGenesisRecoveryKit`. It may invoke the destination flow's one
completion entry point but may not manipulate its progress/receipt internals.

### `src/cli/auth/device-login.ts`

Owns the pure device-login FSM, login-attempt orchestration, post-approval
enrollment, and `login`. `session.ts` solely owns logout.

### `src/cli/auth/pairing-command.ts`

Owns pair create/redeem, token input, connect-command construction, and pairing
presentation. It depends on `presentation.ts`; device login may depend on it for
explicit-token and fallback enrollment. Never imports `device-login.ts`.

### `src/cli/auth/device-commands.ts`

Owns approve/list/revoke device administration.

### `src/cli/auth/recovery-command.ts`

Owns `recoverCmd`, recovery enrollment selection, and Keychain phrase discovery.
The account/genesis lock continues spanning pending cleanup, phrase selection,
persistence, and admission.

### `src/cli/auth/key-commands.ts`

Owns key status/genesis/backup/save command entry points.

## 4. Dependency direction

```text
auth-cmd.ts (explicit barrel)
  ├── auth/device-login.ts
  │     ├── remote/auth-command-wire.ts
  │     ├── auth/pairing-command.ts
  │     ├── auth/genesis-command.ts
  │     └── auth/presentation.ts
  ├── auth/session.ts
  ├── auth/device-commands.ts
  │     └── remote/auth-command-wire.ts + auth/session.ts
  ├── auth/pairing-command.ts
  │     └── remote/auth-command-wire.ts + auth/session.ts + auth/presentation.ts
  ├── auth/recovery-command.ts
  │     └── auth/genesis-command.ts + auth/recovery-kit-flow.ts
  ├── auth/key-commands.ts
  │     └── auth/genesis-command.ts + auth/recovery-kit-flow.ts
  └── auth/genesis-command.ts
        └── auth/genesis-destination-flow.ts + auth/recovery-kit-flow.ts

presentation.ts              -> no auth implementation modules
session.ts                   -> credentials/account-profile/autostart status
remote/auth-command-wire.ts  -> raw fetch only
recovery-kit-flow.ts         -> recovery-kit* only
genesis-destination-flow.ts  -> genesis-durable + destination adapters
genesis-command.ts           -> genesis-seam + e2ee-client genesis APIs
device-login.ts              -> login-attempt-journal + credentials
pairing-command.ts           -> e2ee-client pairing APIs
recovery-command.ts          -> e2ee-client recovery APIs
```

No internal auth module imports `auth-cmd.ts`.

## 5. Behavior-preservation invariants

1. `main-dispatch.ts`, `setup-cmd.ts`, `init-cmd.ts`, `front-door.ts`, and every
   `typeof import("./auth-cmd.js")` consumer see the same value/type exports.
2. The existing static/dynamic import surface remains unchanged.
3. Login transaction islands remain direct and co-located:
   - start response -> durable attempt staging -> approval URL;
   - under genesis locks: local-device inspection -> journal reservation ->
     credential save -> credential-saved checkpoint -> lock release;
   - ready delivery: enrollment with persisted checkpoint -> ACK -> fulfilled;
   - persisted resume: credential verification -> exact delivered/ready refetch
     -> ACK -> fulfilled.
4. The approval-copy listener is closed and awaited before fallback prompting.
5. Genesis intent is durable before destination writes, progress is durable
   after each completion, and cleanup remains behind the same receipt.
6. `recoverCmd` retains one lock across pending cleanup, phrase selection,
   persistence, and admission.
7. Recovery phrases never enter JSON, logs, thrown messages, or new durable
   objects.
8. Prompt order, defaults, copy, retry counts, strings, request URLs, headers,
   bodies, counts, and thrown-fault behavior remain exact.

## 6. Migration sequence

1. Add `auth/presentation.ts`.
2. Extract pairing while retaining explicit barrel re-exports.
3. Extract `remote/auth-command-wire.ts` with exact wire tests.
4. Extract recovery-kit sinks/presentation only.
5. Extract genesis destination and genesis transaction islands whole.
6. Extract the device-login transaction island whole.
7. Extract recovery, key, session, and device commands.
8. Add checked export-surface fixtures before replacing the implementation:
   - `auth-cmd-surface.test.ts` owns runtime `Object.keys`, explicit barrel-list
     parsing, and import-cycle checks;
   - `auth-cmd-surface.typecheck.ts` is included by the root TypeScript project,
     imports every public value/type through the barrel, and asserts
     bidirectional type equality against owner exports.
9. Replace `auth-cmd.ts` with exhaustive explicit named re-exports.
10. Keep every existing test importing `auth-cmd.ts`; owner-direct tests are
    additive.
11. Run focused tests and typecheck after every extraction.
12. Update CODEMAP only for `remote/auth-command-wire.ts`; command modules remain
    outside its declared scope.

No opportunistic renames or behavioral cleanup during relocation.

## 7. Validation

Required:

- all existing auth, login-attempt, credential-policy, genesis, recovery-kit,
  E2EE-client, dispatch, JSON, and setup tests;
- `bun test src/cli/auth-cmd-surface.test.ts`;
- `bun test src/cli`;
- `bun run typecheck` including `auth-cmd-surface.typecheck.ts`;
- `bun run guards`;
- `bun run typecheck:rig`;
- `bun run test:rig`;
- `bun run dev:install -- --outfile /tmp/rbox-auth-195`;
- `/tmp/rbox-auth-195 --help`;
- `/tmp/rbox-auth-195 login --help`;
- `/tmp/rbox-auth-195 connect --help`;
- `/tmp/rbox-auth-195 pair --help`;
- `/tmp/rbox-auth-195 device --help`;
- `/tmp/rbox-auth-195 key --help`;
- `bun run rig run web-pairing`.

The surface test parses relative imports below `src/cli/auth/` plus
`remote/auth-command-wire.ts` and rejects cycles or internal imports of
`auth-cmd.ts`.

Add a crash-after-ACK-before-finish characterization before moving login:
construct a persisted attempt whose server poll is already `delivered`, resume,
and prove one idempotent ACK, fulfilled journal state, and zero enrollment calls.

The rig proves consented key delivery/decryption and server non-delivery for
no-consent approval. The existing legacy/no-consent CLI unit test remains
mandatory because the rig's negative login is intentionally terminated.

If the live dev rig is unavailable, this work remains incomplete.

## 8. Review bar

Fail review if the barrel contains logic, a new module is a pass-through
wrapper, ownership overlaps, transport semantics change, persistence/ACK order
becomes indirect, `auth-cmd.ts` exceeds 300 lines, or an implementation module
exceeds 700 lines without an ordering/state-machine justification.
