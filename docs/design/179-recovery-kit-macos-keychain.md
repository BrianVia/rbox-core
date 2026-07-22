# 179 — recovery kit: macOS Keychain instead of a plaintext Downloads file

Status: v6 — DRAFT (round-1 through round-4 findings folded under founder-pinned rulings; post-fold adversarial review aligned, 2026-07-21).

Round-1 ruling record (pinned; one line per finding):

1. Phrase source — save cached `rk.key` without typing; otherwise accept a no-echo typed phrase and validate it against this account's recovery envelope before storage; genesis/backup/recover offer their in-hand phrase; no new RK-recovery mechanism.
2. ACL — accept `/usr/bin/security`'s default creating-application ACL with an honest same-user threat model; reject a Security.framework/helper backend and `-T ""` for the reasons in Alternatives.
3. `security -i` — send one physical UTF-8 command line plus LF, strictly under 4096 bytes, and test the exact production byte stream.
4. Keychain identity — resolve one explicit login Keychain, persist its canonical identity, and pass it to add, verify, probe, and restore.
5. Plaintext cleanup — require exact current account + canonical phrase equality and repeat bounded no-symlink validation immediately before unlink.
6. Record schema — replace the tagged union with a strictly parsed, versioned envelope whose keychain artifact, plaintext artifacts, and offer metadata are orthogonal.
7. Offer — promise once per account per local installation, use an atomic claim, adapt copy to the available phrase source, and keep `--json` nudge- and mutation-free.
8. Uninstall — consume live artifact safety states; missing/unrecognized/declined are at risk and probe/parse failure is risk unknown, never safe.
9. Probe — return `present | missing | unavailable`; only the classified `errSecItemNotFound` exit means missing.
10. Process/flows — use a shell-free bounded spawn contract, a separate no-echo `key save` path, explicit TTY rules, and wizard plumbing while its phrase is live.
11. Wording/citations — say not iCloud Keychain-synchronized, use Keychain Access as the supported UI, drop universal login-password claims, and refresh all source lines.

Round-2 ruling record (pinned; one line per finding):

1. No-loss genesis — non-interactive macOS genesis with `--kit` durably stages RK through the existing `rk.key` cache before publish; only a verified Keychain/file commitment permits cleanup, after which the original `cacheRecovery` preference is restored, with staged state visible in `key status` until resolved.
2. Wrong Keychain phrase — a checksum-valid Keychain candidate that fails account-envelope validation emits only a redacted warning and falls through to manual entry before admission persistence; failures after persistence retain ordinary recovery semantics.
3. TTY gates — two TTYs gate only new Keychain offers/prompts; the existing stdin-only manual-recovery gate is unchanged, with all four stdin/stderr combinations specified below.
4. Restore metadata — only a recognized record containing validated Keychain metadata supplies an identity; otherwise resolve login Keychain exactly once, and after recovery atomically merge `discoveredAt` metadata without disturbing plaintext/offer axes; record failure is nonfatal and unknown records remain untouched.
5. Restore tests — cover the four-way TTY matrix, decline, valid-but-wrong fallback, one-shot resolution and identity propagation, exact account selection, merge preservation, and nonfatal record-write failure.
6. Daemon rationale — only device/MK operational material is required by daemon/sync; optional `rk.key` is loaded by status/backup, not used as daemon rationale.

Round-3 ruling record (pinned; one line per finding):

1. Lost bootstrap response — retain transport retries; on `already_bootstrapped`, fetch and compare the published genesis material with this attempt: an exact match is this attempt's lost-response success and continues with staged RK intact, while a mismatch is a genuine competing genesis and takes the existing cleanup path.
2. Durable keystore mutations — RK, staging, and commitment-locator writes require same-directory atomic temp+rename publication, exact read-back, and file plus parent-directory fsync; unlink requires parent-directory fsync. This is a new contract, not a property of today's `e2ee-keystore` helpers.
3. Restore merge — rediscovery preserves the independent staging axis unchanged; under the locked re-read it merges only a same-identity Keychain artifact, while a concurrent different identity is preserved and warned about. Tests cover both staging preservation and identity conflict.
4. Cache preference — capture the user's original `cacheRecovery` value before genesis staging forces caching, persist that original value, and restore it only after commitment.
5. Manual stdin wording — the unchanged non-interactive manual-recovery stdin path is not described as bounded; only newly introduced bounded readers carry that guarantee.

Round-4 ruling record (pinned; one line per finding):

1. Atomic genesis — `apps/api/src/keys.ts` publishes `account_keys`, genesis roster, genesis key state, and the first device in one D1 batch/transaction; clients still compare rather than assume across a lost response, while a legacy orphaned `account_keys` row is verified, diagnosed, and repaired explicitly instead of being called set up.
2. Durable classifier — staging durably records the exact attempt's non-secret hashes and public material before publication, so a restarted process can classify a matching lost response versus a competing genesis.
3. Explicit-file commitment — `--kit-path` uses the hardened write, exact read-back, published-file fsync, and containing-directory fsync contract before locator publication or staged-RK cleanup.
4. Durable directory chain — a fresh `RBOX_HOME` is created and published through every new ancestor with the existing `ensureDirectoryChain` / `fsyncCreatedDirectoryAncestors` primitives before staging can count as a foothold.

Owner: Claude (founder-directed, 2026-07-20)
Origin: onboarding-ux backlog item #6 (macOS keychain), referenced from
`docs/validation-2026-07-18-new-user-flow.md:171-176`.

## Problem

When the user opts into a recovery kit, the 24-word recovery phrase is written
in PLAINTEXT to `~/Downloads/rbox-recovery-kit-<hex16>-<ymd>.txt` (mode 600):

- Target selection: `kitTargetDir` prefers `~/Downloads` when it exists
  (`src/cli/recovery-kit.ts:50-52`, `src/cli/recovery-kit.ts:90-98`).
- Write + verify + status record: `writeRecoveryKit`
  (`src/cli/recovery-kit.ts:112-133`), recorded in
  `~/.rbox/e2ee/<accountId>/kit.json`
  (`src/cli/recovery-kit.ts:160-164`, `src/cli/recovery-kit.ts:179-182`).
- Call sites: genesis/backup/recover flows in `src/cli/auth-cmd.ts`
  (`showRecoveryPhrase` at `src/cli/auth-cmd.ts:49-64`,
  `offerOrWriteKit` at `src/cli/auth-cmd.ts:524-532`,
  `offerRecoveryKitAfterRecover` at `src/cli/auth-cmd.ts:534-549`, and
  `writeKitSuccess` at `src/cli/auth-cmd.ts:569-574`), with the status line at
  `src/cli/auth-cmd.ts:576-588`.

`~/Downloads` is the worst plausible location for long-lived key material: it
is indexed by Spotlight, commonly swept up by backup/sync and cleanup tools,
and is a directory users often expose to other applications. On macOS the OS
ships a purpose-built secret store — Keychain — with encryption at rest, lock
gating, and a GUI in Keychain Access where the user can retrieve the phrase.

Design 12 already called OS-keychain storage "future hardening"
(`docs/design/12-full-e2ee.md:647-649`). This design does that hardening for the
**recovery kit** only. It does NOT move `device.json` / `mk.key` / `rk.key`
(`src/cli/e2ee-keystore.ts:8-21`) into Keychain. Device/MK operational material
is required by daemon start and sync; gating it on Keychain availability would
break headless operation. Optional `rk.key` is loaded only by status/backup.
These files remain mode-600 files per design 12 §13.1.

## Goals

1. On macOS, the default "save a recovery kit" action stores the phrase as a
   Keychain generic-password item, not a plaintext file.
2. rbox never places the phrase in process argv, shell history, a temp file, or
   ordinary command output on its way into Keychain. The mandatory genesis
   no-loss exception stages encoded RK, not phrase text, through the hardened
   same-directory keystore temp+rename contract specified below.
3. `rbox key status` reports every recorded artifact and its live state without
   requesting secret data or turning an unavailable Keychain into "deleted."
4. Explicit file output remains available (`--kit-path`), and non-macOS
   behavior is unchanged.
5. Honest UX: the item is not iCloud Keychain-synchronized and is not an
   off-machine-backup guarantee, although ordinary OS backup/migration may move
   a Keychain as part of the Mac.
6. Existing users get one actionable re-save opportunity per account per local
   rbox installation, whether this device cached RK or the user must enter the
   phrase they already saved.

## Restore FROM Keychain (founder, 2026-07-22)

The read side uses the same item and the same explicit-keychain and subprocess
contracts as the write side. `rbox key recover` today accepts visible
interactive input or non-interactive stdin (`src/cli/auth-cmd.ts:444-465`). On
macOS it may offer the exact-account Keychain item first:

- Only when both stdin and stderr are TTYs, a metadata probe returns `present`,
  and the account id is strict: `Found a recovery phrase for this account in
  the macOS Keychain — use it? [Y/n]`. Decline falls through to today's manual
  entry unchanged. Non-interactive recovery never reads Keychain implicitly.
- The read is a direct, no-shell spawn of
  `/usr/bin/security find-generic-password -w -s <service> -a <account>
  <explicit-keychain>`. The secret is stdout, never argv. It is captured in a
  bounded byte buffer, compared/parsed in memory, never forwarded or logged,
  and overwritten on every exit path where the runtime permits mutable-buffer
  zeroization. Current recovery code does not zeroize its immutable phrase
  strings, so this design does not claim otherwise.
- The CLI confirmation is the user-consent gate rbox controls. The Keychain read
  itself may be promptless because the accepted default ACL trusts
  `/usr/bin/security`; § Security & privacy analysis describes that boundary
  honestly. Missing, denied, malformed, timed-out, or unavailable reads fall
  back to manual entry and never make recovery harder. An unavailable probe is
  not rendered as missing.
- Account matching is exact. Recover already knows the authenticated account;
  the item account attribute must equal it, and the recovered phrase still goes
  through BIP39 parsing and the hardened signed-chain/recovery-envelope path
  required below. The current recovery path verifies the account chain but does
  not yet bind the fetched recovery wrap to it
  (`src/cli/e2ee-client.ts:195-225`); implementation adds that fail-closed check
  before any unwrap or admission. If a Keychain-sourced candidate is BIP39
  checksum-valid but fails this current-account/current-wrap authentication,
  emit the same redacted fallback warning and continue to manual entry before
  building or persisting any admission. A wrong, colliding, historical, or
  server-substituted item/wrap stores and admits nothing. Once admission has
  been persisted, later network or enrollment failures follow ordinary recovery
  semantics and do not loop back to phrase selection.
- Restore uses a persisted identity only from a recognized record containing
  **validated** Keychain metadata. Every other on-disk case — no record, a
  recognized record without a `keychain` artifact (including a normalized
  legacy plaintext record), or an invalid/unknown record — resolves the current
  user's login Keychain exactly once per recovery invocation. Use that one
  canonical identity for probe and read; never fall back to the mutable
  default/search list or invoke the resolver a second time. Invalid/unknown
  records still remain untouched as required below.
- After successful recovery through that resolved identity, take the record
  mutation lock and re-read before deciding the merge. If the recognized record
  still has no Keychain artifact, atomically add this identity with
  `discoveredAt` (never a fabricated `writtenAt`). If it has the same service,
  account, and canonical `keychainPath`, merge only the missing discovery
  metadata without replacing an existing `writtenAt` or `discoveredAt`. If a
  different Keychain identity appeared concurrently, preserve the record
  unchanged and emit a safe conflict warning. Every successful merge preserves
  existing `plaintextArtifacts`, `offer`, and `staging` byte-for-byte at the
  value level; rediscovery does not complete or clear the staging commitment
  protocol. Failure to lock, re-read, validate, or write emits a safe warning
  but never changes the successful enrollment result. An unknown record is
  never overwritten or normalized; leave it untouched and warn that rediscovery
  metadata was not recorded.
- This rescues this Mac after reinstall, deleted local state, or re-setup. The
  item is not iCloud Keychain-synchronized; the 24-word phrase remains the
  deliberate cross-machine recovery story.

## Re-save for already-logged-in users (the Max path)

Existing users predate this design. Their phrase may be in a plaintext kit,
cached as `rk.key`, kept elsewhere, or lost. RK and MK are independently
generated (`src/engine/e2ee/session.ts:84-97`); MK cannot derive RK. `rk.key` is
opt-in only (`src/cli/e2ee-keystore.ts:168-181`): normal genesis omits
`cacheRecovery` (`src/cli/auth-cmd.ts:130-132`,
`src/cli/e2ee-client.ts:104-123`), pairing persists device/MK material but not RK
(`src/cli/e2ee-client.ts:140-193`), and recovery does not cache RK
(`src/cli/e2ee-client.ts:195-225`). The wizard likewise consumes and then drops
its transient phrase/RK today (`src/cli/setup-cmd.ts:338-370`). There is no new
RK-recovery mechanism in this design.

The phrase-source matrix is therefore explicit:

| Surface | Actual phrase source | Behavior before Keychain storage |
|---|---|---|
| `rbox key save`, cached `rk.key` present | Render cached RK with `rkToPhrase` | No typing and no echo; validate against this account's current verified recovery envelope. |
| `rbox key save`, no cached RK | No-echo TTY prompt, or bounded stdin when stdin is not a TTY | Parse/canonicalize the 24 words, then validate against this account's current verified recovery envelope. |
| genesis | Fresh phrase held across bootstrap (`src/cli/auth-cmd.ts:130-132`) | Interactive flows offer an immediate zero-typing save. Non-interactive macOS `--kit` first follows the durable staging invariant below; bootstrap's persisted envelope plus immediate validation proves the account binding before final storage. |
| `rbox key backup` | Cached RK already rendered (`src/cli/auth-cmd.ts:503-515`) | Offer an immediate zero-typing save; revalidate because the cached value could be stale. |
| standalone recover | Phrase that just passed recovery (`src/cli/auth-cmd.ts:444-465`) | Offer an immediate zero-typing save while the phrase is still in scope. |
| wizard recover | Phrase/RK in `recoverInWizard` (`src/cli/setup-cmd.ts:348-370`) | Plumb the canonical phrase to the offer before returning and discarding it. |

### Non-interactive macOS genesis no-loss invariant

Non-interactive macOS genesis with `--kit` MUST NOT publish the account genesis
until RK has a durable local foothold. Before bootstrap publication begins, it
persists RK in the existing opt-in `rk.key` format and mode-600 keystore trust
domain as `mk.key`, but through the new hardened mutation contract below. This
is a temporary use of the existing secret class: it creates no new persistent
plaintext format or Downloads artifact. If durable staging fails, genesis
aborts before any publish.

The genesis caller captures the user's original `cacheRecovery` preference
before this flow overrides the bootstrap option to `cacheRecovery: true` to
force staging. An omitted preference is normalized to `false`; command/wizard
plumbing passes the explicit user value into this orchestration instead of
trying to reconstruct it after bootstrap. The accompanying non-secret staging
state records `startedAt`, that captured original value, and the exact attempt
descriptor defined below. The state transition order is crash-safe:

1. durably publish any newly created `RBOX_HOME` / `e2ee` / account directory
   chain, atomically record staging intent including the attempt descriptor,
   then durably write/verify `rk.key`; all three complete before bootstrap
   publication is permitted;
2. validate the published current recovery envelope and attempt the selected
   Keychain or explicit `--kit-path` save;
3. require exact read-back verification of that Keychain/file artifact; an
   explicit file additionally requires the published file and its containing
   directory to be fsynced — command success alone is not a commitment;
4. under the record lock, atomically persist the verified commitment locator as
   the exact Keychain artifact metadata or plaintext artifact path; failure to
   persist leaves both staging state and `rk.key` intact;
5. only after verification **and** durable locator persistence, honor the
   original preference: retain `rk.key` when `cacheRecovery` was true, or
   durably remove it when false; then atomically clear staging state.

Before the first request, bootstrap derives a strict versioned attempt
descriptor from the exact transport strings it will submit. The descriptor is
non-secret: it stores SHA-256 hashes of the exact `recoveryWrap`, serialized
genesis roster, serialized genesis key state, and serialized `mkWrap`, plus the
public `recoveryWrapId`, `deviceId`, signing public key, and encryption public
key. It stores neither RK, MK, phrase text, nor wrap plaintext. Hashes are over
the submitted UTF-8 bytes, not reserialized objects. The complete descriptor is
persisted **inside `staging` before publication**, under the same strict parser
and hardened locator-write contract as the rest of `kit.json`.

Bootstrap publication keeps the transport's automatic retries. On
`already_bootstrapped`, and on a later invocation whose preflight fetch is
non-null while this staging record exists, fetch `AccountKeysDTO`, verify the
returned signed account chain as usual, find the exact device, hash the returned
opaque strings with the same rules, and compare every descriptor field. If all
fields match, this attempt already committed and the response was lost: treat
publication as successful, continue commitment, and retain staged RK until the
normal verified commitment cleanup. This classification therefore survives
process death. If the verified chain is complete but any field is absent or
differs, treat it as a genuine competing genesis and take the existing
`already-setup` cleanup path for this attempt's local device/MK/RK and staging
state. Fetch or classification failure is neither case: fail closed and retain
staged RK/state for diagnosis and retry.

Genesis publication itself becomes atomic server-side. In
`apps/api/src/keys.ts`, `bootstrapAccountKeys` uses one `dbFor` handle and one
D1 atomic batch/transaction containing the `account_keys` insert, roster v0,
account-key-state epoch 0, and first `device_keys` insert. A constraint or
execution failure rolls back all four; `ok: true` is returned only after the
whole transaction commits. A concurrent pre-existing `account_keys` claim maps
to `already_bootstrapped`, but there is no committed state in which that new
claim exists without its three genesis rows. API tests inject/fail each
statement boundary and assert that a subsequent read sees either all four rows
or none, then retry successfully from the none case.

The non-null preflight at `src/cli/auth-cmd.ts:126` must stop treating mere DTO
presence as proof that an account is set up. It runs the same full signed-chain
verification before returning `already-setup` or performing the descriptor
comparison. A DTO with `account_keys` but empty roster and key-state chains —
including the same shape fetched after `already_bootstrapped` — is the exact
signature of an account already wedged by the old split publication path. The
client preserves staged/local material and emits a distinct actionable error:
the account's encryption setup
is incomplete, normal pairing/recovery cannot repair it, and the user must
contact rbox support for orphan-bootstrap repair before retrying setup. It must
not silently return `already-setup`, discard local material, or loop on
`already_bootstrapped`.

Any non-empty chain that fails cryptographic/account verification remains a
fatal integrity error and is not eligible for orphan repair.

The repair runbook is narrow and server-side: an operator first proves in one
D1 read/transaction that the account has exactly the orphan shape — one
`account_keys` row and zero roster, account-key-state, and device-key rows — and
that no later encrypted-account rows depend on it; only then delete that lone
`account_keys` row transactionally. Any non-empty or ambiguous shape is refused
and escalated rather than guessed at. The user can then rerun genesis, which
uses the new atomic endpoint. Tests seed the exact legacy orphan, require the
actionable client error with no cleanup, exercise guarded repair, and prove the
next bootstrap commits a complete verified genesis.

This API correction is a release prerequisite, not an independently shippable
CLI assumption. Per `docs/DEPLOYMENTS.md`, deploy and verify the API change in
dev, promote it to production on the API's promotion cadence, and only then
release a CLI that relies on atomic genesis. The compare-don't-assume client
logic remains required after promotion because it covers the distinct window
where the atomic transaction commits but its successful response is lost.

A crash or save failure after publication therefore leaves the staged `rk.key`
available to `rbox key save`/backup resolution. Startup and human
`rbox key status` reconcile a leftover marker conservatively: they never delete
staged RK without a durably recorded locator and fresh verification of that
exact Keychain/file commitment. If commitment exists, cleanup can finish
idempotently; otherwise the marker remains and human status prints
`recovery phrase staged, not yet saved`. JSON exposes the same non-secret staged
state. A marker without a readable verified `rk.key` is reported as unavailable
and never as backed up. The temporary stage is not treated as an off-keystore
backup and does not make uninstall safe.

### Hardened RK/staging/locator/file contract

This design adds a normative durability contract for `rk.key`, the non-secret
staging marker, the `kit.json` commitment locator, and every explicit
`--kit-path` plaintext commitment. Before writing any of the first three below
a fresh `RBOX_HOME`, create the complete plain-directory chain without following
symlinks using `ensureDirectoryChain`, then call
`fsyncCreatedDirectoryAncestors` to publish each newly created child through
the first pre-existing ancestor. Fsyncing only the leaf account directory is
insufficient and does not establish the pre-publication foothold.

Each governed write creates a mode-correct `O_CREAT | O_EXCL` temporary file in
the destination directory,
writes the complete bytes, fsyncs the file, closes it, atomically renames it
over the destination, reopens the published path without following symlinks,
requires exact byte-for-byte read-back, fsyncs the published file, and fsyncs
the parent directory before reporting success. A cleanup unlink reports durable
success only after the unlink succeeds and the parent directory is fsynced.
Failure at any step leaves the state machine conservative: it does not advance
commitment or clear staging, and reconciliation may retry idempotently.

For `--kit-path`, that entire sequence — including post-rename read-back,
published-file fsync, and containing-directory fsync — must finish before its
plaintext locator is published in `kit.json`. The locator must then itself meet
the same durability contract before staged `rk.key` can be removed or staging
cleared. The existing `writeRecoveryKit` content read-back and
`writeFileAtomic` temp-file fsync/rename are only pieces of this contract; they
do not currently make the containing directory entry durable.

This is new implementation work. Today's `writeSecret`/`saveRecoveryKey` uses
an in-place `writeFile` with no atomic publication, read-back, file fsync, or
parent-directory fsync (`src/cli/e2ee-keystore.ts:40-43`,
`src/cli/e2ee-keystore.ts:170-172`), while `forgetRecoveryKey` removes the entry
without fsyncing its parent (`src/cli/e2ee-keystore.ts:179-181`). Those helpers
are the gap this contract must close; they are not evidence that the invariant
already holds. The directory-chain primitives already exist at
`src/engine/fsutil.ts:81-124`; implementation reuses them rather than adding a
second recursive-mkdir durability scheme.

`validatePhraseForAccount` is read-only: fetch account keys, verify the signed
roster/key-state chain, require its account id to equal the authenticated
account, parse the fetched recovery wrap, compute its hash, and require that
hash to equal the verified latest key state's exact `recoveryWrapId`. It also
passes `assertMkWrapAuthorized` before attempting `recoverMasterKey`; the
existing signed-wrap authorization primitive is
`src/engine/e2ee/session.ts:245-275`. Only then does it parse the candidate with
`phraseToRk` and authenticate-decrypt that current recovery wrap. The underlying
unwrap is `src/engine/e2ee/session.ts:516-520`; correct/wrong-envelope coverage
already exists at `src/engine/e2ee/session.test.ts:76-95`. The same new helper,
`assertCurrentRecoveryWrap`, gates ordinary restore/recovery too, fixing the
current gap rather than making validation safer than the admission path.
Validation does **not** build or publish an admission roster, cache RK, or write
kit metadata. The Keychain add begins only after every binding and validation
succeeds; every error stores nothing. The narrowly scoped pre-publication
genesis staging above is an ordering invariant, not a side effect of this
validation helper.

New explicit command: `rbox key save`. It requires an authenticated account.
With cached RK it does not read stdin. Without cached RK it uses the separate
no-echo input path in §4 — never `showRecoveryPhrase`, which deliberately prints
the phrase (`src/cli/auth-cmd.ts:49-64`). `--kit-path` still selects an explicit
plaintext target, but the typed phrase is account-envelope-validated before
that file is written too: this command never stores an unvalidated candidate.

The one-time offer chooses copy from the source available at claim time:

> Cached RK: `Save your cached recovery phrase to the macOS Keychain without typing it: rbox key save`

> No cached RK: `Save your recovery phrase to the macOS Keychain: rbox key save (you'll enter the phrase you saved; rbox validates it before storing)`

At phrase-in-hand touchpoints the offer is instead a direct zero-typing prompt:

> `Save this recovery phrase to the macOS Keychain now (view later in Keychain Access — search "rbox")?` [Y/n]

The first actionable login/status/genesis/backup/recover/wizard-recover
touchpoint wins the atomic per-installation claim in §3. A failure before the
backend/account-envelope preflight does not claim the offer. This is a nudge,
not a new RK source and not a fleet-wide promise.

After a verified Keychain save, any recorded plaintext artifact remains
recorded until exact-match deletion is confirmed. Decline, non-interactive
save, missing volume, content mismatch, or unlink failure never loses the path.

## Non-goals

- Deriving RK from MK, retrieving RK from the service, or adding any other new
  recovery mechanism.
- Moving MK / device keys / cached RK into Keychain (future design).
- iCloud Keychain synchronization of the item. `security(1)` uses the legacy
  Keychain APIs and cannot set `kSecAttrSynchronizable`; ordinary Mac
  backup/migration behavior is outside this guarantee.
- Linux secret-service / Windows credential-manager equivalents (the seam can
  host them later; out of scope).
- Any server/API or fleet-wide offer-state change. This is client-side and the
  strongest honest offer guarantee is per account per local installation.

## Design

### 1. Mechanism: `/usr/bin/security` via stdin, never argv

rbox ships as one Bun-compiled binary (`scripts/release.ts:148-176`). macOS
ships `/usr/bin/security` on a SIP-protected absolute path. Every invocation is
a direct spawn of that path with `shell: false`; PATH lookup and a shell are
never involved.

First resolve the current user's login Keychain with a bounded direct spawn of
`/usr/bin/security login-keychain -d user`. Require exactly one parseable
absolute path, canonicalize it with `realpath`, reject NUL/CR/LF, and persist it
as `keychainPath`. Add, verify, probe, and restore pass this path explicitly.
They never omit the Keychain argument and therefore never use the mutable
default Keychain or search list. Persisted paths undergo the same strict
validation before reuse. The integration test supplies its throwaway Keychain
path directly and does not change the user's default/search list.

`security add-generic-password -w <phrase>` would leak the phrase to `ps`.
Instead, run `/usr/bin/security -i` and write exactly one physical command line
followed by a mandatory LF to its stdin. This display is one physical line;
`<LF>` denotes the final byte, not literal text:

```text
add-generic-password -U -s "rbox recovery phrase" -a "acct_0123456789abcdef" -l "rbox recovery phrase (0123456789abcdef)" -j "24-word rbox recovery phrase. Restore: install rbox, rbox login, rbox key recover." -w "<canonical-24-word-phrase>" "<encoded-explicit-keychain-path>"<LF>
```

`security -i` is not a shell and has no backslash-at-EOL continuation. The
production encoder emits no embedded CR/LF, appends exactly one LF (an
unterminated final command is discarded at EOF), and requires
`Buffer.byteLength(commandWithLf, "utf8") < 4096`. Overlength is a hard failure,
not truncation. Phrase input is first canonicalized through `phraseToRk` /
`rkToPhrase` (`src/engine/e2ee/recovery.ts:27-63`) and then must match
`/^[a-z]+( [a-z]+){23}$/`. The account is revalidated with the stricter
`accountHex16` grammar (`src/cli/recovery-kit.ts:190-194`) before any command or
record interpolation. The fixed service/label/comment are constants. A
dedicated `security -i` token encoder quotes the explicit path; it rejects
NUL/CR/LF and escapes only syntax proven by the real-Mac byte-stream test.
Persisted values never bypass these gates.

Item shape:

| Attribute | Value | Why |
|---|---|---|
| service `-s` | `rbox recovery phrase` | Fixed identifier; searchable in Keychain Access. |
| account `-a` | full strict `acct_…` id | One exact item per rbox account. |
| label `-l` | `rbox recovery phrase (<hex16>)` | Human-readable list name. |
| comment `-j` | one-line restore instructions | Replaces the file's recovery instructions. |
| secret `-w` | canonical bare 24-word phrase | Keychain Access reveals exactly what recovery accepts. |
| explicit trailing Keychain | canonical resolved `keychainPath` | Add/verify/probe/read address the same physical Keychain. |
| `-U` | update-if-exists | Re-save is idempotent; its ACL caveat is explicit below. |

No `-T` flag is supplied. The resulting default creating-application ACL is
accepted under the honest threat model in § Security & privacy analysis; it is
not claimed to bind reads to rbox.

### 2. Verification and three-state probing

After add, use the explicit persisted identity for a direct spawn of:

```text
/usr/bin/security find-generic-password -s "rbox recovery phrase" -a "<accountId>" -w "<keychainPath>"
```

Require the bounded stdout bytes, after removal of exactly one terminal LF or
CRLF, to equal the canonical phrase byte-for-byte. Extra output, mismatch,
nonzero exit, timeout, signal, or overflow means the save failed and no
Keychain metadata is recorded. This replaces today's file read-back check
(`src/cli/recovery-kit.ts:121-123`). Do not forward the secret-bearing stdout or
stderr; wipe mutable capture and phrase/RK/MK-validation buffers on completion.

The status probe runs the same exact find against the explicit Keychain but
without `-w` or `-g`, so it asks for attributes, not secret data:

```ts
type KeychainProbe = "present" | "missing" | "unavailable";
```

Classification is closed:

- normal exit 0 ⇒ `present`;
- normal exit 44, the low eight POSIX status bits of
  `errSecItemNotFound = -25300`, on this exact find operation ⇒ `missing`;
- every other nonzero exit, invalid identity, spawn error, timeout, signal,
  forced kill, output overflow, malformed output, Keychain/session/corruption
  error ⇒ `unavailable`.

Negative OSStatus values are truncated at the POSIX process boundary. We never
classify localized stderr, never interpret every nonzero as missing, and never
render `unavailable` as "item deleted." A darwin integration test locks the
selected throwaway Keychain and proves metadata-only probing remains promptless
in the normal locked case; if a macOS version instead fails, the only accepted
result is `unavailable`.

### 3. Versioned status record, offer claim, and consumers

The monomorphic current `RecoveryKitRecord`
(`src/cli/recovery-kit.ts:29-34`) becomes a versioned envelope with orthogonal
axes:

```jsonc
{
  "version": 2,
  "accountId": "acct_0123456789abcdef",
  "keychain": {
    "service": "rbox recovery phrase",
    "account": "acct_0123456789abcdef",
    "keychainPath": "/Users/b/Library/Keychains/login.keychain-db",
    "writtenAt": "2026-07-21T16:30:00.000Z"
  },
  "plaintextArtifacts": [
    {
      "path": "/Users/b/Downloads/rbox-recovery-kit-….txt",
      "writtenAt": "2026-07-20T12:00:00.000Z",
      "cleanup": "pending"
    }
  ],
  "offer": {
    "claimedAt": "2026-07-21T16:29:00.000Z",
    "surface": "status",
    "phraseSource": "cached-rk",
    "outcome": "shown"
  },
  "staging": {
    "startedAt": "2026-07-21T16:28:00.000Z",
    "originalCacheRecovery": false,
    "attempt": {
      "version": 1,
      "recoveryWrapSha256": "<lowercase-hex-sha256>",
      "recoveryWrapId": "<published-wrap-id>",
      "genesisRosterSha256": "<lowercase-hex-sha256>",
      "genesisKeyStateSha256": "<lowercase-hex-sha256>",
      "deviceId": "dev_…",
      "sigPubKey": "<public-key>",
      "encPubKey": "<public-key>",
      "mkWrapSha256": "<lowercase-hex-sha256>"
    }
  }
}
```

- `keychain` is optional metadata for the one exact item; live
  `present | missing | unavailable` is probed, not persisted as truth. A save
  performed by rbox records `writtenAt`. A rediscovery after `kit.json` loss
  records `discoveredAt` instead; `writtenAt` and `discoveredAt` are strict
  optional ISO dates with at least one required. The metadata-only probe/read
  does not invent or scrape a Keychain creation date.
- `plaintextArtifacts` is zero-or-more because explicit saves and legacy paths
  can coexist. `cleanup` is `pending | declined | failed`; an entry disappears
  only after confirmed unlink. Explicit later file output never erases
  Keychain metadata, and a Keychain save never erases a file path.
- `offer` is optional and independent. `claimed`, `shown`, `accepted`, and
  explicit `declined` are distinct outcomes; printing an informational line is
  not a decline. `surface` is one of
  `login | status | genesis | backup | recover | wizard-recover`, and
  `phraseSource` is `cached-rk | typed | in-hand`.
- `staging` is optional, non-secret, and independent. It exists only for the
  non-interactive macOS genesis no-loss state machine. Its strict timestamp and
  original boolean preference distinguish a temporarily retained `rk.key` from
  an ordinary opted-in cache and drive idempotent cleanup after verification.
  Its required, strictly parsed `attempt` object contains the exact fixed set of
  non-secret hashes/public fields above. No partial descriptor is accepted, and
  record mutation/restore merge preserves it as part of the independent staging
  axis until commitment cleanup durably clears staging.

Parsing is strict and account-bound. A legacy object with absent `kind` and
exactly valid `path` + `writtenAt` is normalized to a v2 envelope with one
plaintext artifact. Known version, exact field types, strict current account,
fixed service/account, canonical Keychain identity, valid dates, enums, and no
mixed legacy/v2 shape are required. Unknown versions/kinds, extra mixed variant
fields, invalid dates, or wrong-account records return `unknown`; they never
fall through to legacy file or deletion logic. Mutation refuses to overwrite an
unknown record.

Offer mutation uses a per-account O_CREAT|O_EXCL lock beside `kit.json`, with
PID-liveness stale-lock recovery matching the existing genesis-lock pattern
(`src/cli/e2ee-keystore.ts:110-138`). Under the lock: re-read and strictly parse,
preflight an actionable phrase path and available Keychain backend/envelope,
probe that no item is present, atomically persist `outcome: "claimed"`, then
release and print/prompt. Only the claimant emits. After UI completion it takes
the lock again and advances to shown/accepted/declined without overwriting
artifact changes. Claim-before-output gives an honest **at-most-once per account
per local installation** guarantee; a crash after claim can lose the nudge but
cannot duplicate it. `kit.json` is local
(`src/cli/recovery-kit.ts:179-182`), so no fleet-wide promise is made.

`rbox key status` human output lists each artifact and live state. Keychain
examples:

- `recovery kit: macOS Keychain "rbox recovery phrase" (written 2026-07-21)`
- `… (item missing — re-run rbox key save)`
- `… (Keychain unavailable — backup state unknown; retry in a GUI session)`
- `recovery phrase staged, not yet saved`

File states become `present | missing | unrecognized | unavailable`. Present
requires a bounded regular-file parse with current account and canonical valid
24-word phrase, not only today's first-line banner check
(`src/cli/recovery-kit.ts:145-154`). Permission/I/O/size failures are
`unavailable`; malformed or mismatched content is `unrecognized`.

When `staging` is present, the staged warning is emitted in addition to artifact
states until reconciliation clears it; staged RK alone never renders as a saved
recovery kit. `rbox key status --json` returns before any offer claim or nudge,
preserving the current JSON/human boundary (`src/cli/auth-cmd.ts:468-488`). It
may perform read-only probes. `recoveryKit` gains `version`, `keychain`
(including live state), `plaintextArtifacts` (each with live state), `offer`,
and `staging`; for a file it also preserves the existing `path`/`writtenAt`
compatibility fields.
Status JSON never invokes staging reconciliation: it writes nothing, prints no
nudge, and is covered by `src/cli/json-output.test.ts:419-434`.

Uninstall is a mandatory consumer. Today `keystoreBackupAtRisk` treats any
parseable kit record as safe (`src/cli/uninstall-cmd.ts:24-31`) before uninstall
recursively removes `.rbox`, including cached RK
(`src/cli/uninstall-cmd.ts:105-124`). The shared aggregate is:

| Observed evidence | Uninstall interpretation |
|---|---|
| At least one recognized artifact probes `present` **and its canonical backing path is outside the canonical removal root** | backed up; no unrecoverability warning |
| No present artifact; candidates are missing/unrecognized, offer was declined, or no artifact exists | at risk; print the existing strong warning |
| No present artifact and any candidate/record/probe is unavailable or unknown | risk unknown; print an explicit yellow warning, never treat as safe |

This precedence distinguishes present, missing, unrecognized, declined, and
unavailable. Unknown future records and probe failure cannot suppress the
warning. The aggregate receives uninstall's canonical `rboxHome` removal root.
A plaintext artifact path inside that tree is at risk because uninstall will
delete it; the same applies to a custom Keychain whose canonical
`keychainPath` is inside the tree. Containment uses resolved absolute paths and
a separator boundary, not string prefixing. Status, JSON, cleanup, and uninstall
all consume the same strict parser and probe results.

### 4. Flag, command, TTY, and process semantics

Decision table for the storage target after phrase validation:

| Condition | Target |
|---|---|
| `--kit-path <p>` on any OS | Explicit plaintext file; path wins. |
| macOS + `/usr/bin/security` + resolved login Keychain | Explicit Keychain item. |
| Other OS | Existing `~/Downloads` / `$HOME` plaintext behavior. |
| macOS Keychain unavailable | Failure path in §5; never silent plaintext downgrade. |

This applies to every `recoveryKitAction`
(`src/cli/recovery-kit.ts:43-48`) and to new `rbox key save`. A
non-interactive `--kit` on macOS intentionally changes from file output to the
Keychain default; scripts requiring a file use `--kit-path`.

TTY/input rules are exact:

- New Keychain confirmations and offers, including the Keychain-target
  `rbox key save` phrase prompt, require
  `process.stdin.isTTY === true` **and** `process.stderr.isTTY === true`, because
  their UI renders on stderr. stdout need not be a TTY. This two-TTY rule does
  not alter the existing manual-recovery gate, which remains stdin-only
  (`src/cli/prompt.ts:37-40`).
- Restore behavior for all four combinations is normative:

  | stdin TTY | stderr TTY | New Keychain offer | Existing manual recovery |
  |---|---|---|---|
  | yes | yes | Probe and offer when an exact item is present; decline or pre-admission candidate failure falls through. | Use today's interactive manual prompt on decline/fallback. |
  | yes | no | Do not probe/read/offer Keychain. | Use today's interactive manual prompt unchanged, even with stderr redirected. |
  | no | yes | Do not probe/read/offer Keychain. | Use today's non-interactive stdin phrase path unchanged. |
  | no | no | Do not probe/read/offer Keychain. | Use today's non-interactive stdin phrase path unchanged. |

  Keychain gating therefore never converts a formerly valid manual-recovery
  invocation into an error or hang.
- `rbox key save` with cached RK consumes no stdin and never echoes the phrase.
- Without cached RK, an interactive Keychain-target save uses `promptPassword`
  (no echo; `src/cli/prompt.ts:72-75`) on the TTY pair. If stdin is not a TTY,
  it reads at most 1 KiB to EOF, rejects overflow/empty/trailing extra data,
  canonicalizes, validates, and saves without echo. If stdin is a TTY but
  stderr is not, that new Keychain prompt fails with guidance instead of
  reading visibly or hanging. These rules do not replace the manual-recovery
  behavior in the table above.
- `--json` is invalid for `key save`; `key status --json` remains read-only and
  nudge-free. No offer runs in non-TTY mode.
- Wizard recovery must call the shared zero-typing offer while the phrase is in
  scope, rather than assuming the auth-cmd dispatcher reaches it
  (`src/cli/setup-cmd.ts:338-370`, `src/cli/setup-cmd.ts:500-509`,
  `src/cli/setup-cmd.ts:570-579`).

Every `/usr/bin/security` operation uses one shared spawn runner:

1. direct absolute executable, fixed argv array, `shell: false`, no environment
   command interpolation;
2. stdin is a pipe only for `security -i`; write the exact bytes, handle write
   error, and close stdin immediately; other operations use closed stdin;
3. drain stdout and stderr concurrently into mutable buffers bounded at 64 KiB
   each (secret reads use a tighter 1 KiB stdout bound); overflow terminates and
   is an error, and secret-bearing streams are never forwarded;
4. await child exit and both drains; 60-second timeout for an explicitly
   interactive save/read, 15 seconds for non-interactive save and identity
   resolution, and 5 seconds for metadata probe;
5. on timeout/overflow send SIGTERM, wait at most one second, then SIGKILL, and
   still await exit; timeout, signal, forced kill, and spawn failure are distinct
   internal results and map to write/read failure or probe `unavailable`;
6. redact command/script/stdout/stderr from errors and telemetry, retaining only
   operation name and safe classification; wipe mutable secret buffers in
   `finally`.

A non-TTY rbox process can still cause SecurityAgent UI in a logged-in GUI
session. The design does not infer prompt behavior from TTY state; the matrix in
Testing covers GUI, locked GUI, SSH, and headless sessions.

Interactive save copy:

> `Save this recovery phrase to the macOS Keychain (view later in Keychain Access — search "rbox")?` [Y/n]

Success output:

> `✓ recovery phrase saved to the macOS Keychain (search "rbox" in Keychain Access)`
> `  note: this item is not iCloud Keychain-synchronized — keep an off-machine copy too.`

A verified Keychain save satisfies the existing forced save acknowledgement
(`src/cli/auth-cmd.ts:55-60`).

### 5. Failure handling — never silently downgrade to plaintext

Keychain write failures include locked/disallowed interaction, user cancel,
timeout, unavailable login Keychain, MDM restriction, verification mismatch,
and output/process failures.

- **Interactive:** report a safe, redacted reason, then make the existing
  plaintext choice explicit:
  `Keychain save failed (<safe class>) — save a PLAINTEXT file to ~/Downloads instead?`
  Default remains Yes for parity with today's recovery-kit offer. Nothing is
  written until the user separately consents.
- **Non-interactive genesis with `--kit`:** after the mandatory pre-publish
  `rk.key` stage, a Keychain failure returns nonzero but retains staged RK and
  staging metadata for a later `rbox key save`/backup retry. It never silently
  creates a Downloads file and never removes staging before a verified
  Keychain or explicit-file commitment. After commitment, it restores the
  caller's original `cacheRecovery` preference as specified above.
- **Other non-interactive `--kit` / `rbox key save`:** fail nonzero and suggest
  an explicit `--kit-path <path>` or a GUI-session retry. Never silently write a
  file because Keychain happened to be unavailable.
- **Restore read/candidate:** missing, declined, unavailable, read failure,
  malformed phrase, or a checksum-valid candidate that fails current-account
  envelope authentication falls through to manual phrase entry before any
  admission persistence. After the user explicitly chose a present item, a
  short safe warning explains the fallback; secret/process output stays hidden.
  Failures after admission persistence retain today's ordinary recovery
  semantics rather than asking for the phrase again.
- **Record failure after verified add:** report that the secret is present but
  status metadata could not be saved. Do not claim offer completion or delete
  plaintext. During staged genesis, also retain staged RK and its marker because
  the commitment locator is not yet durable. A later exact probe/re-save can
  repair metadata.

### 6. Migrating off an existing plaintext kit

After a verified Keychain save, inspect every recorded plaintext artifact with
a bounded (maximum 16 KiB), no-follow regular-file read. Each validation pass
uses this exact order: path `lstat`; open with `O_RDONLY | O_NOFOLLOW`; `fstat`
the open handle; require regular file, size bound, and the first path stat's
`dev + ino` to equal the handle; read only from that handle; path `lstat` again;
require its `dev + ino` still equals the open handle; then close. Parse the
rendered format (`src/cli/recovery-kit.ts:58-87`) and require all of:

1. `lstat` says regular file, not symlink;
2. parsed `Account:` equals the current strict account exactly;
3. parsed recovery phrase canonicalizes to the exact phrase just verified in
   Keychain, byte-for-byte;
4. size/shape/date/path checks are within the strict parser's bounds.

Only then offer:

> `Delete the matching old plaintext kit at ~/Downloads/rbox-recovery-kit-….txt?` [Y/n]

After consent, repeat that entire open/fstat/handle-read/path-identity/content
sequence, then perform one final path `lstat` / `dev + ino` comparison and call
`unlink(path)` immediately. Any replacement or symlink swap detected before the
final compare, mismatch, missing file, or unavailable read cancels deletion.
POSIX/macOS has no portable conditional-unlink-by-inode primitive, so there is
an unavoidable final compare→unlink name race against a malicious same-user
process; the design states that residual honestly rather than claiming every
possible swap is caught. Never authorize cleanup from
`recoveryKitFileState === "present"`; today's implementation checks only the
banner (`src/cli/recovery-kit.ts:145-154`).

Non-interactive runs never delete and retain `cleanup: "pending"`. Explicit
decline records `declined`; unlink failure records `failed` plus a safe warning.
The path is removed from `plaintextArtifacts` only after successful unlink.

Logout and `forgetLocalDeviceMaterial` intentionally do not delete the
Keychain item: the latter removes only device/MK/RK files
(`src/cli/e2ee-keystore.ts:141-148`). The item is a recovery artifact, not
session state.

### 7. Code shape & seams

New module `src/cli/recovery-kit-keychain.ts`:

```ts
export type KeychainProbe = "present" | "missing" | "unavailable";

export interface SecurityResult {
  outcome: "exit" | "timeout" | "signal" | "overflow" | "spawn-error";
  code?: number;
  signal?: NodeJS.Signals;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface KeychainSeams {
  platform: NodeJS.Platform;
  securityBinExists(): Promise<boolean>;
  realpath(path: string): Promise<string>;
  runSecurity(args: readonly string[], stdin: Uint8Array | undefined,
    limits: { timeoutMs: number; stdoutBytes: number; stderrBytes: number }):
    Promise<SecurityResult>;
}

export function resolveLoginKeychain(seams?: KeychainSeams): Promise<string>;
export function writeKeychainKit(phrase: string, accountId: string,
  keychainPath: string, seams?: KeychainSeams): Promise<KeychainArtifact>;
export function probeKeychainKit(record: KeychainArtifact,
  seams?: KeychainSeams): Promise<KeychainProbe>;
export function readKeychainKit(record: KeychainArtifact,
  seams?: KeychainSeams): Promise<Uint8Array>;
```

`src/cli/recovery-kit.ts` owns the v2 envelope, strict legacy migration,
per-account mutation lock/atomic writes, plaintext parsing, aggregate safety,
and target dispatcher. `src/cli/auth-cmd.ts` owns command UX and phrase-source
selection. `src/cli/setup-cmd.ts` explicitly passes wizard's in-hand phrase.
`src/cli/uninstall-cmd.ts` consumes aggregate safety, not mere record presence.
`src/cli/e2ee-client.ts` owns attempt construction and verified DTO/descriptor
comparison. `apps/api/src/keys.ts` owns the single atomic D1 genesis publication;
the CLI cannot emulate or compensate for a split server commit.

Add `key save` to dispatch (`src/cli/main-dispatch.ts:482-495`), command/group
help (`src/cli/help-registry.ts:412-458`), completions through the help registry,
and usage docs. Because this adds a module and changes ownership under the sync
engine's mapped CLI trees only if CODEMAP includes this subtree, implementation
must verify `docs/CODEMAP.md` and update the relevant line if required.

Pure helpers — byte-stream construction, token/path validation, record parsing,
probe classification, state aggregation, phrase-source choice, and decision
tables — remain side-effect free and receive exhaustive unit coverage.

## Security & privacy analysis

- **argv / shell / disk leak:** the add secret exists only in the bounded stdin
  byte stream to `security -i`; it never enters argv, a shell, a temp file, or
  forwarded process output. Typed `key save` uses no-echo input. The existing
  genesis/backup phrase display remains intentional
  (`src/cli/auth-cmd.ts:49-64`).
- **Honest same-user boundary:** with no `-T`, the creator trusted by the default
  ACL is `/usr/bin/security`, not rbox. Any process already executing as the user
  can invoke that trusted executable; `-U` may also preserve a pre-existing
  item's ACL. Therefore this design claims **no stronger confidentiality from
  arbitrary same-user processes while the Keychain is unlocked** than the
  mode-600 plaintext file it replaces, which those processes can read directly.
- **Why it is still strictly at least as good:** it removes the long-lived
  plaintext Downloads artifact by default and adds Keychain encryption at rest
  and lock-state protection. At the accepted same-user boundary it is no worse;
  while logged out/locked or against offline disk access it is better. The
  design does not claim every selected Keychain's keys derive from the login
  password; the explicit Keychain's own storage and lock policy control that.
- **Read consent:** rbox asks before restore, but does not promise a second OS
  authorization prompt. Keychain Access may require its own authentication to
  reveal the password; that UI behavior is not used as a programmatic security
  invariant.
- **Account/collision safety:** strict account/service/identity fields plus
  post-add exact secret verification prevent recording the wrong search-list
  item. A colliding item may retain its ACL under `-U`, but that does not weaken
  the stated same-user boundary. The fetched recovery wrap's hash must equal the
  verified current key state's `recoveryWrapId` and be in the signed authorized
  set before a typed candidate is tried, so a server cannot manufacture a wrap
  that validates an attacker-chosen phrase.
- **Machine scope:** the legacy `security(1)` item is not iCloud
  Keychain-synchronized. Ordinary full-Mac backup/migration may carry it, but
  rbox neither requests nor verifies that. Copy explicitly says to retain an
  off-machine phrase.
- **Probe honesty:** metadata-only find is expected to be promptless, but its
  state is ternary. Every uncertain result remains unavailable/risk unknown.

## Alternatives considered

- **Direct Security.framework access or a dedicated native helper** — could
  make rbox/helper the creating application and construct a tighter ACL. A
  helper violates the single-binary distribution constraint; both approaches
  add CoreFoundation ownership/bridging, code-signing identity, entitlement,
  packaging, and upgrade complexity to the Bun release flow. Rejected for this
  design; the backend seam leaves a future replacement possible.
- **`-T ""` (trust no application)** — avoids default trust, but immediate
  secret verification and every restore read become authorization-prompt-heavy;
  automation, SSH, and headless behavior get worse, and reliable post-write
  verification becomes awkward. Rejected under the pinned usability ruling.
- **keytar / native npm modules** — native-module builds conflict with the
  single-binary release flow. Rejected.
- **`add-generic-password -w <phrase>` as argv** — `ps`-visible secret.
  Rejected outright.
- **Store the rendered kit text as the secret** — Keychain Access would show a
  wall of text where the user expects the phrase. Instructions live in comment
  metadata instead.
- **Keep writing under `~/Library/Application Support/rbox`** — still
  plaintext at rest and less discoverable than Downloads. Rejected.

## Testing

1. **Unit, all platforms:** exact `security -i` bytes are one physical line,
   end in one LF, and remain under 4096 UTF-8 bytes; fuzz phrase/account/path
   CR/LF/NUL/quotes/backslashes/overlength; phrase canonicalization; fixed
   identity propagation; full OSStatus/timeout/signal/overflow probe table;
   bounded-output redaction; source matrix; target decision table; strict v2 +
   legacy parsing and unknown/mixed rejection; atomic-claim concurrency; JSON
   mutation-free behavior; complete attempt-descriptor parsing, exact-byte hash
   comparison, and staging crash-point transitions; hardened RK/staging/locator/
   explicit-file publication, exact read-back, file and parent-directory fsync,
   and post-unlink parent-directory fsync failures; fresh empty `RBOX_HOME`
   creation through every ancestor with injected failure at each ancestor fsync;
   cleanup precheck + second pre-unlink check; and uninstall state precedence,
   including staged-only state plus plaintext and custom-Keychain backing paths
   inside the removal root.
2. **API atomic-publication tests:** exercise `bootstrapAccountKeys` against D1
   with a failure injected after each logical insert/statement boundary. Every
   failed request leaves zero `account_keys`, roster-v0, key-state-0, and first-
   device rows; every success leaves exactly the mutually consistent four-row
   genesis. Cover a lost success response followed by 409, concurrent bootstrap
   claims, constraint failure rollback, retry after rollback, and the guarded
   legacy-orphan repair transaction. These are API crash/partial-commit tests,
   not mocks of client behavior.
3. **Command tests:** add dispatch/help/completion coverage for `key save`,
   cached no-stdin save, no-cache hidden TTY input, bounded non-TTY stdin,
   invalid/wrong-account phrase stores nothing, validation performs no
   admission/cache mutation, substituted and historical-but-authorized recovery
   wraps fail before unwrap, non-interactive macOS genesis captures the original
   cache preference before forcing `cacheRecovery: true`, durably creates the
   directory chain, and durably persists both RK and the complete attempt before
   publish; stage/ancestor-fsync failure prevents publish; exact Keychain or
   explicit-file verification, file fsync, containing-directory fsync, and
   atomic commitment-locator persistence all precede stage cleanup; crashes at
   each ordering boundary retain or reconcile RK safely; a lost successful
   response followed by retry and `already_bootstrapped` fetches published
   material; an exact match proceeds with staged RK retained; a mismatch takes
   competing-genesis cleanup; a forced fetch/classification failure retains the
   descriptor, then process restart classifies both a matching committed attempt
   and a competing committed genesis correctly; a non-null verified preflight
   performs the same classification; a legacy non-null empty-chain DTO emits the
   actionable orphan-bootstrap error and deletes nothing; transport retries
   remain enabled; both original
   `cacheRecovery` preferences are restored, staged status copy is emitted,
   `showRecoveryPhrase` is never called, offer copy adapts, JSON emits no
   nudge/write, and wizard offers before dropping phrase.
   Relevant existing surfaces are `src/cli/auth-cmd.test.ts`,
   `src/cli/help-registry.test.ts:31-42`, and
   `src/cli/setup-cmd.test.ts:1094-1133`.
4. **Restore command matrix:** deterministic command tests use injected probe,
   read, resolver, validation, admission-persistence, and record-write seams:

   | Case | Required assertion |
   |---|---|
   | stdin TTY / stderr TTY | Exact-account item is offered; decline enters the unchanged interactive manual prompt. |
   | stdin TTY / stderr non-TTY | No Keychain probe/read/offer; unchanged interactive manual recovery runs. |
   | stdin non-TTY / stderr TTY | No Keychain probe/read/offer; unchanged stdin recovery runs. |
   | stdin non-TTY / stderr non-TTY | No Keychain probe/read/offer; unchanged stdin recovery runs. |
   | Keychain phrase is BIP39-valid but wrong for current wrap | Redacted warning, zero admission writes, then manual entry; the manual candidate can succeed. |
   | Failure after admission persistence | Ordinary recovery error semantics; no fallback prompt or second phrase attempt. |
   | Recognized record with validated Keychain metadata | Resolver is never called; the same persisted canonical path reaches probe and read. |
   | No record or recognized record without Keychain metadata | Resolver is called exactly once; its one canonical path reaches probe and read. |
   | Exact account selection | Lookup uses the authenticated full account id; a different account's same-service item is never read or offered. |
   | Successful recovery; no Keychain artifact at locked re-read | Atomic `discoveredAt` merge preserves existing plaintext artifacts, offer, and staging values and invents no `writtenAt`. |
   | Successful recovery; same identity at locked re-read | Merge preserves existing timestamps plus plaintext, offer, and staging axes; it adds only missing discovery metadata. |
   | Successful recovery; different identity appeared before locked re-read | Concurrent identity and every other axis remain unchanged; emit a safe conflict warning. |
   | Rediscovery record lock/read/write failure | Safe warning only; enrollment remains successful. |
   | Unknown record | Resolver is called exactly once and read/recovery may proceed, but the record remains byte-for-byte untouched and a safe metadata warning is emitted. |

5. **Darwin integration:** create a throwaway temp Keychain and pass its path
   explicitly to the exact production byte stream. Test add, exact verify,
   `-U`, duplicate service/account isolation, present/missing classification,
   restore read, rediscovery records `discoveredAt` without inventing
   `writtenAt`, locked metadata probe, wrong identity, timeout/kill, and delete.
   Never touch the user's login/default/search-list Keychain.
6. **Real-Mac validation:** fresh genesis from an empty `RBOX_HOME`, cached and
   typed `key save`, standalone
   and wizard recover, Keychain Access findability/search/show-password,
   reinstall/deleted-kit.json restore, locked GUI, unlocked GUI, SSH into a GUI
   session, truly headless/locked SSH, user cancellation, timeout, and plaintext
   fallback. Observe rather than assume SecurityAgent prompt behavior.
7. **Deletion/uninstall validation:** race-replace file during cleanup prompt,
   symlink swap, handle/path inode mismatch, wrong account, same banner/wrong
   phrase, oversized/unreadable file, declined cleanup, missing item, unavailable
   Keychain, unknown future record, artifact inside the uninstall root, and
   surviving-present-artifact precedence.
8. **Repo validation:** unit/typecheck plus `bun run rig` or a dev build shipped
   to the local fleet, per repository flow; documentation/usage snapshots and
   any CODEMAP ownership line stay in sync.

## Slices

1. Atomic API genesis transaction, all-or-nothing/legacy-orphan tests, guarded
   repair runbook, dev verification, and production promotion before dependent
   CLI release.
2. `recovery-kit-keychain.ts`: shared spawn runner, explicit identity resolve,
   one-line add/verify/read/probe, OSStatus classifier, seams, and darwin test.
3. `recovery-kit.ts`: v2 envelope/migration/parser, durable attempt staging,
   atomic claim, orthogonal artifact mutations, hardened directory/file
   publication, bounded plaintext parser, cleanup revalidation, and aggregate
   safety.
4. `rbox key save` + phrase-envelope validation + cached/typed source selection;
   dispatch/help/completions/usage and no-echo/TTY tests.
5. Genesis durable staging, restart-safe descriptor classification, verified
   preflight/legacy-wedge error, and genesis/backup/standalone-recover/
   wizard-recover zero-typing offer plumbing; status human/JSON rendering and
   once-per-installation claim tests.
6. Restore-from-Keychain read/fallback/rediscovery flow, uninstall consumer,
   exact-match plaintext migration, integration matrix, and changelog note for
   non-interactive `--kit`.

## Open questions (for review)

None in v6. The phrase-source, ACL, process, identity, state, offer, cleanup,
probe, uninstall, restore, atomic-publication, restart-classification,
durability, repair, promotion-order, and wording rulings above are pinned and
are not reopened by implementation review.
