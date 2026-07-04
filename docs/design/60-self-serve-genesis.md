# 60 — Self-serve genesis: the first machine can mint its own key world

**Status:** draft — CLI-only; NO server change.
**Depends on:** design 12 (E2EE recovery phrase, shipped), design 47 (browser/device-code
login, shipped), design 58 (recovery kit — reused verbatim for the phrase-save flow).
**Explicitly out of scope:** key rotation (design 19), server-side escrow (design 12 §NO),
any change to the server genesis endpoint (`keys.ts` is already correct).

## 1. Problem

A cold, marketed user can create an account two ways — neither reaches encryption:

- **Web signup** provisions a free account on first verified Clerk login
  (`apps/api/src/clerk.ts:118-178`). It writes `accounts`, `users`, `memberships`.
  It does NOT write `account_keys` — there is no key world yet.
- **CLI device-code login** (`src/cli/auth-cmd.ts:79-119`) authorizes the machine, then
  prints, verbatim: *"device-code login authorizes this machine but does NOT enroll it
  for encryption. To read/sync encrypted data, run `rbox pair` … or `rbox recover`."*
  (`auth-cmd.ts:106`). Both of those require a machine that is ALREADY enrolled, or a
  24-word phrase that was never minted.

The only code path that mints the master key + recovery phrase (genesis) is the
dev-gated `rbox login --bootstrap <secret>` branch (`auth-cmd.ts:60-77`): it calls
`bootstrapNewAccount` (`src/cli/e2ee-client.ts:53`) then `showRecoveryPhrase`. A cold
user has no bootstrap secret.

So the setup wizard's `resolveEnrollment` (`src/cli/setup-cmd.ts:178-223`) offers exactly
three choices — **pair / recover / later** — and a brand-new account has neither a peer to
pair from nor a phrase to recover with. **The cold user dead-ends here. This is THE launch
blocker.** Every self-serve signup lands on a screen whose only options assume a key world
that does not exist.

The fix already exists in miniature: the `--bootstrap` branch (`auth-cmd.ts:68-75`) already
does the right dance — construct an API client, `getAccountKeys()`, and if it returns null,
`bootstrapNewAccount` + `showRecoveryPhrase`; else fall back to the pair/recover message.
This design factors that dance into a reusable helper and calls it from the two paths a
cold user actually walks.

## 2. Decision

Pure client wiring. No server changes. The server genesis endpoint
(`bootstrapAccountKeys`, `apps/api/src/keys.ts:43-77`) is already race-safe and
overwrite-proof — an `INSERT OR IGNORE` claim on `account_keys`; `changes===0` → `409
already_bootstrapped` — and stays untouched.

1. **A reusable genesis helper** (in `e2ee-client.ts` or `auth-cmd.ts`): given creds/an
   `RboxApi`, call `getAccountKeys()`. Null (server 404 → client null, `remote/keys.ts`)
   means this account has NO key world → this machine is eligible to become the genesis
   device. Non-null means keys exist → NOT eligible; offer pair/recover as today.

2. **`resolveEnrollment` gains a FIRST choice, shown only when `getAccountKeys()===null`:**
   *"This is my first machine — set up encryption now"* → `bootstrapNewAccount` +
   `showRecoveryPhrase` (kit offer included — design 58 — reusing the exact functions the
   `--bootstrap` path calls). When keys exist, the choices stay **pair / recover / later**,
   byte-for-byte as today, and the current "authorized but NOT enrolled" copy is unchanged.

3. **Device-code login (post-approval), `auth-cmd.ts:103-107`:** replace the flat "does NOT
   enroll" note with a `getAccountKeys()` check. Null + TTY → offer genesis inline; null +
   headless → print the exact command to run (never auto-mint, §2.5). Non-null → keep
   today's pair/recover note verbatim.

4. **Race / abuse.** Two fresh devices racing genesis: the first wins the server `INSERT OR
   IGNORE`; the second gets `409 already_bootstrapped`, catches it, re-fetches keys, and
   falls back to the pair/recover message — no error surfaced to the user, no partial
   state. An authorized-but-unenrolled device on an EXISTING account can never reset keys:
   the server refuses to overwrite `account_keys`, so even a coerced client genesis attempt
   409s and degrades to pair/recover.

5. **Headless / no-TTY: never auto-mint.** A non-interactive genesis prints instructions
   (the explicit command) and exits without touching key material — minting a master key is
   a decision that must be made by a human at a prompt, or by an explicit opt-in flag, never
   as a side effect of an unattended login. `rbox init --no-interactive` behavior is
   unchanged.

## 3. Mechanism

```
getAccountKeys()  →  null                     →  non-null
                     (no account_keys row)        (key world exists)
   ┌──────────────────────────────────┐        ┌────────────────────────────┐
   │ TTY:      offer "first machine"   │        │ offer pair / recover       │
   │           → bootstrapNewAccount   │        │ (unchanged copy + choices) │
   │           → showRecoveryPhrase    │        └────────────────────────────┘
   │             (+ recovery-kit, §58) │
   │ headless: print genesis command,  │
   │           mint nothing            │
   └──────────────────────────────────┘
```

- **Detection is a live `getAccountKeys()` call, not `alreadyEnrolled()`.**
  `alreadyEnrolled` (`setup-cmd.ts:113`) checks only for a LOCAL device record
  (`hasDevice`) — it says nothing about whether the account has a key world. The genesis
  gate must ask the server, because "no keys anywhere" and "keys exist but not on this box"
  are different states that need different offers.
- **Genesis body is 100% reuse.** `bootstrapNewAccount` (POSTs the recovery wrap, genesis
  roster v0, genesis key-state epoch 0, and this device's keys to
  `/v1/keys/bootstrap`) and `showRecoveryPhrase` (phrase display + nag-until-ack + the
  design 58 kit offer) are the same functions the `--bootstrap` branch invokes. This design
  adds a caller, not a code path.
- **`resolveEnrollment` copy split.** Today it unconditionally prints "authorized but NOT
  yet enrolled … pair/recover". When `getAccountKeys()===null` it must instead frame the
  first-machine choice — there is no peer to pair from, so the old copy would misdirect.

## 4. Security & privacy

- **Client-side gating on `getAccountKeys()===null` is advisory UX, not the security
  boundary.** The real guard is the server's `INSERT OR IGNORE` on `account_keys`
  (`keys.ts:62-66`): the account's key world can be seeded exactly once, by whoever wins the
  claim, and never overwritten. The client check only decides which prompt to show; if it is
  wrong (stale read, TOCTOU race), the server 409 makes the wrong choice safe — the client
  catches it, re-reads, and degrades to pair/recover. There is no client assertion the
  server trusts.
- **An unenrolled device on an existing account cannot reset keys.** Even with valid creds
  for account X that already has a key world, a genesis attempt is an `INSERT OR IGNORE`
  that finds the row present → `changes===0` → 409. No roster reset, no epoch reset, no MK
  re-wrap. Key resurrection is structurally impossible from this path.
- **Anti-spoof unchanged.** `bootstrapAccountKeys` still requires the bootstrapping device
  to be the authenticated caller's own device (`deviceId === p.deviceId`, `keys.ts:58`); the
  genesis helper passes the caller's real `deviceId`.
- **Phrase handling reuses design 58.** Display + acknowledge loop + the recovery-kit file
  (0600, atomic write) are the shipped `showRecoveryPhrase` flow — no new phrase-handling
  surface, no new place the phrase is written. Headless paths still print-and-warn without
  writing a kit (design 58 §2.2).
- **No escrow, unchanged.** The server stores only the opaque recovery wrap; rbox still
  cannot decrypt anything. Self-serve genesis mints the same zero-knowledge world the
  `--bootstrap` path always did — it just lets a cold user reach it.

## 5. Test plan

**Unit (new branch logic):**
- Genesis helper with `getAccountKeys()` stubbed null → invokes `bootstrapNewAccount` +
  `showRecoveryPhrase`; stubbed non-null → does neither, returns the pair/recover signal.
- `resolveEnrollment`: null-keys renders the first-machine choice and, on selection, calls
  the genesis helper; non-null renders exactly the current three choices with unchanged copy.
- Device-code post-approval: null + TTY offers inline genesis; null + non-TTY prints the
  command and mints nothing (assert `bootstrapNewAccount` NOT called); non-null prints the
  today verbatim pair/recover note.
- Race: helper sees null, `bootstrapNewAccount` throws the 409-mapped error → helper catches,
  re-fetches keys, returns the pair/recover fallback (no throw to caller).

**Rig scenario — `web-first-genesis` (new variant of `onboard-smoke`):**
The rig today conflates account creation and genesis in one step: `provisionPair` runs
`rbox login --bootstrap "$RIG_BOOT" --no-interactive` (`scripts/rig/scenarios/preamble.ts:52-56`),
whose client half auto-runs `bootstrapNewAccount`. That never exercises the cold-user
login→genesis code — it takes the `--bootstrap` fast path.

Proposed tweak (respects §2.5 "headless never auto-mints" — the mint stays an EXPLICIT
opt-in, not an unattended side effect):
1. **A** provisions the account WITHOUT genesis — an authorize-only variant that creates the
   account + device token but skips the client `bootstrapNewAccount`, leaving
   `account_keys` empty (the web-provisioned state). This needs a small, opt-in bench
   affordance (e.g. `login --bootstrap … --no-genesis`, or a dedicated authorize-only rig
   step) so the account lands keyless.
2. Assert the keyless state: `rbox key status` / a `getAccountKeys` probe reports no key
   world.
3. **A** runs an EXPLICIT non-interactive genesis (`rbox init --genesis` / `rbox key genesis
   --yes`, the opt-in analogue of §2.5) → exercises the same genesis helper the interactive
   `resolveEnrollment` path calls, mints keys, prints the phrase.
4. Continue the `onboard-smoke` handshake unchanged: pair B, join, push A / pull B, assert
   byte-identical convergence and clean teardown.

This proves the cold-account → genesis wiring end-to-end while keeping the auto-mint-never
invariant (the bench mints only via an explicit flag, never implicitly).

## 6. Out of scope

- The server genesis endpoint (`keys.ts`) — already correct; touching it is forbidden here.
- Key rotation / phrase re-mint after leak (design 19).
- Server-side escrow or recovery (design 12 §NO) — permanently out.
- Web-dashboard-driven genesis (minting keys from the browser). Genesis stays CLI-only; the
  web account is keyless until a CLI device seeds it.
- Multi-user org provisioning beyond the single genesis device (roster growth is the normal
  pair/join flow, untouched).
