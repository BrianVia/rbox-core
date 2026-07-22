# 179 — recovery kit: macOS Keychain instead of a plaintext Downloads file

Status: v18 — r12 retarget witness

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

1. No-loss genesis — non-interactive macOS genesis with `--kit` reuses design 180's `rk.key.staged`; only a verified Keychain/file commitment releases its hold, after which the original `cacheRecovery` preference is restored, with pending state visible in `key status` until resolved.
2. Wrong Keychain phrase — a checksum-valid Keychain candidate that fails account-envelope validation emits only a redacted warning and falls through to manual entry before admission persistence; failures after persistence retain ordinary recovery semantics.
3. TTY gates — two TTYs gate only new Keychain offers/prompts; the existing stdin-only manual-recovery gate is unchanged, with all four stdin/stderr combinations specified below.
4. Restore metadata — only a recognized record containing validated Keychain metadata supplies an identity; otherwise resolve login Keychain exactly once, and after recovery atomically merge `discoveredAt` metadata without disturbing plaintext/offer axes; record failure is nonfatal and unknown records remain untouched.
5. Restore tests — cover the four-way TTY matrix, decline, valid-but-wrong fallback, one-shot resolution and identity propagation, exact account selection, merge preservation, and nonfatal record-write failure.
6. Daemon rationale — only device/MK operational material is required by daemon/sync; optional `rk.key` is loaded by status/backup, not used as daemon rationale.

Round-3 retained ruling record (original finding numbers preserved):

2. Durable keystore mutations — design 180 owns staged-RK durability; this design's cache promotion and commitment-locator writes require same-directory atomic temp+rename publication, exact read-back, and file plus parent-directory fsync; unlink requires parent-directory fsync.
3. Restore merge — under the locked re-read, rediscovery merges only a same-identity Keychain artifact, while a concurrent different identity is preserved and warned about; it never mutates design 180's journal state.
4. Cache preference — capture the user's original `cacheRecovery` value in design 180's journal before publication and restore it only after commitment.
5. Manual stdin wording — the unchanged non-interactive manual-recovery stdin path is not described as bounded; only newly introduced bounded readers carry that guarantee.

Round-4 retained ruling record (original finding numbers preserved):

3. Explicit-file commitment — `--kit-path` uses the hardened write, exact read-back, published-file fsync, and containing-directory fsync contract before locator publication or staged-RK cleanup.
4. Durable directory chain — design 180 creates and publishes a fresh `RBOX_HOME` through every new ancestor with the existing `ensureDirectoryChain` / `fsyncCreatedDirectoryAncestors` primitives before `rk.key.staged` can count as a foothold.

Founder split record: round-3 finding 1, round-4 findings 1–2, and round-5 findings 1–4 are genesis publication/classification/repair concerns that predate this feature and now seed `docs/design/180-atomic-genesis-enrollment.md`; round 5 did not certify that subsystem inside design 179, and these seam amendments make no such claim.

Round-10 seam ruling record (2026-07-22; binding; original finding numbers
preserved):

Where these lines conflict with the round-1 once-only-offer wording or an
earlier fixed-target completion-intent statement, these r10 seam rulings
control.

4. ACCEPT — design 180's reselection controls genesis: the once-only offer
   binds to journal resolution, not prompt emission. `outcome:"claimed"` does
   not suppress re-presentation while the same active enrollment journal lacks
   a satisfied completion intent; this is continuation of one episode, not a
   duplicate offer.
5. ACCEPT — after explicit interactive consent, a pre-receipt Keychain failure
   may RETARGET to plaintext only after a replacement file completion intent
   durably supersedes the Keychain intent under design 180's hardened
   write-new-then-supersede contract and before any fallback file commitment.

Round-11 seam ruling record (2026-07-22; binding):

Where this line corrects the r10 RETARGET supersession boundary, the r11 seam
ruling controls.

1. ACCEPT — RETARGET no longer claims an old-before/new-after binary. The
   failing invocation performs no fallback write. On locked resume, design 180
   reloads the canonical intent and accepts either the exact old Keychain
   intent or the exact new file intent, completes exact read-back,
   published-file fsync, and parent-directory fsync for whichever it found
   before proceeding, and fails closed on any other state. Tests reconcile
   crashes after rename, after read-back, after file fsync, and after directory
   fsync.

Round-12 seam ruling record (2026-07-22; binding):

Where these lines strengthen r11's RETARGET provenance and correct any earlier
mismatch-reselection wording, the r12 seam rulings control.

1. ACCEPT — before canonical replacement, design 180 durably publishes a
   full-hardened-writer RETARGET witness binding the exact old and new intents
   and both digests. Locked resume reads it first, accepts only those exact two
   values, completes durability for the surviving canonical intent, fails
   closed on every other state, and retires the witness only after the survivor
   is fully durable. The four stage-specific crash cases cover witness-present
   and witness-absent boundaries.
2. ACCEPT-MODIFIED — absence is the only reselection case. Every structurally
   invalid or version/account/digest/shape/target-mismatched present completion
   intent fails closed as preserved integrity evidence. A valid RETARGET
   witness authorizes only its exact two-value reconciliation.

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
   `rk.key.staged` contract owned by design 180.
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

Before any manual or Keychain restore work, `rbox key recover` follows
[design 180 v13](180-atomic-genesis-enrollment.md)'s mandatory pending-state
arbitration. Once the account is known it
acquires the genesis lock and, if a journal is active, first resolves that
journal through the shared classifier's resume/cleanup path. It may probe/read
Keychain, accept a phrase, replace credentials, persist device/MK material, or
admit only after the journal has been durably retired. Every nonterminal or
failed classification leaves the existing journal and local material intact;
design 180 owns the whole-command zero-side-effect matrix.

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
  existing `plaintextArtifacts` and `offer` byte-for-byte at the value level;
  rediscovery does not complete or alter design 180's genesis journal. Failure
  to lock, re-read, validate, or write emits a safe warning
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
| genesis | In-memory fresh phrase on the uninterrupted path (`src/cli/auth-cmd.ts:130-132`); canonical phrase reconstructed from design 180's `rk.key.staged` on resume | Interactive flows offer an immediate zero-typing save. Non-interactive macOS `--kit` follows the shared durable staging invariant below; bootstrap's persisted envelope plus immediate validation proves the account binding before final storage. |
| `rbox key backup` | Cached RK already rendered (`src/cli/auth-cmd.ts:503-515`) | Offer an immediate zero-typing save; revalidate because the cached value could be stale. |
| standalone recover | Phrase that just passed recovery (`src/cli/auth-cmd.ts:444-465`) | Offer an immediate zero-typing save while the phrase is still in scope. |
| wizard recover | Phrase/RK in `recoverInWizard` (`src/cli/setup-cmd.ts:348-370`) | Plumb the canonical phrase to the offer before returning and discarding it. |

### Non-interactive macOS genesis no-loss invariant

Design 180 solely owns the prepublication foothold, `rk.key.staged`, completion
intent, hold, cleanup authorization, and crash migration through its journal
phases.
Non-interactive macOS genesis with `--kit` reuses that exact artifact; it does
not force a temporary `rk.key` cache and does not add staging state to
`kit.json`. If design 180 cannot durably publish and authenticate
`rk.key.staged`, genesis aborts before POST.

This design adds only the macOS save delta. Before publication, the caller
records the user's original `cacheRecovery` preference in design 180's journal
(omitted means false). After `committed-this-attempt`, it reconstructs the
canonical phrase from `rk.key.staged`, validates the published recovery
envelope, and durably asks design 180 to record the selected completion intent
in its own `genesis-completion-intent.json` beside the journal, using the same
hardened durability contract, before attempting it: phrase display; Keychain
with the already resolved exact service/account/canonical `keychainPath`
identity; or `--kit-path` with the exact selected path. It then saves to that
selected Keychain or explicit path,
exactly verifies that artifact, and durably commits its locator in `kit.json`.
Only then may it request design 180's `artifact-committed` receipt. During
design 180's `cleanup` phase, the staged file is promoted atomically to
ordinary `rk.key` when the original preference was true, but journal retirement
requires the destination bytes to validate exactly against the intended staged
RK. If both the source and a valid destination are absent, cleanup is
`integrity-failure`, not successful preference restoration. It is removed when
the preference was false only on the winning/ordinary path.
`competing-cleaned` is explicitly excluded from both promotion and bare unlink
regardless of cache preference: the losing staged RK, device file, and MK file
are always durably renamed together through design 180's one-manifest shared
local-quarantine primitive, keyed by the journal request digest and completed
only after all three hash-checked renames and the durable terminal marker.
Design 180's full hardened writer contract applies to that
primitive's quarantine directory chain, `quarantine-resume.json`, and
`completed.json`, including ancestor publication, same-directory exclusive
temporary-file creation, complete writes, temporary-file fsync and close,
atomic rename, exact read-back, published-file fsync, and parent-directory
fsync; design 180's tests inject every writer-stage failure for both JSON files
and both quarantine users. A failed save or locator write leaves the hold,
completion intent, and `rk.key.staged` intact.

On resume, a valid completion-intent record retries that exact mode and target
under this design's Keychain or file rules, except for the one legal
pre-receipt Keychain-to-file RETARGET below. If no record exists because the
process crashed before the choice was durably published, the resume UI
deterministically re-presents the completion options and reconstructs the
canonical phrase from `rk.key.staged`; it does not claim to know or resume the
original selection. This true absence, with no RETARGET witness, is the only
reselection case. A present intent that is structurally invalid or has a
version, account, request-digest, shape, or target mismatch is preserved and
fails closed as integrity evidence; it is never replaced by reselection.

After an interactive Keychain write failure and separate explicit plaintext
consent, the caller resolves the exact absolute fallback path and asks design
180 to durably supersede the Keychain intent with that `kit-path` intent under
the account genesis lock. Before any canonical replacement, design 180 durably
publishes `genesis-completion-intent.retarget.json` under its full hardened
writer contract. The witness embeds the exact old Keychain intent and exact new
resolved-path intent, binds both to the active account and request digest, and
stores a digest for each exact intent. Only after its exact read-back,
published-file fsync, and parent-directory fsync may replacement proceed.
Rename may expose the new canonical record before
read-back, published-file fsync, and parent-directory fsync finish, so this seam
does not claim an old-before/new-after supersession binary. A failing RETARGET
invocation creates or writes no fallback file, including when failure occurs
after rename. On locked resume, design 180 strictly loads the witness first and
accepts only either its exact old account/request-bound Keychain intent or its
exact new account/request-bound resolved file intent as canonical. It
idempotently completes
exact read-back, published-file fsync, and parent-directory fsync for whichever
exact value it found, then durably retires the witness only after that survivor
is fully durable. An absent canonical intent while the witness exists, an
invalid witness, or any canonical value outside its exact two-value allowlist
fails closed and preserves all evidence. The old value retains the Keychain
target with no fallback write; only the reconciled new value permits this
design to begin commitment to that exact file target after witness retirement.
No other retarget is legal, and no retarget is legal after
`artifact-committed` or any other completion receipt.

`rbox key status` reads design 180's journal state and reports `recovery phrase
staged, not yet saved`; it does not infer pending state from `kit.json` or
mutate either record. Keychain locator reconciliation layers on the same
artifact and never defines a second recovery path. Verified
`competing-cleaned` authorization and every crash-resume/cleanup decision remain
entirely design 180 concerns.

### Hardened cache/locator/file contract

Design 180 owns the durability contract for `rk.key.staged` and its journal.
This design adds a normative durability contract for promotion to `rk.key`, the
`kit.json` commitment locator, and every explicit `--kit-path` plaintext
commitment. When any of those is the first write below a fresh `RBOX_HOME`,
create the complete plain-directory chain without following
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
artifact commitment, and design 180 may retry idempotently.

For `--kit-path`, that entire sequence — including post-rename read-back,
published-file fsync, and containing-directory fsync — must finish before its
plaintext locator is published in `kit.json`. The locator must then itself meet
the same durability contract before design 180's hold can be released. The
existing `writeRecoveryKit` content read-back and
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
unwrap is `src/engine/e2ee/session.ts:516-520`; existing tests at
`src/engine/e2ee/session.test.ts:76-95` cover successful unwrap and a wrong
phrase/key against the correct envelope, not substitution of a wrong or
historical envelope. The same new helper,
`assertCurrentRecoveryWrap`, gates ordinary restore/recovery too, fixing the
current gap rather than making validation safer than the admission path.
Validation does **not** build or publish an admission roster, cache RK, or write
kit metadata. The Keychain add begins only after every binding and validation
succeeds; every error stores nothing. Design 180's prepublication staged-RK
invariant is not a side effect of this validation helper.

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
For genesis, “wins” is scoped to one resolved design-180 enrollment episode:
offer metadata cannot turn an unresolved journal into a resolved one.

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
- `kit.json` has no genesis-staging field. Design 180's journal records the
  original cache preference and owns all pending/cleanup state; record mutation
  and restore never embed, copy, complete, or clear that state.

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
cannot duplicate it for ordinary non-genesis offers. Genesis is the controlled
exception: while design 180's same enrollment journal remains active with both
the completion-intent record and RETARGET witness absent, its resume handler
may re-present the completion UI even when `kit.json` says
`outcome:"claimed"`. A present invalid record fails closed. The genesis lock
serializes that decision; the existing claim is reused rather than recorded as
a second offer, and journal resolution—not prompt emission—ends the episode. Once a
valid matching completion intent exists, restart resumes that target rather
than offering a new selection. `kit.json` is local
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

When design 180 reports an unreleased recovery-kit hold, the staged warning is
emitted in addition to artifact states; staged RK alone never renders as a saved
recovery kit. `rbox key status --json` returns before any offer claim or nudge,
preserving the current JSON/human boundary (`src/cli/auth-cmd.ts:468-488`). It
may perform read-only probes. `recoveryKit` gains `version`, `keychain`
(including live state), `plaintextArtifacts` (each with live state), `offer`,
and, for a file, it also preserves the existing `path`/`writtenAt` compatibility
fields, plus a read-only pending-genesis projection sourced from design 180.
Status JSON never invokes genesis reconciliation: it writes nothing, prints no
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
  written until the user separately consents. During staged genesis, consent
  still does not authorize a file write by itself: while the journal is active
  and receipt-free, design 180 must RETARGET the exact Keychain completion
  intent to the resolved plaintext path using its hardened write-new-then-
  supersede replacement and witness-first reconciliation protocol. A retarget
  failure writes no fallback file. On locked resume, a valid witness permits
  only its exact old or exact new canonical intent, and the survivor's read-back/
  file-fsync/directory-fsync suffix plus durable witness retirement must
  complete before the Keychain target is retained or exact fallback commitment
  may begin. Any other state fails closed; a receipt-bearing journal forbids
  retarget and follows its existing cleanup outcome.
- **Non-interactive genesis with `--kit`:** after the mandatory pre-publish
  design-180 `rk.key.staged` publication, a Keychain failure returns nonzero but
  leaves that artifact and its unreleased journal hold for the setup/genesis
  resume handler. It never silently creates a Downloads file. Only a
  verified Keychain or explicit-file locator requests `artifact-committed`;
  design 180 then restores the recorded `cacheRecovery` preference during
  cleanup.
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
  plaintext. During staged genesis, leave design 180's `rk.key.staged` and
  unreleased completion hold intact because the commitment locator is not yet
  durable. A later exact probe/re-save can repair metadata.

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
Design 180 owns `rk.key.staged` creation/durability/hold/cleanup, the separate
completion-intent record, bootstrap-attempt persistence, verified enrollment
classification, API publication, and repair; this design consumes its journal
phases and exact completion target only to layer cache-preference restoration
and verified Keychain/file locator commitment.

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
   mutation-free behavior; typed design-180 journal/cleanup outcomes; hardened cache/locator/
   explicit-file publication, exact read-back, file and parent-directory fsync,
   and post-unlink parent-directory fsync failures; fresh empty `RBOX_HOME`
   creation through every ancestor with injected failure at each ancestor fsync;
   cleanup precheck + second pre-unlink check; and uninstall state precedence,
   including design-180 pending state plus plaintext and custom-Keychain backing paths
   inside the removal root.
2. **Command tests:** add dispatch/help/completion coverage for `key save`,
   cached no-stdin save, no-cache hidden TTY input, bounded non-TTY stdin,
   invalid/wrong-account phrase stores nothing, validation performs no
   admission/cache mutation, and explicit wrong-envelope and historical-
   envelope substitution tests fail before unwrap even when the substituted
   context is otherwise well-formed or historically authorized.
   Non-interactive macOS genesis records the original
   cache preference in design 180's journal without forcing a temporary
   `rk.key`, and design 180 durably publishes `rk.key.staged` before POST;
   stage/ancestor-fsync failure prevents publish;
   completion intent is durably published before phrase display, Keychain add,
   or explicit-file write; a restart with intent retries the exact resolved
   identity/path, while a restart without intent visibly re-presents the
   choices from staged RK only when no RETARGET witness exists. Every present
   structurally invalid or version/account/digest/shape/target-mismatched intent
   is preserved and fails closed. Persist `outcome:"claimed"`, crash after the claim
   but before prompt emission or intent publication, and restart with the same
   active journal: the completion prompt is visibly re-presented as continuation
   of that enrollment episode without a second independent offer claim. Once a
   valid matching intent exists, restart resumes that target instead of
   re-offering. Exact Keychain or
   explicit-file verification, file fsync, containing-directory fsync, and
   atomic commitment-locator persistence all precede the `artifact-committed`
   receipt; crashes at each ordering boundary retain or reconcile RK safely;
   design 180 alone authorizes cleanup and handles indeterminate/orphan/
   integrity outcomes; both original `cacheRecovery` preferences are restored
   by promotion/removal during ordinary winning cleanup, with exact destination
   RK bytes required before promotion retirement; source absent plus invalid or
   absent destination fails closed. `competing-cleaned` always quarantines
   the losing staged RK, device file, and MK file together, regardless of
   preference, and never promotes or bare-unlinks them; journal retirement
   waits for the completed three-entry manifest. Staged status copy is emitted,
   `showRecoveryPhrase` is never called, offer copy adapts, JSON emits no
   nudge/write, and wizard offers before dropping phrase.
   For interactive staged genesis, inject Keychain failure, explicit plaintext
   consent, every crash/failure boundary of the hardened intent replacement,
   fallback file publication and verification boundaries, locator publication,
   and receipt publication. Add stage-specific locked-resume reconciliation
   cases for crashes after replacement rename, after exact read-back, after
   published-file fsync, and after parent-directory fsync. Extend that four-stage
   matrix with crashes immediately before and after durable witness publication,
   require the witness through every replacement durability stage and the pre-
   retirement point, then cover post-unlink and post-parent-fsync witness absence
   only after the survivor is fully durable.
   Assert the failing invocation performs no fallback write; resume reads the
   witness first and accepts either its exact old Keychain intent or exact new
   file intent, completes the remaining read-back/file-fsync/directory-fsync
   steps for whichever it found, and only then durably retires the witness and
   proceeds. Missing canonical state with a witness, an invalid witness, and
   every third canonical state fail closed. The exact old intent
   retains the Keychain target, only the reconciled exact new intent permits
   the exact fallback file target, and no retarget is allowed after a receipt.
   Relevant existing surfaces are `src/cli/auth-cmd.test.ts`,
   `src/cli/help-registry.test.ts:31-42`, and
   `src/cli/setup-cmd.test.ts:1094-1133`.
3. **Restore command matrix:** deterministic command tests use injected probe,
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
   | Successful recovery; no Keychain artifact at locked re-read | Atomic `discoveredAt` merge preserves existing plaintext artifacts and offer and invents no `writtenAt`; design 180's journal is untouched. |
   | Successful recovery; same identity at locked re-read | Merge preserves existing timestamps plus plaintext and offer axes; it adds only missing discovery metadata and leaves design 180 untouched. |
   | Successful recovery; different identity appeared before locked re-read | Concurrent identity and every other axis remain unchanged; emit a safe conflict warning. |
   | Rediscovery record lock/read/write failure | Safe warning only; enrollment remains successful. |
   | Unknown record | Resolver is called exactly once and read/recovery may proceed, but the record remains byte-for-byte untouched and a safe metadata warning is emitted. |

4. **Darwin integration:** create a throwaway temp Keychain and pass its path
   explicitly to the exact production byte stream. Test add, exact verify,
   `-U`, duplicate service/account isolation, present/missing classification,
   restore read, rediscovery records `discoveredAt` without inventing
   `writtenAt`, locked metadata probe, wrong identity, timeout/kill, and delete.
   Never touch the user's login/default/search-list Keychain.
5. **Real-Mac validation:** fresh genesis from an empty `RBOX_HOME`, cached and
   typed `key save`, standalone
   and wizard recover, Keychain Access findability/search/show-password,
   reinstall/deleted-kit.json restore, locked GUI, unlocked GUI, SSH into a GUI
   session, truly headless/locked SSH, user cancellation, timeout, and plaintext
   fallback. Observe rather than assume SecurityAgent prompt behavior.
6. **Deletion/uninstall validation:** race-replace file during cleanup prompt,
   symlink swap, handle/path inode mismatch, wrong account, same banner/wrong
   phrase, oversized/unreadable file, declined cleanup, missing item, unavailable
   Keychain, unknown future record, artifact inside the uninstall root, and
   surviving-present-artifact precedence.
7. **Repo validation:** unit/typecheck plus `bun run rig` or a dev build shipped
   to the local fleet, per repository flow; documentation/usage snapshots and
   any CODEMAP ownership line stay in sync.

## Slices

1. `recovery-kit-keychain.ts`: shared spawn runner, explicit identity resolve,
   one-line add/verify/read/probe, OSStatus classifier, seams, and darwin test.
2. `recovery-kit.ts`: v2 envelope/migration/parser without genesis staging,
   atomic claim, orthogonal artifact mutations, hardened directory/file
   publication, bounded plaintext parser, cleanup revalidation, and aggregate
   safety.
3. `rbox key save` + phrase-envelope validation + cached/typed source selection;
   dispatch/help/completions/usage and no-echo/TTY tests.
4. Genesis staged-RK integration with design 180's typed outcome plus
   genesis/backup/standalone-recover/wizard-recover zero-typing offer plumbing;
   status human/JSON rendering, once-per-installation claim tests, and the
   unresolved-genesis journal-resolution exception.
5. Restore-from-Keychain read/fallback/rediscovery flow, uninstall consumer,
   exact-match plaintext migration, integration matrix, and changelog note for
   non-interactive `--kit`.

## Open questions (for review)

None in v18. The phrase-source, ACL, process, identity, state, offer, cleanup,
probe, uninstall, restore, staged-RK durability, explicit-file durability,
directory-chain durability, and wording rulings above remain pinned and are not
reopened by the design-180 split. Genesis publication, replay, classification,
repair, and promotion order are reviewed only in design 180. Both binding r10
seam rulings are folded above and control the genesis offer-resolution. The
binding r11 seam ruling and both binding r12 seam rulings are folded above; r12
controls pre-receipt fallback-retarget provenance, witness reconciliation, and
absence-only reselection.
