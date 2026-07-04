# 65 — Data export: `rbox export`, "give me all my files back" for an E2EE product

**Status:** draft — design only.
**Depends on:** design 12 (E2EE recovery phrase + enrollment, shipped), design 09
(pull/reconcile engine, shipped), design 58 (recovery-kit `~/Downloads` path logic,
implementing).
**Explicitly out of scope:** version history, trash contents, per-file version
picks, any server-side plaintext export (§6).

## 1. Problem

There is no data-export / takeout path. "Give me all my files back" is table
stakes and GDPR-adjacent (Art. 20 portability), and today the only way to get a
workspace off rbox is to `rbox init --workspace <id>` a fresh binding per
workspace and let sync materialize it — a sync setup, not an export, and it leaves
a live daemon binding behind.

Because rbox is end-to-end encrypted, the server can *only ever* hand out
ciphertext — it holds no filenames and no plaintext (design 12). So export **must**
be client-side, under the user's keys. The founder's own framing: *"i'd love for
that to work if we have a secret key of a user i guess"* — i.e. export must work for
a user who has an enrolled device **or** only their 24-word recovery phrase, and
nothing else.

The good news, from the code: a full workspace is *already* reconstructible from
the network alone. `pull()` (`src/cli/sync.ts:110`) validates the remote manifest,
reconciles it against the local baseline, and materializes every blob to disk; on a
fresh root the baseline is `EMPTY_MANIFEST` (`config.ts:107`, `loadState` returns it
for a missing state file), so reconcile writes the *entire* tree. That is exactly
what `rbox init --workspace <id>` + first sync does on a new machine. Export is that
machinery pointed at a throwaway directory instead of a binding.

## 2. Decision

**New command:** `rbox export [--workspace <id> | --all] [--out <dir | .tar.gz>]`.

1. **Default `--all`.** Enumerate the account's workspaces via the existing
   `GET /v1/account/workspaces` (`fetchAccountWorkspaces`,
   `workspace-picker.ts:192`) — each row already carries `{ workspaceId, projectId,
   name }` (`workspace-picker.ts:18`), so the listing alone selects exactly what to
   export; no new endpoint. `--workspace <id>` narrows to one.

2. **Output location — reuse design 58.** Default writes
   `rbox-export-<acct16>-<YYYYMMDD>/` under `~/Downloads` when it exists, else
   `$HOME` (never *create* `~/Downloads`; headless Linux often lacks it). This is
   the recovery-kit convention verbatim — reuse `defaultKitTargetDir` /
   `displayPath` and the `accountHex16` / `localYmd` helpers
   (`recovery-kit.ts:50,90,104,204,210`). Per workspace a subdirectory named
   `<sanitized-name>-<workspaceId-first8>` (name part omitted when unnamed) — the id
   suffix is ALWAYS present because workspace names are **not unique** (no uniqueness
   constraint at `createWorkspace`; codex adversarial finding, review 2026-07-03: two
   workspaces both named `app` would otherwise silently merge/clobber into one export
   dir). Each holds a **plain directory tree — no `.rbox` metadata**. `--out` overrides: a directory path, or a `*.tar.gz` path to emit a
   single gzipped tarball instead of a tree.

3. **Latest state only, v1.** Export materializes each workspace's newest manifest.
   Not point-in-time, not history — see §6.

4. **Enrolled device, or recover-then-export — deliberately no phrase-only path.**
   Export runs from any device that is already enrolled: it uses the cached device
   keys via the *same* `buildAuthedRemote` seam sync uses (`e2ee-client.ts:203`,
   `ensureSecrets` at `:178`). If this machine is **not** enrolled, export refuses
   with: run `rbox recover` (paste the 24 words → `enrollViaRecovery`,
   `e2ee-client.ts:144`, self-admits a fresh roster device) then re-run export. We do
   **not** build a separate phrase-only decrypt path: recovery *is* enrollment, and
   funneling phrase-holders through `rbox recover` reuses the hardened admission +
   MK-unwrap code instead of forking a second, less-tested crypto path. This is the
   deliberate simplification, and it satisfies the founder's "only their secret key"
   case — the phrase becomes an enrolled device, then export is identical.

5. **Export ≠ sync.** Read-only. It must **not** create a workspace binding, start
   or touch a daemon, or write desired-state. See §3 for how we hold that line given
   what `pull()` writes.

6. **Disk-safety.** Refuse to overwrite an existing export dir/tarball (fail
   closed, tell the user to move it or pass a new `--out`). Materialize into a temp
   staging dir, `fsync`, then atomically rename into place and drop a
   `rbox-export.json` completion marker (`{ account, workspaces, files, bytes,
   finishedAt }`) — a half-finished export has no marker and is detectable. Print a
   summary: workspaces exported, file count, total bytes.

## 3. Mechanism (and the bindingless-pull reality)

`pull(root, cfg, deps)` is *already* parameterized on `cfg` and `deps` — it does
**not** read the config file itself, it takes `cfg` as an argument. So the sync core
is reusable as-is. Two disk facts constrain us, both verified in `sync.ts`:

- **`pull` always writes `.rbox` metadata into its root.** It calls
  `loadState`/`saveState` (`.rbox/state.json`), `HashCache.load/save`, and — when
  `trashConfig(cfg).days > 0` — `openTrashBatch(root)` (`sync.ts:167`). So pull
  materializes the plaintext tree **plus** a `.rbox/state.json` + hashcache into
  `root`. It is therefore *not* filesystem-bindingless; the clean "no `.rbox`" tree
  is produced by a post-pass.
- **`buildAuthedRemote(root)` requires an on-disk binding.** It opens
  `loadConfig(root)` (`e2ee-client.ts:204`) and throws if `.rbox/workspace.json`
  is absent. This is the only part that genuinely needs a binding.

**Chosen mechanism — temp binding + strip (zero engine change):**

For each target `(workspaceId, projectId)`:
1. Make a throwaway staging dir (under the OS temp dir, or inside the export
   staging area).
2. `saveConfig(stagingRoot, cfg)` a synthetic `e2ee/v1` config for that workspace
   (`schema:"e2ee/v1"`, `remoteWorkspaceId`, `projectId`, `rootPath:stagingRoot`,
   `syncGit` on so git repos rematerialize as real working repos). Set trash off
   for this run via the persisted config field `trash: { days: 0 }` (NOT
   "`trashConfig.days`" — `trashConfig()` is a derived helper over the config, codex
   review 2026-07-03) so pull skips `openTrashBatch` — a throwaway needs no trash tier.
3. `buildAuthedRemote(stagingRoot)` → injects token + KEK from the enrolled
   keystore, exactly as sync does.
4. `pull(stagingRoot, cfg, deps)`. Fresh baseline (`EMPTY_MANIFEST`) → reconcile
   emits a `write` for every file; the mass-delete guard (`sync.ts:155`) never fires
   (`baseFiles === 0`, zero deletes). Wire `deps.onProgress` to the spinner.
5. Copy/rename every entry **except `.rbox/`** into the workspace's export
   subdirectory; `fsync`; discard the staging dir.

This reuses the fully-hardened pull/reconcile/decrypt path unchanged, and the only
export-specific code is: enumerate workspaces, synthesize a config, strip `.rbox`,
and the tar/marker/summary shell. It creates **no** durable binding (the staging
config is deleted) and starts **no** daemon.

**One durable side effect, intentional (codex review 2026-07-03 flagged it):** pull
through `buildAuthedRemote` advances the device's **anti-rollback pins** for each
exported workspace (the pin store is per-device, keyed by workspace, outside the
staging dir). This is correct, not a leak: a pin records "this device has
authentically observed sequence N," and the export genuinely observed it — advancing
the pin strengthens rollback protection for later syncs on this device. We document
it rather than build a throwaway in-memory pin store, which would discard a true
observation. No other real workspace state is touched.

> Alternative considered — extract an in-memory `buildAuthedRemote` variant that
> takes `(workspaceId, projectId)` and never writes `workspace.json`. Rejected for
> v1: it's a real refactor of the auth seam, and pull *still* drops `.rbox/state.json`
> + hashcache into its root, so the strip pass is needed either way. The temp-binding
> approach buys the same result with no engine change. Revisit if the synthetic
> config ever proves leaky.

**Tarball mode** streams the stripped tree into `*.tar.gz` and writes the marker
beside it.

## 4. Security & privacy

Export writes **plaintext to the user's local disk, by their explicit command** —
the same trust model and precedent as the recovery kit (design 58 §Security: the kit
puts the 24-word phrase in `~/Downloads` on request). No new server exposure: every
byte crosses the wire as ciphertext and is decrypted only in-process under the
device KEK; the server never holds plaintext and gains no new endpoint (§2.1). The
staging dir holds plaintext transiently and is removed on completion; on a crash it
is an unmarked, incomplete tree the user can delete. Files are written with normal
perms (this is the user's own data landing in their own Downloads) — unlike the kit,
which is 0600 because it *is* key material; an export is not. We do not encrypt the
output: an encrypted export the user can't open defeats the purpose, and the phrase
already exists for that.

## 5. Test plan

- **Rig scenario (primary):** device A pushes a representative tree (nested dirs, a
  git repo, an ignored file); on device B (enrolled via pairing) run `rbox export
  --all`; assert the exported tree equals A's source **minus ignored paths**, reusing
  the rig manifest helpers (`compareManifests` / `canonicalManifest` /
  `isPrunedPath`, `scripts/rig/lib/manifest-check.ts`). Assert the completion marker
  exists and its `files`/`bytes` match, and that **no** `.rbox/` leaked into the
  export tree and **no** daemon/binding was created (no `.rbox/workspace.json` at the
  export root, no daemon pid).
- **Recover-then-export:** on an un-enrolled device B, `rbox export` refuses with the
  recover hint; after `rbox recover <phrase>` the export succeeds — proves the
  phrase-only user (founder's case) is covered with no separate decrypt path.
- **Unit tests (business logic, not type-restating):** overwrite refusal (existing
  dir/tarball → fail closed); default path selection (`~/Downloads` present vs absent
  → `$HOME`), reusing design 58's `kitTargetDir` test shape; export-subdir naming
  (named workspace vs short-id fallback); half-finished export has no marker.

## 6. Out of scope

- **Version history** — export is latest-state only. `rbox versions` + `restore`
  already cover point-in-time recovery of individual files; a full historical export
  is a large, rarely-needed feature.
- **Trash contents** — trash is a deletion-safety tier, not part of "my files."
- **Per-file version picks** — same rationale as history; per-file time travel is
  `restore`'s job, not bulk export's.
- **Server-side / plaintext export** — impossible by construction (E2EE, design 12);
  the server has only ciphertext and no key.
- **Key rotation / phrase-only decrypt path** — rotation stays design 19
  (unimplemented); phrase-holders go through `rbox recover` (§2.4), not a second
  crypto path.
