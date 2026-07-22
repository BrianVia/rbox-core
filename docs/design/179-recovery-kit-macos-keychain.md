# 179 — recovery kit: macOS Keychain instead of a plaintext Downloads file

Status: v2 — DRAFT (resurrected from stranded branch claude/recovery-key-keychain-design-wx4mbs after number 166 was recycled; v2 adds the logged-in re-save flow, founder-directed 2026-07-22). Pending adversarial review.
Owner: Claude (founder-directed, 2026-07-20)
Origin: onboarding-ux backlog item #6 (macOS keychain), referenced from
`docs/validation-2026-07-18-new-user-flow.md`.

## Problem

When the user opts into a recovery kit, the 24-word recovery phrase is written
in PLAINTEXT to `~/Downloads/rbox-recovery-kit-<hex16>-<ymd>.txt` (mode 600):

- Target selection: `kitTargetDir` prefers `~/Downloads` when it exists
  (`src/cli/recovery-kit.ts:50-52`, `:90-98`).
- Write + verify + status record: `writeRecoveryKit`
  (`src/cli/recovery-kit.ts:112-133`), recorded in
  `~/.rbox/e2ee/<accountId>/kit.json` (`:160-182`).
- Call sites: genesis/backup/recover flows in `src/cli/auth-cmd.ts`
  (`showRecoveryPhrase:49`, `offerOrWriteKit:522`,
  `offerRecoveryKitAfterRecover:532`, `writeKitSuccess:567`), status line at
  `recoveryKitStatusLine:574`.

`~/Downloads` is the worst plausible location for long-lived key material: it
is indexed by Spotlight, often synced to iCloud Drive ("Desktop & Documents"
does not cover Downloads, but many users add it to cloud-sync tools), scanned
by every "cleanup" utility, and is the default read scope users grant to
arbitrary apps. On macOS the OS ships a purpose-built secret store — the login
Keychain — with at-rest encryption, unlock gating, and a GUI (Keychain
Access / Passwords) the user can retrieve the phrase from later.

Design 12 already called OS-keychain storage "future hardening"
(`docs/design/12-full-e2ee.md:649`). This design does that hardening for the
**recovery kit** only. It does NOT move `device.json` / `mk.key` / `rk.key`
(`src/cli/e2ee-keystore.ts`) into the Keychain — those are read on every
daemon start and sync; gating them on keychain unlock would break headless
operation. They remain mode-600 files per design 12 §13.1.

## Goals

1. On macOS, the default "save a recovery kit" action stores the phrase as a
   Keychain generic-password item, not a plaintext file.
2. The phrase never appears in process argv (visible via `ps`) or in any shell
   history/temp file on its way into the Keychain.
3. `rbox key status` keeps working: it must report where the kit lives and
   whether it is still present, without triggering Keychain auth prompts.
4. Explicit file output remains available (`--kit-path`), and non-macOS
   behavior is unchanged.
5. Honest UX: a Keychain item is machine-local. Saving it must not be oversold
   as an off-machine backup.

## v2 addition: re-save for already-logged-in users (the Max path)

Existing users predate this design entirely — their phrase was either written
to the plaintext Downloads kit, or never saved anywhere. Requirement
(founder, 2026-07-22): "if you're logged in you're given an opportunity to
re-save your recovery key to macOS Keychain."

- **Derivability**: a logged-in device holds `rk.key`
  (src/cli/e2ee-keystore.ts), from which the 24-word phrase re-renders — the
  existing `showRecoveryPhrase` path in src/cli/auth-cmd.ts proves this.
  The re-save flow reuses that derivation; it never asks the user to type
  the phrase.
- **Surfaces**:
  1. Explicit command: `rbox key save` (macOS: Keychain by default,
     `--kit-path` for file; verb name final after review) — works any time
     on a logged-in device.
  2. One-time offer on an interactive touchpoint: when a logged-in macOS
     user runs `rbox key status` (or completes `rbox login`) and the kit
     record shows NO Keychain item (missing, plaintext-only, or none), print
     a one-line offer with the exact command. The offer is shown at most
     once per account (recorded in kit.json), never in non-TTY contexts,
     and is a nudge — not a prompt loop.
- **Plaintext cleanup**: after a verified Keychain save, if a plaintext kit
  file from the old path is still on disk and its content matches the
  phrase, offer deletion (explicit consent; never silent).
- **kit.json schema**: the tagged-union record (§ record schema below) gains
  the provenance needed to distinguish "saved to keychain on <date>" from
  "plaintext kit at <path>" from "declined" — `rbox key status` reports
  which state the account is in, in plain English.

## Non-goals

- Moving MK / device keys / cached RK into the Keychain (future design).
- iCloud Keychain sync of the item (`security(1)` cannot set
  `kSecAttrSynchronizable`; would need Security.framework FFI — see
  Alternatives).
- Linux secret-service / Windows credential-manager equivalents (same seam
  can host them later; out of scope).
- Any server/API change. This is entirely client-side.

## Design

### 1. Mechanism: `/usr/bin/security` via stdin, never argv

rbox ships as a single Bun-compiled binary; native modules (keytar-style) are
a build/signing liability. macOS ships `/usr/bin/security` on every install,
on a SIP-protected path. We invoke it by **absolute path** (never PATH
resolution — same containment ethos as `hydrate-cmd`).

`security add-generic-password -w <phrase>` would leak the phrase to `ps`
for the lifetime of the process. Instead we run `security -i` (interactive
command mode) and write the full command on **stdin**:

```
/usr/bin/security -i <<EOF
add-generic-password -U -s "rbox recovery phrase" -a "<accountId>" \
  -l "rbox recovery phrase (<accountHex16>)" \
  -j "24-word rbox recovery phrase. Restore: install rbox, rbox login, rbox key recover." \
  -w "<phrase>"
EOF
```

Quoting is safe by construction: the phrase is 24 lowercase BIP39 words
joined by single spaces (`src/engine/e2ee/recovery.ts:32-38`). Before writing
we assert `/^[a-z]+( [a-z]+){23}$/`; on mismatch we refuse the keychain path
(defense in depth — we generated the phrase, so this cannot fire) and fall
through to the failure handling in §5. Account ids are `acct_<16hex>`
(`accountHex16`, `src/cli/recovery-kit.ts:190-194`) — also trivially safe to
quote.

Item shape:

| Attribute | Value | Why |
|---|---|---|
| service `-s` | `rbox recovery phrase` | Human-searchable in Keychain Access ("rbox"). |
| account `-a` | full `acct_…` id | One item per rbox account; multi-account safe. |
| label `-l` | `rbox recovery phrase (<hex16>)` | List display name. |
| comment `-j` | one-line restore instructions | Replaces the kit file's "How to recover" body. |
| secret `-w` | the bare 24-word phrase | "Show password" in Keychain Access shows exactly what `rbox key recover` asks for. Not the rendered kit text — that would make GUI retrieval a copy/paste minefield. |
| `-U` | update-if-exists | Re-running `rbox key backup --kit` is idempotent, matching today's overwrite-refusing-but-recordable file semantics without the `wx` collision problem. |

No `-T` flags: the default ACL trusts the creating app (`security` itself),
so our own later reads work non-interactively while any *other* app reading
the secret triggers a user consent prompt — exactly the posture we want.

The subprocess gets a hard timeout (proposed 15 s). A locked keychain in a
GUI session can pop an unlock dialog; if the user walks away we kill the
child and treat it as failure (§5) rather than hanging `rbox setup`.

### 2. Verification

Mirroring today's read-back verification (`src/cli/recovery-kit.ts:122-123`):
after the add, run

```
/usr/bin/security find-generic-password -s "rbox recovery phrase" -a "<accountId>" -w
```

and require stdout (trimmed) to equal the phrase. ASCII secrets are printed
raw by `-w` (hex-encoding only happens for non-printable data, which our
charset check excludes). Any mismatch or non-zero exit ⇒ the write is
reported failed; we do not record it.

### 3. Status record and `rbox key status`

`kit.json` (`RecoveryKitRecord`) grows a discriminator:

```jsonc
// file kit (today's shape, unchanged — kind omitted ⇒ "file")
{ "path": "/Users/b/Downloads/rbox-recovery-kit-….txt", "writtenAt": "…" }
// keychain kit
{ "kind": "keychain", "service": "rbox recovery phrase",
  "account": "acct_…", "writtenAt": "…" }
```

- `readRecoveryKitRecord` accepts both; absent `kind` ⇒ `"file"` (forward
  compat: an **older** CLI reading a keychain record fails its
  `path`/`writtenAt` string check and degrades to "none recorded" — safe).
- Presence probe for keychain kits: `find-generic-password` **without `-w`**
  (metadata only — no secret read, no auth prompt, works with a locked
  keychain). Exit 0 ⇒ `present`; item-not-found ⇒ `missing`. The file-kit
  `unrecognized` state has no keychain analog; content is only verified at
  write time (§2).
- Status lines (`recoveryKitStatusLine`):
  - `recovery kit: macOS Keychain "rbox recovery phrase" (written 2026-07-20)`
  - missing ⇒ `… (item deleted — re-run rbox key backup --kit)`
- `key status --json`: `recoveryKit` gains `kind`; keychain records emit
  `{kind, service, account, writtenAt}` and file records keep today's
  `{path, writtenAt}` plus `kind:"file"`. Documented as an additive change.

### 4. Flag & flow semantics

Decision table for `writeRecoveryKit` targets:

| Condition | Target |
|---|---|
| `--kit-path <p>` given (any OS) | file at `p` — explicit path always wins; this is also the escape hatch for "I want a file on macOS". |
| darwin + `/usr/bin/security` exists | Keychain item. |
| otherwise | file in `~/Downloads` / `$HOME` (unchanged). |

This applies uniformly to every current action (`recoveryKitAction`,
`src/cli/recovery-kit.ts:43-48`): interactive offer, `--kit` write, and
non-interactive `--kit` (`write-suppress-echo`). A non-interactive `--kit` on
macOS therefore switches from writing a file to writing a keychain item —
an intentional, changelog-noted behavior change; scripts that need the old
behavior pass `--kit-path`.

Prompt copy (interactive offer, darwin):

> `Save your recovery phrase to the macOS Keychain (view later in Keychain Access — search "rbox")?` [Y/n]

Success output replaces the path echo:

> `✓ recovery phrase saved to the macOS Keychain (search "rbox" in Keychain Access)`
> `  note: the Keychain copy lives only on this Mac — keep a copy somewhere else too.`

A saved keychain kit short-circuits the "Have you saved this phrase?" loop
exactly as a file kit does today (`auth-cmd.ts:57`) — the machine-loss
exposure is identical to the Downloads file, and the note above keeps the
limitation explicit.

### 5. Failure handling — never silently downgrade to plaintext

Keychain write failures are real: locked login keychain over SSH
(`errSecInteractionNotAllowed`), user cancels the unlock dialog, timeout,
MDM-restricted keychains.

- **Interactive**: report the failure, then fall back to the *existing* file
  offer with its scary wording intact:
  `keychain save failed (<reason>) — save a PLAINTEXT file to ~/Downloads instead?`
  (default Yes, matching today's offer default). The user explicitly
  re-consents to plaintext; nothing happens silently.
- **Non-interactive `--kit`**: fail the command with an actionable error
  (`writeKitOrThrow` already propagates): suggest `--kit-path <path>` for an
  explicit plaintext kit or re-running in a GUI session. No silent fallback —
  a script that asked for "the secure default" must not get plaintext
  because a keychain happened to be locked.

### 6. Migrating off an existing plaintext kit

After a successful keychain write, if the previous record was a file kit
whose state is `present` (banner verified — `recoveryKitFileState`,
`src/cli/recovery-kit.ts:145-154`), interactively offer:

> `Delete the old plaintext kit at ~/Downloads/rbox-recovery-kit-….txt?` [Y/n]

Only banner-verified files are ever deleted (we never remove a file the user
replaced with their own content — `unrecognized` and `missing` states get a
printed note instead). Non-interactive runs never delete; they print the old
path with a "consider deleting" note. Deletion failures are warnings, not
errors. The record is updated to the keychain shape regardless.

Logout / `forgetLocalDeviceMaterial` intentionally does NOT delete the
keychain item: it is a recovery artifact, not session state, and deleting the
last copy of key material on logout would be actively harmful.

### 7. Code shape & seams

New module `src/cli/recovery-kit-keychain.ts`:

```ts
export interface KeychainSeams {           // injectable for tests
  platform: NodeJS.Platform;               // default process.platform
  securityBinExists(): Promise<boolean>;   // stat /usr/bin/security
  runSecurity(stdinScript: string, timeoutMs: number):
    Promise<{ code: number; stdout: string; stderr: string }>;
}
export function keychainKitAvailable(seams?): Promise<boolean>;
export function writeKeychainKit(phrase, accountId, seams?): Promise<KeychainKitRecord>;
export function keychainKitState(record, seams?): Promise<"present" | "missing">;
```

`writeRecoveryKit` becomes the single dispatcher over the §4 decision table
so all call sites in `auth-cmd.ts` / `setup-cmd.ts` inherit the behavior
without per-call-site branching; `RecoveryKitRecord` becomes the tagged union
of §3. Pure helpers (command construction, phrase-charset assertion, record
(de)serialization, decision table) stay side-effect free for unit testing,
matching the existing `kitTargetDir` / `recoveryKitAction` style.

## Security & privacy analysis

- **argv leak**: eliminated by `security -i` + stdin (§1). The stdin script
  exists only in the pipe; it is never written to disk or a shell.
- **At rest**: Keychain items are encrypted with keys derived from the login
  password and unlocked per-session — strictly better than a mode-600
  plaintext file readable by any process running as the user.
- **Read ACL**: default creating-app ACL means third-party apps reading the
  secret trip a user consent prompt; Keychain Access "show password"
  requires the login password.
- **Residual echo**: the phrase is still echoed to the terminal at
  genesis/backup (`auth-cmd.ts:55`) — unchanged by this design, and required
  (the user must be able to write it down). `--kit` non-interactive keeps its
  suppress-echo behavior with the keychain as target.
- **Machine-locality (honest limitation)**: `security(1)` cannot mark items
  synchronizable, so the item does not follow the user via iCloud Keychain.
  A dead Mac takes its keychain kit with it. This is identical exposure to
  the Downloads file it replaces, and the post-save note plus the unchanged
  "no escrow" warnings keep the burden of off-machine backup on the user.
- **Locked-keychain probing**: status checks avoid `-w` (metadata only), so
  `rbox key status` never pops auth dialogs or fails on a locked keychain.

## Alternatives considered

- **Security.framework via Bun FFI (`SecItemAdd`)** — no subprocess, could
  set `kSecAttrSynchronizable` (iCloud sync) and access groups. Rejected for
  v1: CoreFoundation memory/bridging complexity in a compiled Bun binary,
  and access-group ACLs drag code-signing entitlements into the release
  pipeline. The seam in §7 leaves room to swap the backend later.
- **keytar / native npm modules** — native-module builds conflict with the
  single-binary release flow. Rejected.
- **`add-generic-password -w <phrase>` as argv** — `ps`-visible secret.
  Rejected outright.
- **Store the rendered kit text as the secret** — Keychain Access would show
  a wall of text where the user expects the phrase. Instructions moved to
  the comment attribute instead.
- **Keep writing the file but to `~/Library/Application Support/rbox`** —
  still plaintext-at-rest, loses the "user can find it" property that
  Downloads had. Rejected: worst of both.

## Testing

1. **Unit (all platforms, no macOS needed)**: command construction &
   quoting, phrase-charset assertion (fuzz words with `"`/`\`/newline must
   refuse), decision table (§4), record round-trip + back-compat (`kind`
   absent ⇒ file), status-line rendering, failure-path routing (§5) with a
   faked `KeychainSeams` returning canned exit codes/timeouts.
2. **Integration (darwin-gated, skipped elsewhere)**: against a throwaway
   keychain created with `security create-keychain` in a temp dir — add,
   verify round-trip, presence probe, `-U` idempotence, delete — never
   touching the login keychain in CI.
3. **Manual founder validation (per repo flow)**: fresh `rbox setup` on a
   real Mac — keychain prompt/consent behavior, Keychain Access findability
   ("rbox" search, show-password), SSH-into-Mac locked-keychain failure path,
   and the plaintext-kit migration offer (§6).

## Slices

1. `recovery-kit-keychain.ts` (seams, write, verify, probe) + record-schema
   union + unit tests.
2. Dispatcher in `writeRecoveryKit` + prompt/status/JSON copy changes in
   `auth-cmd.ts` / `setup-cmd.ts` + `--kit-path` escape-hatch docs
   (`help-registry.ts` flag text).
3. Plaintext-kit migration offer (§6) + darwin-gated integration test +
   CHANGELOG note for the non-interactive `--kit` behavior change.

## Open questions (for review)

1. Should the interactive **fallback-to-plaintext** default be Yes (parity
   with today's offer) or No (secure-by-default after a keychain failure)?
   Design currently says Yes to avoid stranding first-run users.
2. Is a 15 s subprocess timeout right for the unlock-dialog case, or should
   interactive runs wait longer (say 60 s) since a human may legitimately be
   typing their password?
3. Do we want an `RBOX_KIT_BACKEND=file` env override for fleet automation,
   or is `--kit-path` sufficient? (Design says sufficient.)
