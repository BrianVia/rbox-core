# 274 — Sender device naming: "take via-desktop's version"

Status: ALIGNED r3 (r1 review REVISE → r2 fold → delta-confirm ALIGNED →
r3 founder rulings: trust-the-fleet producer, id restored as fallback
rung, generic copy demoted to unstamped-only)
Origin: split from design 273 P4 (final serial review, r3.1); founder
directive 2026-08-17: "Use the real device name like via-desktop." Root
user report: Max — "keep-mine / take-theirs meant nothing."
Compat context: v2-beta breaking window is open (founder fleet only), but
this design needs NO breaking change — the field is additive everywhere.

## Product bar

Every surface that today says "another computer" / "the other computer" /
"your other computer(s)" names the actual computer when rbox knows it:
"Waiting from via-desktop (branch main, 4 commits newer than yours)".
Degrade chain (FOUNDER RULING 2026-08-17, supersedes review finding 3):
server label (usually the hostname — labels default to os.hostname at
login) → device id → today's generic copy ONLY when the section carries
no stamp at all (pre-274 data; ages out as repos re-capture). The
founder's bar: "show the real name as almost as always as you can; don't
bother with 'another computer'". With login-time priming the id rung is
rare and the generic rung temporary. `--json` carries `deviceId` always. There is NO revoked rung: the
device-list endpoint filters revoked rows out (apps/api/src/auth/
devices.ts:19), so "revoked" is indistinguishable from "enrolled since
last refresh" — rendering a status claim off absence violates the
never-guess rule. (Server-side revoked rendering would need an API change
— separate product decision, out of scope.) NEVER a guessed name: the id
comes from the section's own stamp, not from who last pushed the manifest
(a carried section's pusher is routinely the wrong machine).
Possessive grammar: a label containing whitespace or an apostrophe drops
to the non-possessive construction ("Taking the version from Brian's
MacBook Pro") so copy never renders "…Pro's's version".

## D1. Stamp the author at capture: `GitSection.deviceId?`

- Written at the ONE composition point, `sync-git/capture.ts:380-390`,
  threaded via a new optional `GitCaptureOptions.deviceId` (NOT a 15th
  positional on `capturePlannedGitSection` — shared.ts:278 already has 14;
  recon gap 1). Value: `cfg.deviceId` (workspace-config.ts:26). Optional so
  non-sync-git `captureGitState` callers are untouched.
- Wire-additive, verified by recon + review:
  - Validation is TRUST-THE-FLEET + READER-TOLERATE (FOUNDER RULING
    2026-08-17: pairing is rigorous — no producer shape policing).
    Producer: stamp cfg.deviceId whenever non-empty, with only a
    generous length cap (<=200 chars, manifest hygiene, not trust).
    Reader: an absent/empty/oversized deviceId is treated as ABSENT and
    the section still validates — same rule as refScope (design 93 v12,
    manifest-validate.ts:428-433: reader-side invalidity must never make
    the section/manifest fatal). Context kept for the record: r1's strict
    reader regex was a BLOCKER (real ids include env-credential "env" and
    API-key ids without the dev_ prefix, and validateGitSection runs
    fail-closed inside encodeGitSection/encodeRepoRecord — a strict gate
    could stop sync for those workspaces).
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
  (base-composer.ts:10-31 AND state-plane/codecs/coverage.ts:83-104).
  They stay SEPARATE: they are two independent compile fences with
  different audiences (composer-family audit vs codec audit); unifying
  them would reduce a future field to one forced audit instead of two —
  r1's "unification" was scope creep that weakened a safety property,
  cut on review.
- Known, intended substitution: `normalizeOutgoingGitSections`
  (publisher-tombstones.ts:199-201) replaces a re-captured section with
  the pending one when incoming keys match — the pending section is the
  true author's, so its deviceId winning is CORRECT; documented at the
  site with a test.
- Churn ledger (review-corrected): the publish-side churn claimed in r1
  likely DOES NOT EXIST — unchanged repos carry by object reference (the
  !== short-circuit fires before deep equality), and changed repos already
  differ via generatedAt; withdraw unless measurement shows otherwise.
  The REAL one-time receiver-side costs, each once per repo:
  - apply.ts:1229 steady-skip fast path misses once (stamped incoming vs
    unstamped stored BASE), then self-heals (sanitize + composeRepoBase
    both retain the stamp);
  - sync-state-elision.ts:118 recordWouldNotChange misses once (repoGen
    bump, CAS-token invalidation for concurrent readers).
  Both named, both measured on one host in PR-A (perf-differential rule).
- Old sections (every currently-paused repo) have no stamp → degrade
  chain's tail; names appear organically as repos re-capture.

## D2. Device-label cache: `~/.rbox/device-labels.json`

- Source of truth: `GET /v1/auth/devices` (existing; response
  `{devices:[{device_id,label,created_at,last_seen_at,last_seen_version,isSelf}]}`,
  auth-command-wire.ts:47, apps/api/src/auth/devices.ts:17-23). Labels
  default to hostname at login (device-login.ts:629), so "via-desktop"
  exists server-side today.
- ONE machine-scoped file on the `account-profile.ts` pattern (NOT a
  per-account directory — one credential document exists per machine, the
  accountId is optional in legacy credentials so a keyed path can be
  unconstructible, and a directory accumulates stale accounts with no
  pruner): the file self-declares its `accountId`, guarded read returns
  undefined on mismatch, 0o700/0o600, tolerant parse-to-undefined, TTL
  check (update-check.ts:75-82 shape), cleared beside
  `clearAccountProfile()` on logout. Display metadata, not internal
  state — the plain-JSON/SQLite rule is satisfied deliberately (same
  class as account-profile.json/update-check.json); stated here so the
  state-plane reviewer sees it was decided, not defaulted.
- Writers: N daemons on a multi-workspace host share the file — write
  with `writeFileAtomic` and accept redundant refreshes after TTL
  (r1's "ONE writer" was false; the daemon interval —
  `runDeviceLabelRefreshIfDue`, src/cli/daemon/daemon.ts:1323 pattern,
  TTL ~6h — is authenticated, unlike the update check it imitates).
  Priming so daemon-less hosts aren't blind: populate at LOGIN
  (device-login already holds a token, one listDevicesAuth call away) and
  opportunistically from authenticated commands that already reached the
  server (account-profile.ts:73 scheduleAccountProfileWrite shape —
  fire-and-forget, failure-absorbing), plus `rbox device list`. CLI
  render paths only READ — never fetch.
- Render helper (one owner): `deviceDisplayName(deviceId, cache)` →
  label → the id itself (founder ruling — see Product bar); undefined
  only when no stamp exists. Labels are USER TEXT from the server:
  through the existing `sanitizeTerminalText` + bound (~40 chars) at the
  established sanitization boundary (git-evidence-render.ts:11), not a
  new one. `isSelf` comes from the server response (devices.ts:22,
  computed against the calling token) — recorded, not computed locally;
  staleness after a re-pair is cosmetic.
- `rbox device list --json` currently DROPS `label` (recon gap 6) — fixed
  here (additive JSON field).
- Deletion condition: if labels ever join the signed device roster, the
  cache is deleted and reads come from the roster.

## D3. Surfaces (copy)

Plumbing: `GitIncomingFacts` (git-evidence-model.ts:23-39) gains
`deviceId?`/`deviceLabel?`, populated at git-evidence.ts:169/:206 — that
alone reaches every 273-era surface. `GitResolveShow`/resolve-contract
gains the field for `printShow` (recon gap 10: trace and thread it).
The 273 story headline map is OUT OF SCOPE and stays literal data (its
closed-table discipline is the r4 lesson; one row's marginal payoff does
not justify function-valued rows). Names apply to: the group ACTION line
(git-story-render.ts:140), the evidence renderers, dry-run, show-me, AND
resolve-batch.ts (:110,:158,:159,:164,:170,:183 — the multi-repo surface
most exposed to mixed senders; the mixed/unknown-sender rule below binds
it explicitly).

With a name (label, or id when no label is cached) the copy becomes:
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
- Resolve sanitization contract: labels AND ids bounded + sanitized at
  render;
  the projection is not a sanitized boundary.
- Story vocabulary discipline (273): noun stays "computer"; names replace
  "another computer"/"the other computer" only, never the story grammar.

## Requirement ledger

| Mechanism | Owner | Deletion condition |
|---|---|---|
| `GitSection.deviceId?` (stamp at capture) | capture.ts composition point | wire v-next makes it required |
| `~/.rbox/device-labels.json` (accountId-self-declaring) + refresh sites | daemon interval + login/opportunistic priming; cleared on logout | labels join the signed roster |
| `deviceDisplayName` render helper | status-view (or shared text module) | none — it IS the product fix |

## Validation

- Identity lock: incoming-key/identity-key/held-classifier equality under
  differing deviceId (the recon-risk-3 test).
- Carry: a section captured on A, carried by B, applied on C renders A's
  name on C (fixture-level; the pass-through reference test).
- Pending-substitution: normalizeOutgoingGitSections keeps the pending
  author's stamp (site test).
- Hostile wire: an over-long or non-string deviceId is treated as ABSENT
  by the one reader gate (gitSectionDeviceId) and the section still
  validates; anything within bounds is carried verbatim (trust-the-fleet)
  and sanitized at render. Hostile LABEL from the server renders
  sanitized and bounded. NAMED TRADE: sanitizeGitSectionForPersistence
  does NOT strip an unusable inbound stamp (unlike config) — stripping
  would make the stored base differ from the raw wire section and
  permanently miss apply's steady-skip deep-equality bypass; an unusable
  stamp persists verbatim and simply renders as absent.
- Cache: malformed file → undefined (tolerant parse); TTL respected;
  missing cache/unknown id → the id renders (founder ruling); generic
  copy only for unstamped sections (no revoked rung).
- Degrade: unstamped section (every pre-274 pause) renders today's copy
  verbatim — zero regression on existing fleet state (replay the 273
  field fixtures unchanged).
- Surfaces: banned-word suite still green; singular/plural with names;
  mixed-sender group keeps generic copy (test).
- Steady-skip + write-elision one-time misses measured on one host
  (before/after per the perf close-out rule); publish-churn claim
  verified absent or withdrawn with evidence.
- Cache: mismatched accountId → undefined; logout clears; atomic write
  under concurrent daemons; possessive-grammar rule fixture (whitespace
  and apostrophe labels).
- Field acceptance: after fleet roll + one capture cycle on desktop, the
  Mac/FM listings name `via-desktop` for newly-paused desktop-authored
  changes.

## Sequencing (two PRs — review-corrected)

1. **PR-A (sync-plane, user-visibly inert):** the stamp (non-empty +
   length-cap only, per r3 — no shape gate) + reader tolerance + both
   coverage-map rows + identity regression locks + the two one-time-miss
   measurements. PR-B acceptance criterion (review): reads go through
   gitSectionDeviceId — a render test for 201-char and non-string wire
   values, and a grep-gate that `deviceId` is never dereferenced outside
   git-device-stamp.ts and capture.ts. Bakes on the
   fleet so the field exists on receivers before any copy promises it.
2. **PR-B (pure Adapter):** label cache + priming + deviceDisplayName +
   the ~15 copy sites + possessive rule + mixed-sender rule. Revertible
   alone.
No prerequisite decompositions: touched large files (resolve-presentation
222, git-evidence-render, git-stories 148) have headroom; doctor-triage.ts
is NOT touched (7-byte ratchet).

## Non-goals

- No per-commit attribution inside git history.
- No label editing UI (labels come from login --label / hostname).
- No server changes.
- Local "this computer" naming overhaul (keeps hostname mechanism).
