# 274 — Sender device naming: "take via-desktop's version"

Status: DRAFT r1
Origin: split from design 273 P4 (final serial review, r3.1); founder
directive 2026-08-17: "Use the real device name like via-desktop." Root
user report: Max — "keep-mine / take-theirs meant nothing."
Compat context: v2-beta breaking window is open (founder fleet only), but
this design needs NO breaking change — the field is additive everywhere.

## Product bar

Every surface that today says "another computer" / "the other computer" /
"your other computer(s)" names the actual computer when rbox knows it:
"Waiting from via-desktop (branch main, 4 commits newer than yours)".
Degrade chain, in order: server label → device id (`dev_a1b2c3d4`) →
today's copy ("another computer"). A revoked device renders "a computer no
longer on your account". NEVER a guessed name: the id comes from the
section's own stamp, not from who last pushed the manifest (a carried
section's pusher is routinely the wrong machine — the failure mode this
design exists to avoid).

## D1. Stamp the author at capture: `GitSection.deviceId?`

- Written at the ONE composition point, `sync-git/capture.ts:380-390`,
  threaded via a new optional `GitCaptureOptions.deviceId` (NOT a 15th
  positional on `capturePlannedGitSection` — shared.ts:278 already has 14;
  recon gap 1). Value: `cfg.deviceId` (workspace-config.ts:26). Optional so
  non-sync-git `captureGitState` callers are untouched.
- Wire-additive, verified by recon:
  - `validateGitSection` (manifest-validate.ts:394-437) tolerates unknown
    keys; 274 adds explicit validation anyway — hostile-wire bound:
    optional string, `^dev_[A-Za-z0-9-]{1,64}$`-shaped charset/length
    check (it lands in render copy; recon risk 5).
  - state codecs round-trip unknown fields (`canonicalJson` preserves;
    decode returns parsed object) — no schema change, no migration.
  - the server never sees sections (E2EE manifests; apps/api has no
    section validator) — zero server work.
  - carry is pass-through by object reference
    (plan-accumulator.ts:148-151 and every defer/revert/skip variant) —
    the stamp survives relay through non-author machines.
- Identity exclusion is BY CONSTRUCTION (every key/fingerprint is an
  allowlist): `gitIncomingKey` (shared.ts:130-147), `gitIdentityKey`
  (identity.ts:96-104), `heldClassifierInputKey` (held-skip.ts:94-95),
  carry matrix keys. Required regression lock (recon risk 3): a test
  asserting `gitIncomingKey({...s, deviceId:"a"}) ===
  gitIncomingKey({...s, deviceId:"b"})` (pattern: held-skip.test.ts:339)
  so a future refactor cannot fold it in and churn held-skip/carry.
- Forced audit checkpoints (the feature's compile fence): BOTH
  `GIT_SECTION_FIELD_COVERAGE` maps gain `deviceId: true`
  (base-composer.ts:10-31 AND state-plane/codecs/coverage.ts) — they are
  byte-identical duplicates; 274 unifies them into one imported map
  (recon risk 9) rather than editing two.
- Known, intended substitution: `normalizeOutgoingGitSections`
  (publisher-tombstones.ts:199-201) replaces a re-captured section with
  the pending one when incoming keys match — the pending section is the
  true author's, so its deviceId winning is CORRECT; documented at the
  site with a test.
- Named one-time churn: `sectionsDiffer` deep-equality
  (plan-accumulator.ts:290) sees old-advertised (no field) vs new-capture
  (field) as changed → one extra publish per repo per fleet host after
  rollout. Accepted (founder fleet, beta window); stated in the PR body.
- Old sections (every currently-paused repo) have no stamp → degrade
  chain's tail; names appear organically as repos re-capture.

## D2. Device-label directory: `~/.rbox/device-labels/<accountId>.json`

- Source of truth: `GET /v1/auth/devices` (existing; response
  `{devices:[{device_id,label,created_at,last_seen_at,last_seen_version,isSelf}]}`,
  auth-command-wire.ts:47, apps/api/src/auth/devices.ts:17-23). Labels
  default to hostname at login (device-login.ts:629), so "via-desktop"
  exists server-side today.
- Cache file follows the machine-scoped `update-check.ts:39-82` pattern
  exactly: RBOX_HOME-aware path, 0o700 dir / 0o600 file, tolerant
  parse-to-undefined on any malformed field, TTL `due()` check. Keyed by
  accountId (device lists are account-scoped; e2ee-keystore precedent).
- Refresh owner (ONE writer): a daemon interval beside the update-check
  timer (`runDeviceLabelRefreshIfDue`, daemon.ts:1323 pattern), TTL ~6h,
  plus a free refresh whenever `rbox device list` runs. CLI render paths
  only READ the cache — never fetch (status/resolve stay offline-fast).
- Render helper (one owner, used by every surface):
  `deviceDisplayName(deviceId, cache)` → label → id → undefined
  (undefined = keep today's copy). Revoked entries render "a computer no
  longer on your account". Labels are USER TEXT from the server: pass
  through `sanitizeTerminalText` with a bound (~40 chars) at render, like
  every other remote-authored string.
- `rbox device list --json` currently DROPS `label` (recon gap 6) — fixed
  here (additive JSON field).
- Deletion condition: if labels ever join the signed device roster, the
  cache is deleted and reads come from the roster.

## D3. Surfaces (copy)

Plumbing: `GitIncomingFacts` (git-evidence-model.ts:23-39) gains
`deviceId?`/`deviceLabel?`, populated at git-evidence.ts:169/:206 — that
alone reaches every 273-era surface. `GitResolveShow`/resolve-contract
gains the field for `printShow` (recon gap 10: trace and thread it).

With a name (label or id) the copy becomes:
- evidence header: `Waiting from via-desktop (branch main, 4 commits newer than yours):`
- overlap: `3 also changed on via-desktop ⚠`
- listing action: `or take via-desktop's version: …`
- dry-run: `Taking via-desktop's version would:` /
  `via-desktop's work is not deleted — it stays there…`
- branch mismatch: `⚠ You are on branch main here; via-desktop is on release.`
- show-me (resolve-presentation): `Waiting from via-desktop: …`, and the
  discard warning names it.
- stories/group headers that reference a SPECIFIC other computer use the
  name only when every repo in the group shares one sender; mixed or
  unknown senders keep the generic copy (never name the wrong machine).
- Plural/general references ("your other computers follow it", "two
  computers at once") stay generic — they describe the fleet, not a
  sender.
- "this computer" keeps the existing `localMachine` hostname mechanism
  (resolve-presentation.ts:203-208); if the cache marks isSelf with a
  label, `this computer (via-desktop)` may use it — cosmetic, optional.

## Protected functionality

- All identity/fingerprint allowlists unchanged (locked by the new
  regression test). Held-skip, carry, supersession behavior identical.
- No RepoRecord members, no SQLite schema change, no server change,
  SERVER_GIT_DEFERRAL_REASONS untouched, manifestSchema unchanged (no new
  schema gate — the field is optional and tolerated by old binaries;
  recon: old validators accept unknown keys).
- renderGitDeferralLine log grammar + redaction classifier byte-stable
  (the daemon LOG line does not gain names).
- Resolve sanitization contract: labels/ids bounded + sanitized at render;
  the projection is not a sanitized boundary.
- Story vocabulary discipline (273): noun stays "computer"; names replace
  "another computer"/"the other computer" only, never the story grammar.

## Requirement ledger

| Mechanism | Owner | Deletion condition |
|---|---|---|
| `GitSection.deviceId?` (stamp at capture) | capture.ts composition point | wire v-next makes it required |
| unified GIT_SECTION_FIELD_COVERAGE map | one shared module | none (replaces two duplicates — net -1 concept) |
| `~/.rbox/device-labels/<accountId>.json` + daemon TTL refresh | the daemon refresh interval | labels join the signed roster |
| `deviceDisplayName` render helper | status-view (or shared text module) | none — it IS the product fix |

## Validation

- Identity lock: incoming-key/identity-key/held-classifier equality under
  differing deviceId (the recon-risk-3 test).
- Carry: a section captured on A, carried by B, applied on C renders A's
  name on C (fixture-level; the pass-through reference test).
- Pending-substitution: normalizeOutgoingGitSections keeps the pending
  author's stamp (site test).
- Hostile wire: over-long/miscased/ANSI-bearing deviceId rejected by
  validateGitSection; hostile LABEL from the server renders sanitized and
  bounded.
- Cache: malformed file → undefined (tolerant parse); TTL respected;
  missing cache → id fallback; revoked → "no longer on your account";
  accountId keying (two accounts don't cross labels).
- Degrade: unstamped section (every pre-274 pause) renders today's copy
  verbatim — zero regression on existing fleet state (replay the 273
  field fixtures unchanged).
- One-time publish churn measured on one host and named in the PR body.
- Surfaces: banned-word suite still green; singular/plural with names;
  mixed-sender group keeps generic copy (test).
- Field acceptance: after fleet roll + one capture cycle on desktop, the
  Mac/FM listings name `via-desktop` for newly-paused desktop-authored
  changes.

## Sequencing

One PR (stamp + validation + coverage-map unification + cache + renders +
tests). No prerequisite decompositions: touched large files
(resolve-presentation 222, git-evidence-render, git-stories 148) all have
headroom; doctor-triage.ts is NOT touched (7-byte ratchet).

## Non-goals

- No per-commit attribution inside git history.
- No label editing UI (labels come from login --label / hostname).
- No server changes.
- Local "this computer" naming overhaul (keeps hostname mechanism).
