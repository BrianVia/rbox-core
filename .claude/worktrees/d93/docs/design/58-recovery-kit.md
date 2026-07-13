# 58 — Recovery kit: a saved file for the phrase that terminal scrollback eats

**Status:** draft → implementing (CLI-only; no server change).
**Depends on:** design 12 (E2EE recovery phrase, shipped), design 47 (browser login, shipped).
**Explicitly out of scope:** key ROTATION (a leaked phrase still can't be re-minted —
that remains design 19, unimplemented) and any server-side escrow (design 12 §NO).

## 1. Problem

The 24-word recovery phrase is the ONLY way back into an E2EE account when every
device is gone. Today it is printed once to stderr (`showRecoveryPhrase`,
`src/cli/auth-cmd.ts:16`) with a nag-until-acknowledged confirm — and then it lives
in terminal scrollback, which is where recovery phrases go to die. The local RK
cache (C9, `~/.rbox/e2ee/<acct>/rk.key`) survives on THIS machine but dies with
`rbox logout`/uninstall/`rm -rf ~/.rbox` — the founder's own fresh-slate wipe would
have destroyed his only copy had the phrase not been hand-saved.

1Password solved this a decade ago: the Emergency Kit — a generated file the user
downloads at signup. This design is that, sized for a CLI.

## 2. UX

### 2.1 Interactive (TTY) — offer-first, nag-second

At `showRecoveryPhrase` (the single choke point: bootstrap enrollment at
`auth-cmd.ts:55` and `rbox key backup` at `:245` both flow through it):

```
⚠️  rbox is END-TO-END ENCRYPTED. …

    <24 words>

Save a recovery kit file to ~/Downloads? [Y/n]        ← NEW, default YES
  ✓ recovery kit written: ~/Downloads/rbox-recovery-kit-8ecc4c6c-20260703.txt
```

- Accepting writes the kit (0600) and SATISFIES the acknowledgement — the existing
  "Have you saved this recovery phrase somewhere safe?" loop is skipped (the kit IS
  the save).
- Declining falls through to the existing nag loop unchanged.

### 2.2 Non-interactive — unchanged unless asked

Headless paths (CI, the rig) keep today's behavior: phrase printed + the
"SAVE THE PHRASE ABOVE" notice, NO kit, no prompt — the bench must never litter
hosts with key material (design 56 §16). Opt-in flag: `rbox login --bootstrap …
--kit [path]` writes the kit without prompting (default path if the flag is bare).

### 2.3 Re-generate later

`rbox key backup --kit [path]` — re-derives the phrase from the cached RK (C9;
refuses with today's message when not cached) and writes a kit without the prompt.
Plain `rbox key backup` keeps its current show-only behavior (plus the 2.1 offer,
since it flows through `showRecoveryPhrase`).

### 2.4 Visibility

`rbox key status` gains one line:

```
recovery kit: ~/Downloads/rbox-recovery-kit-8ecc4c6c-20260703.txt (written 2026-07-03)
```

or `recovery kit: none recorded — run `rbox key backup --kit`` — and when the
recorded file no longer exists at that path, say so (`file missing — moved or
deleted; re-run rbox key backup --kit`).

## 3. The kit file

- **Name:** `rbox-recovery-kit-<acct8>-<YYYYMMDD>.txt` (`acct8` = the 8-hex account
  suffix; date = local). Same-day rewrite for the same account = same name,
  overwrite (idempotent content). No collision across accounts by construction.
- **Location:** `~/Downloads` when it exists, else `$HOME` (never CREATE
  ~/Downloads; headless Linux often lacks it). `--kit <path>` overrides outright.
- **Perms:** 0600, written atomically (temp + rename, same dir).
- **Contents** (plain text, self-explanatory to a stranger finding it in a drawer):
  header ("rbox RECOVERY KIT — keep this somewhere safe"), account id, the
  generating device hostname + date, THE 24-WORD PHRASE, recovery instructions
  (install one-liner + `rbox login` + `rbox recover` + paste), and the two
  warnings: anyone with this phrase can decrypt everything; rbox has no escrow and
  can never reset it.
- **Record:** best-effort sidecar `~/.rbox/e2ee/<accountId>/kit.json`
  `{ path, writtenAt }` (same dir as the C9 `rk.key`) — powers §2.4. The record is
  a pointer, not a copy: no key material in it.

## 4. Implementation shape

New `src/cli/recovery-kit.ts` — pure builders + one impure writer:
- `kitFileName(accountId, date)`, `kitTargetDir(env)`, `renderKit(input)` — PURE,
  unit-tested (filename shape, Downloads-vs-HOME fallback, content includes
  phrase/account/warnings).
- `writeKit(phrase, creds, explicitPath?)` — resolve → render → 0600 atomic write
  → record kit.json → return path. Errors surface but never crash the enrollment
  flow (a failed kit write falls back to the nag loop; enrollment already
  succeeded).
- `showRecoveryPhrase` gains the offer (prompt via existing `promptConfirm`);
  `keyBackup`/`login` gain the `--kit` plumbing; `keyStatus` reads kit.json.
  Flag registered in `help-registry.ts` (login + key usage lines).

Tests: pure builders only (house rule — no prompt-widget tests): naming, dir
fallback, render content, kit.json round-trip via a tmpdir, and the
non-interactive-default-unchanged contract (no kit path taken when !isInteractive
and no flag).

## 5. Non-goals

- Kit on `rbox recover` (the user just typed the phrase; low marginal value, add
  later if asked).
- Encrypting the kit (it exists precisely for the lost-everything case — a
  passphrase-protected kit recreates the problem it solves).
- Any change to WHAT is cached locally (C9 stays opt-in as-is).
- Rotation/revocation (design 19).

## 6. Threat notes

The kit strictly widens where the phrase rests at the user's explicit request —
same trust level as the C9 cache but on purpose-visible storage. ~/Downloads is
cloud-synced/backed-up on many machines: that is partly the POINT (survives disk
loss) and partly the risk; the kit header says plainly what the file unlocks so a
user syncing Downloads to iCloud is making an informed call. Default-YES is
justified because the alternative today is scrollback (worse than any disk file)
and the phrase is already on screen in plaintext at that moment.

---

# V2 REVISIONS (design-review resolutions — binding; later overrides earlier)

R1 (BLOCKER, resolved by FOUNDER DECISION + informed-consent wording): the offer
STAYS default-YES — the founder explicitly chose "export by default, just to be
safe," and the default-No failure mode (user mashes through the nag having saved
nothing) leaves the phrase durable NOWHERE, which is strictly worse than a
plaintext file the header explains. Honesty fix: the prompt itself names the
consequence inline — `Save a recovery kit (writes the phrase in PLAINTEXT to
~/Downloads)? [Y/n]` — so Enter is informed consent, and the ack loop is skipped
ONLY when the kit write verifiably succeeded (file exists + content written); any
write failure falls through to the unchanged deliberate-No nag loop. The reviewer
objection (default-yes weakens the deliberate-ack pattern) is RECORDED here as
the trade-off the founder accepted.

R2: `--kit` + non-interactive SUPPRESSES the phrase echo — prints
`recovery phrase written to <path> — not echoed (--kit)` instead, so CI logs
never carry the phrase when a kit was requested. Interactive `--kit` still shows
the phrase (user present).

R3: `rbox key status` hints reflect reality: kit recorded → show path + state;
no kit but C9 `rk.key` present → hint `rbox key backup --kit`; no kit and NO
cached rk → say "no cached phrase on this device — use the copy you saved at
setup, or `rbox recover` (which will offer a kit)". AND the kit offer is ADDED
to `rbox recover` success (reversing §5): the user just typed the phrase, it is
in hand with no cache needed — that is the natural re-kit path for most devices.

R4: `rbox init --bootstrap … --kit` plumbs through (init-cmd.ts calls login();
the flag rides along) — scripts are not required to call login directly.

R5: flag shape split for the help/completions model: `--kit` (bare boolean,
default location) and `--kit-path <path>` (implies --kit). Both registered in
help-registry; completions get the standard arg-taking shape for --kit-path.

R6: secret-safe writer pinned: random temp name in the TARGET dir opened with
`"wx"` + mode 0600, write, fsync, atomic rename over the final name; on any
error unlink the temp and report (enrollment never crashes). lstat the final
path first — an existing SYMLINK there is refused (never write key material
through a link); a regular existing file is atomically replaced.

R7: filename uses the FULL account hex (16 chars): `rbox-recovery-kit-<acct16>-
<YYYYMMDD>.txt`. (8 hex was a 32-bit display key, not collision-proof.)

R8: problem-statement correction: `rbox logout` does NOT remove the C9 cache
(clearCredentials removes credentials.json only); the cache dies with
`rm -rf ~/.rbox`/uninstall/disk loss — the text above is amended by this note.

R9: `kit.json` written 0600; `key status` distinguishes three states: recorded
file present AND first line matches the kit banner; present but content
unrecognized ("replaced?"); missing.
