# Recon + draft design: `rbox upgrade` RboxBar management + download mention

Read-only recon of `rbox-core` @ `c8c357f1c`. No repo files modified.
Checklist items covered: `docs/2.0-RELEASE-CHECKLIST.md:19` (`rbox upgrade` app
management) and `docs/2.0-RELEASE-CHECKLIST.md:20` (install.sh / site mention).

---

## 1. How `rbox upgrade` works today

Single module, `src/cli/upgrade-cmd.ts` (527 lines), dispatched from
`src/cli/main-dispatch.ts:354-362` with `flags.check`, `flags.channel`,
`flags.remote` (default `DEFAULT_REMOTE`) and `commandDeps.isElevated`.

Flow inside `upgradeCmd()` (`src/cli/upgrade-cmd.ts:383`):

1. **Refuse non-installed / non-HTTPS** — `src/cli/upgrade-cmd.ts:384-389`.
2. **Executable-scoped context** — `src/cli/upgrade-cmd.ts:390-397`: `exe =
   realpath(process.execPath)`, `dir = dirname(exe)`, release state at
   `<exe>.release.json`, lock at `<exe>.upgrade.lock`.
3. **Channel** — `parseUpgradeChannel` / `readUpgradeChannel` /
   `upgradeManifestBase` (`src/cli/upgrade-channel.ts:10,30,18`). Persisted at
   `<exe>.channel.json`, schema `{schema:1,channel}` (`upgrade-channel.ts:76-84`).
   `latest` → `<remote>`, `next` → `<remote>/next`.
4. **Manifest fetch + Ed25519 verify** — `src/cli/upgrade-cmd.ts:406-407` fetches
   `<base>/version` + `<base>/version.sig`, then
   `verifyAndParseManifest()` (`src/cli/release-verify.ts:32`) checks the detached
   signature over the EXACT bytes with domain tag `rbox-release/v1\n`
   (`release-verify.ts:7,22`) against the embedded `RELEASE_KEYS`
   (`src/cli/release-key.ts`). This is the only way to get a trusted `Manifest`
   (`release-verify.ts:13-18`: `{version, keyId, artifacts: Record<string,
   {sha256, path}>, releasedAt?}`).
5. **Artifact selection + path binding** — `artifact()`
   (`src/cli/upgrade-cmd.ts:422-431`): name from `artifactName()`
   (`upgrade-cmd.ts:32-42`, `rbox-<os>-<arch>`, darwin-x64 explicitly refused),
   sha must be 64-hex, and `art.path` must equal `v<manifest.version>/<name>` or
   it refuses. **This is a per-binary-name rule — an app artifact would need its
   own explicit path assertion.**
6. **Forward-only floor** — `effectiveFloor()` (`upgrade-cmd.ts:312`) over
   `<exe>.release.json` (`pending` | `committed`) plus a legacy
   `~/.rbox/release.json` hint (`upgrade-cmd.ts:294-310`).
7. **Mutating section under `withUpgradeLock`** (`src/cli/upgrade-lock.ts`,
   flock-style, entered at `upgrade-cmd.ts:488`): re-read floor → apply channel
   selection → `downloadToTemp()` (`upgrade-cmd.ts:341`, streams to an `O_EXCL`
   temp in `dir`, hashes inline, no-progress watchdog) → sha compare vs signed
   manifest (`:497`) → `writeReleaseState(pending)` → chmod/fsync/`rename` over
   the live exe / fsync dir (`:504-511`) → `writeReleaseState(committed)` (`:519`).
8. **Daemon lifecycle** — `restartDaemonsAfterUpgrade()` (`upgrade-cmd.ts:98-149`)
   walks `~/.rbox/daemons/*`, validates the live pid is ours + bound to a valid
   desired workspace, runs `requireFolderAdmission` BEFORE the stop
   (`upgrade-cmd.ts:172-207`, design 276), then stop → `resumeDesiredDaemon`.
   Skipped when elevated (`:521-525`); "already current" path instead calls
   `restartStaleDaemonsIfAny()` (`:209-229`).

**Hook point for app management.** Two, both inside the same lock and both
already fenced by `ctx.elevated`:

- Upgraded path: after `writeReleaseState(committed)` + daemon restart,
  `src/cli/upgrade-cmd.ts:519-526`.
- Already-current path: `noUpgrade()` (`upgrade-cmd.ts:409-417`) — this is the
  path that must perform a *first* app install for a user already on the newest
  binary.

`--check` (`:453-458`, `:469-475`) must remain read-only.

## 2. RboxBar today: build, install, daemon contract

- **Sources**: `macos/RboxBar/` — SwiftPM, SwiftUI `MenuBarExtra`, macOS 14+.
- **Bundling**: `macos/RboxBar/scripts/bundle.sh` — `swift build -c release`
  (`--arch arm64 --arch x86_64` when `RBOXBAR_ARCHS=universal`,
  `bundle.sh:11-16`), assembles `RboxBar.app`, writes `Info.plist` with
  `CFBundleIdentifier=to.rbox.RboxBar`, `CFBundleExecutable=RboxBar`,
  `LSUIElement=true`, `LSMinimumSystemVersion=14.0`, and
  `CFBundleShortVersionString=${RBOXBAR_VERSION:-0.1.0}` (`bundle.sh:33-57`), then
  **ad-hoc signs**: `codesign --force --deep -s - "$APP"` (`bundle.sh:59`).
- **Release**: `.github/workflows/release.yml:92-135` (`rboxbar` job, secret-free,
  same exact-SHA main-CI gate) builds universal, asserts both Mach-O archs +
  stamped version, `ditto -c -k --keepParent` → `RboxBar-$VERSION.zip`, uploads a
  1-day workflow artifact. `publish` (`release.yml:225-266`) downloads it and does
  **two bespoke `wrangler r2 object put` steps**: immutable
  `releases/v$VERSION/RboxBar-$VERSION.zip` (`:241-255`) and, stable-only, the
  alias `releases/RboxBar.zip` (`:257-266`).
- **There is NO installer, launcher, updater, or restart handling anywhere in the
  repo.** The only install instructions are manual: `./scripts/bundle.sh; open
  ./RboxBar.app`, plus the documented `xattr -dr com.apple.quarantine RboxBar.app`
  dance (`macos/RboxBar/README.md:52-66`).
- **Daemon contract (grounds the restart story)**: the app is a *pure reader* of
  atomic status files under `~/.rbox/daemons/*` (or `$RBOX_HOME/.rbox/daemons/*`),
  rebuilt every ~2.5s — **no socket, no daemon round-trip**
  (`macos/RboxBar/README.md:7-10`; producer side is
  `src/cli/daemon/daemon.ts:184,2362,2443` `RboxBarAmbientStatus`, read by
  `src/cli/daemon/ambient-status.ts`). Actions (pause/resume/restart) shell out to
  the `rbox` binary discovered via `RBOX_BIN` then a fixed path list
  (`macos/RboxBar/Sources/RboxBar/RboxActions.swift:323-333`, first candidate after
  `RBOX_BIN` is `~/.rbox/bin/rbox`).
  **Consequence: killing and relaunching the app is stateless and safe** — it holds
  no daemon connection, no queue, no unsaved state. Worst case is a popover
  closing.
- **The app already self-checks for updates** but cannot self-update: it polls
  `https://api.rbox.to/version` every 6h
  (`macos/RboxBar/Sources/RboxBar/UpdateCheck.swift:74-92`) and only posts a
  UserNotification (`UpdateNotification.swift:16-40`,
  `AppModel.swift:149,373-383`). Today that notification is a dead end for a user
  with no way to install the new app — this design closes that loop.

## 3. install.sh and the site

- **Installer source of truth**: `scripts/install.sh` (155 lines). It is uploaded
  verbatim to `releases/install.sh` by `publishReleaseObjects`
  (`scripts/release-publish.ts`, the `putMutable(... "releases/install.sh",
  path.join(dist, "../scripts/install.sh") ...)` line). The `next` channel gets a
  rewritten copy via `nextInstallerSource()` (`scripts/release.ts:~60-108`) written
  to `releases/next/install.sh` (`scripts/release.ts:117-128`).
- Its trust model is TLS + **sha256 pinned from the TLS-fetched manifest**
  (`scripts/install.sh:38-42`), extracted by a constrained grep that is an explicit
  compatibility contract with `scripts/release.ts`:
  `"<name>":\{[^}]*"sha256":"[0-9a-f]{64}"` (`install.sh:50-62`). **That grep works
  unchanged for any new manifest key** — including an app zip.
- Natural place for a macOS one-liner: the post-install summary block,
  `scripts/install.sh:88-92` (after the "✓ rbox installed" lines, before the
  PATH section).
- **Site lives in a separate repo**: `/home/via/Development/Personal/rbox-home-page`
  (Astro). Install copy is `src/pages/index.astro:6`
  (`const INSTALL_CMD = "curl -fsSL https://rbox.to/install.sh | sh"`) and
  `src/pages/docs.astro:23`. It deploys via the `RBOX_HOME_DEPLOY_HOOK` Pages hook
  fired by `release.yml:290-296` (`docs/DEPLOYMENTS.md:87-90`). Any site copy
  change is a PR in that repo, not this one.

### BLOCKER found: the app zip is not publicly reachable

`apps/api/src/routes/release.ts` is the only public door to the `rbox_releases`
bucket. The `/bin/...` route allows 2- or 3-segment paths
(`release.ts:72-76`), and `cachedReleaseResponse` hard-restricts the filename:

```
if (!/^rbox-(darwin|linux)-(arm64|x64)$/.test(name)) return releaseNotFound();
```
`apps/api/src/routes/release.ts:106`

…and unconditionally sets `content-disposition: attachment; filename="rbox"`
(`release.ts:111`). So `releases/v2.0.0/RboxBar-2.0.0.zip` and
`releases/RboxBar.zip` **exist in R2 today but 404 through `api.rbox.to`**. Any
design here requires a worker change + a production promotion
(`docs/DEPLOYMENTS.md` branch model) before the CLI feature can work in the field.
Dev API (auto-deployed from `main`) makes this testable pre-promotion.

### The app zip is NOT in the signed manifest

`scripts/release.ts:304-325` builds `artifacts[\`rbox-${t}\`] = {sha256, path:
\`${tag}/rbox-${t}\`}` from the 3 cross-compiled binaries only, then signs
(`release.ts:332-346`). The zip is produced by a *different* job with *no* signing
secret and uploaded by hand-rolled wrangler steps. `verifyReleaseArtifacts`
(`src/cli/release-verify.ts:66-87`) therefore never sees it. Design 245 says this
explicitly: signing, `rbox upgrade` app management and installer copy "are
explicitly deferred rather than approximated here"
(`docs/design/245-versioned-rboxbar-release-artifact.md:41-47`).

## 4. Quarantine / Gatekeeper reality (the UX win)

Verified against how the bytes are fetched, not from memory:

- `com.apple.quarantine` is set by the *downloading* application via
  LaunchServices (`LSFileQuarantineEnabled`) — Safari/Chrome/Mail/AirDrop set it.
  **`curl` and `fetch()` do not.** `scripts/install.sh:64` uses `curl -fSL`;
  `rbox upgrade` uses `fetchWithDeadline` → plain HTTP writes to an `O_EXCL` temp
  (`src/cli/upgrade-cmd.ts:341-381`). Neither ever writes the xattr — and the
  existing binary path is the proof-of-concept: an installed `~/.rbox/bin/rbox`
  runs today with zero Gatekeeper prompts on the fleet.
- Quarantine on an extracted bundle is *inherited from the archive's own xattr*.
  `ditto -x -k` / `unzip` propagate it when present; with a curl-fetched zip there
  is nothing to propagate.
- Gatekeeper's first-launch assessment **and App Translocation both trigger only
  on a quarantined bundle**. A non-quarantined, ad-hoc-signed bundle in
  `~/Applications` launches directly and runs from its real path — **no
  right-click-open, no "unidentified developer" dialog, no translocated read-only
  copy.**
- So: **CLI-installed RboxBar sidesteps the entire unsigned-app dance that a
  browser download imposes.** This is the strongest argument for putting app
  management in `rbox upgrade` rather than shipping a download link, and it makes
  the deferred Apple Developer account a non-blocker for the founder fleet and the
  4 external users.
- Two caveats to prove on the Mac, not assume (per the "Darwin behaviors must be
  probed on the Mac" rule): (a) macOS 15 removed the Finder right-click-open
  bypass, so a *browser*-downloaded copy now needs System Settings → Privacy &
  Security → "Open Anyway" — which raises the value of the CLI path and lowers the
  value of a raw site download link; (b) `ditto -c -k --keepParent` must preserve
  the ad-hoc signature such that `codesign --verify` still passes after extraction.

---

# Design 282: `rbox upgrade` manages RboxBar

**Status: ratified 2026-08-20.** The three open product questions at the bottom
of this document were answered by the founder before implementation:

1. **Default ON.** The first `rbox upgrade` on darwin installs/updates/starts
   RboxBar. Opt out with `RBOX_NO_MENUBAR_APP=1`.
2. **`install.sh` stays a binary swap.** It only PRINTS one darwin-only line
   pointing at `rbox upgrade`; it never fetches or unpacks the app.
3. **No browser download link on rbox.to yet.** The API must still serve the zip
   (the CLI path depends on it) — it is simply not advertised. No `rbox-home-page`
   PR ships with this change.

## Core move (fewest moving parts)

**Fold `RboxBar.zip` into the existing signed release manifest and delete the two
bespoke wrangler steps.** Everything else falls out of machinery that already
exists — signature verification, sha binding, immutable-then-mutable ordering,
the upgrade lock, the elevated fence, `--check` read-only.

Net concept count: **zero new records, zero new lock, zero new state file, one new
manifest key, one new env kill switch, minus two ad-hoc publish steps.**

### 4.1 Release pipeline

- `build` gains `needs: rboxbar` and downloads the `rboxbar-dist` artifact to
  `dist/RboxBar.zip` **before** `bun scripts/release.ts --no-upload`.
- `scripts/release.ts` gains one explicit input (`--app=<path>`; absent on `--dev`
  local builds) that adds exactly one entry:
  `artifacts["RboxBar.zip"] = { sha256, path: \`v${version}/RboxBar-${version}.zip\` }`.
  Chosen so the existing publisher does the right thing with **no other change**:
  `publishReleaseObjects` uploads `releases/v<ver>/RboxBar-<ver>.zip` immutably,
  fetch-verifies its sha, then writes the mutable alias `releases/RboxBar.zip` —
  byte-for-byte the two objects release.yml writes by hand today
  (`scripts/release-publish.ts`, immutable phase then `putMutable(\`releases/${name}\`)`).
- `nextChannelStore` (`scripts/release.ts:117-128`) needs its two regexes widened
  (`^releases\/v[^/]+\/rbox-` → also match `RboxBar-`; `^releases\/rbox-` → also
  skip the `RboxBar.zip` alias) so prereleases keep publishing the immutable zip
  and keep NOT touching the stable alias — exactly design 245's contract.
- **Delete** `release.yml:241-255` and `:257-266`. `verifyReleaseArtifacts`
  (`release-verify.ts:80-85`) now covers the zip: a sha mismatch or a missing file
  refuses the whole publication, so the app fails closed *with* the release, same
  as design 245 promised, but now under the signature rather than beside it.
- Cost, stated honestly: `build` is serialized behind the ~macOS universal Swift
  build, lengthening the tag pipeline. That is the price of the zip being covered
  by the release signature; the alternative (a second signing authority for app
  bytes) adds a trust concept, which is worse.

### 4.2 API worker

`apps/api/src/routes/release.ts:106` accepts one more name shape and stops lying
about the filename:

- name regex: `^rbox-(darwin|linux)-(arm64|x64)$` **or** `^RboxBar(-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)?\.zip$`
- content-type `application/zip` and `content-disposition ... filename="RboxBar.zip"`
  for the app; unchanged for binaries.

Same rate limiter, same cache-control split (immutable versioned = 1y, alias = 300s).
No new route, no new segment (`worker.ts:424` already allowlists `bin`).

### 4.3 CLI: one function, called from two existing places

New module `src/cli/menubar-app.ts` (single owner of the app bundle on disk),
exporting one Interface:

```ts
export async function syncMenuBarApp(
  manifest: Manifest, remoteUrl: string, log: (line: string) => void
): Promise<void>
```

Called from `upgradeCmd` **inside the existing lock**, non-elevated only:
- upgraded path — after `restartDaemonsAfterUpgrade()` (`upgrade-cmd.ts:524`), so
  daemons are writing fresh status files before the app relaunches and reads them;
- already-current path — inside `noUpgrade()` (`upgrade-cmd.ts:409-417`), after
  `restartStaleDaemonsIfAny()`. This is the first-install door.
- **Never** from either `--check` branch (`:453`, `:469`).

Algorithm (all boring, all idempotent, no new persisted state):

1. `process.platform !== "darwin"` → return immediately, no output. (Linux is a
   silent no-op; the `linux-x64`/`linux-arm64` fleet sees nothing.)
2. `process.env.RBOX_NO_MENUBAR_APP === "1"` → return.
3. `const art = manifest.artifacts["RboxBar.zip"]`; undefined → return silently.
   This is how **old releases and pre-245 prereleases degrade**: no artifact, no
   app, no error.
4. Assert `art.path === \`v${manifest.version}/RboxBar-${manifest.version}.zip\``
   and `/^[0-9a-f]{64}$/.test(art.sha256)` — the app's own version of the
   defense-in-depth check at `upgrade-cmd.ts:426-429`.
5. **Resolve destination.** `~/Applications/RboxBar.app` unless
   `/Applications/RboxBar.app` already exists (then update in place). One branch,
   one rule: *never create a second copy of the app*. `~/Applications` is the
   default because it needs no sudo and no admin prompt (minimize-typing rule);
   `mkdir -p` it if missing.
6. **Skip if current**: `plutil -extract CFBundleShortVersionString raw
   <dest>/Contents/Info.plist` (the same primitive release.yml:136 already uses)
   equals `manifest.version` → return. Makes repeat `rbox upgrade` a true no-op:
   no kill, no relaunch.
7. **Download + verify**: reuse `downloadToTemp()` from `upgrade-cmd.ts` (extract
   it to a shared helper, do not clone it — it already has the O_EXCL temp,
   streaming sha, and no-progress watchdog) against
   `${remoteUrl}/bin/${art.path}`; sha mismatch → throw before anything is touched.
8. **Extract**: `ditto -x -k <zip> <tmpdir>` (Apple's own archiver, the exact
   inverse of `release.yml:128`; preserves the ad-hoc signature and extended
   attributes where `unzip` does not).
9. **Quit if running**: `pgrep -x RboxBar` → `pkill -x RboxBar`, then poll up to
   ~5s for exit. **`pkill`, not `osascript -e 'quit app id …'`** — AppleScript
   would trigger a TCC Automation consent prompt the first time, i.e. a modal the
   user must answer during an upgrade; and the app is a stateless status reader
   (§2), so SIGTERM costs nothing. Record `wasRunning`.
10. **Swap**: `mv dest dest.old` → `mv tmp/RboxBar.app dest` → `rm -rf dest.old`.
    (`rename(2)` cannot replace a non-empty directory, so there is no atomic bundle
    swap; the app is already quit, and a leftover `RboxBar.app.old` from a crashed
    run is removed on the next pass.)
11. `xattr -dr com.apple.quarantine <dest>` — cheap, belt-and-braces, and it heals
    a bundle a user previously drag-installed from a browser download (the dance
    documented at `macos/RboxBar/README.md:52-66`).
12. **Launch iff this was a first install, relaunch iff `wasRunning`**: `open -a <dest>`.
    (Amended from the draft's "relaunch iff `wasRunning`": ruling 1 says the first
    `rbox upgrade` *starts* the app, and default-on is only real if the icon
    actually appears without a second command. An update still never resurrects a
    bundle the user had deliberately quit.) Not launchctl, not a
    LaunchAgent plist: `open` is the LaunchServices front door, needs no new plist
    to own, no new file to garbage-collect, and no login-item semantics we would
    then have to keep in sync. If `open` fails (no Aqua session — e.g. an `ssh`
    upgrade on the Mac), log one line and continue.
13. Every failure from step 5 onward is **caught and logged, never rethrown**. The
    binary upgrade and daemon restarts are load-bearing; a menu-bar icon is not.
    `rbox upgrade` must not exit non-zero because `~/Applications` was read-only.

### 4.4 Default-on + kill switch

Ships ON (founder default-on rule): no flag to type, first `rbox upgrade` after
the tag installs it. Kill switch is the env var `RBOX_NO_MENUBAR_APP=1` rather than
a CLI flag — no new CLI surface, no help-text growth, no persisted setting.
Deletion condition: remove the env var once two consecutive releases install the
app with no field failures.

Counter-argument to state to the founder: on Linux this is invisible, but on a Mac
a menu-bar icon *appears without being asked for* on the next upgrade. See Q1.

### 4.5 Failure modes

| Mode | Behavior |
|---|---|
| Non-darwin | Silent no-op (step 1). |
| Manifest has no `RboxBar.zip` (any release ≤ current, or a pre-245 `next` build) | Silent no-op (step 3). |
| Zip 404 / network stall | Watchdog aborts, warning line, exit 0. |
| sha ≠ signed manifest | Refuse, warning line, nothing on disk touched, exit 0. |
| Dest not writable (`/Applications` without admin) | Warning naming the real reason + `sudo` remedy, exit 0. |
| App running, popover open | `pkill` closes it; relaunched immediately. User sees a blink. |
| App running under a *different* user's session | `pkill -x` only reaches our own uid's process; other sessions keep an old bundle running until they quit it. Acceptable; note it. |
| Translocation | Cannot occur: bundle is not quarantined (§4), and step 11 removes any inherited xattr. |
| `open` fails (headless ssh session) | One log line: "RboxBar updated — it starts at next login, or run `open -a RboxBar`". |
| Crash mid-swap | `RboxBar.app.old` left behind; next run's `rm -rf dest.old` cleans it. App is absent in the window — user reruns `rbox upgrade`. |
| Elevated (`sudo rbox upgrade`) | Skipped entirely, same fence as daemons (`upgrade-cmd.ts:521-525`) — never install a root-owned bundle into `~root/Applications`. |
| Login item configured by the user | Not managed. Path stays stable (`~/Applications/RboxBar.app`), so the LaunchServices registration survives an in-place swap. Out of scope. |

## 5. Acceptance checks

Unit / hermetic (Linux CI, no Mac needed):
1. `syncMenuBarApp` on `platform !== darwin` performs zero fs/spawn calls.
2. `RBOX_NO_MENUBAR_APP=1` → zero fs/spawn calls.
3. Manifest without `RboxBar.zip` → no download attempted.
4. `art.path` not `v<ver>/RboxBar-<ver>.zip` → refuses before download.
5. sha mismatch → throws internally, `upgradeCmd` still resolves and exit code is 0.
6. `rbox upgrade --check` never reaches `syncMenuBarApp` (dep-injection assertion).
7. `scripts/release.ts --app=<file>` produces a manifest whose only new key is
   `RboxBar.zip` with the bound path; `verifyReleaseArtifacts` fails when the file
   is absent or its sha is wrong.
8. `nextChannelStore` accepts `releases/v<ver>/RboxBar-<ver>.zip` and **skips**
   `releases/RboxBar.zip` (prerelease must not move the stable alias).
9. Worker: `GET /bin/v2.0.0/RboxBar-2.0.0.zip` → 200 `application/zip`,
   `immutable`; `GET /bin/RboxBar.zip` → 200, `max-age=300`;
   `GET /bin/v2.0.0/../etc` and `GET /bin/Evil.zip` → 404.

Real Mac (`dfinitiv-macbook-pro`, dev build against the dev API — design-169-style
dev-build-first):
10. **Fresh install**: no `RboxBar.app` anywhere → `rbox upgrade` →
    `~/Applications/RboxBar.app` exists, `plutil -extract
    CFBundleShortVersionString raw` == release version, **and the menu-bar icon is
    on screen without any further command** (ruling 1's "starts").
11. **Quarantine negative control (proves §4 rather than asserting it)**:
    `xattr -p com.apple.quarantine ~/Applications/RboxBar.app` → "No such xattr";
    then download the *same* zip in Safari and `xattr -l` it → quarantine present.
    Both results recorded in the design's data note.
12. `codesign --verify --deep --strict ~/Applications/RboxBar.app` passes (ad-hoc
    signature survived `ditto -c -k` → `ditto -x -k`).
13. **No Gatekeeper dialog**: first launch shows the menu-bar icon directly; the
    dropdown lists the workspaces from `~/.rbox/daemons/*`; `Pause` shells out to
    `rbox` successfully (proves `RBOX_BIN` discovery still resolves post-move).
14. **Running-app update**: launch app, note pid, `rbox upgrade` to a newer dev
    version → new pid, new `CFBundleShortVersionString`, icon back within ~2s.
15. **Idempotence**: immediate second `rbox upgrade` → no `pkill`, no relaunch,
    pid unchanged, no output about the app.
16. **Non-running update**: quit the app, `rbox upgrade` → bundle updated, app NOT
    launched.
17. **`/Applications` precedence**: place a copy at `/Applications/RboxBar.app`
    (writable) → upgrade updates that one and creates nothing in `~/Applications`.
18. **Read-only dest**: `chmod a-w` the parent → one warning line, `rbox upgrade`
    exit code 0, daemons still restarted.
19. Linux fleet host: `rbox upgrade` output is byte-identical to today's.

## 6. install.sh + site copy

**`scripts/install.sh`** — one darwin-only line in the summary block
(`install.sh:88-92`), no new download logic (the CLI is the single owner of the
bundle, and routing users through `rbox upgrade` is what keeps them off the
quarantined browser-download path):

```sh
[ "$OS" = "darwin" ] && echo "  Menu-bar app: run \`rbox upgrade\` to install rbox Bar (macOS status icon)"
```

Deliberately *not* done: having install.sh fetch and unpack the zip itself. Its
sha-grep contract (`install.sh:50-62`) would work unchanged for the new key, but it
would duplicate the install/quit/relaunch logic in POSIX sh, and
`docs/DEPLOYMENTS.md` documents install.sh as "intentionally a binary swap only".
See Q2.

**Site** (`rbox-home-page` repo, separate PR): one line under the install command
at `src/pages/index.astro:6` and `src/pages/docs.astro:23`, phrased to send people
through the CLI rather than a browser download:

> **macOS menu-bar app** — `rbox upgrade` installs *rbox Bar*, a status icon for
> your synced folders. (Installing through the CLI skips macOS's
> unidentified-developer prompt.)

A raw `https://api.rbox.to/bin/RboxBar.zip` link should exist as a fallback for
"I want the app without the CLI", but should not be the headline: a browser
download *is* quarantined and, on macOS 15+, needs the System Settings →
Privacy & Security → "Open Anyway" trip. See Q3.

---

## Open product questions (founder) — ANSWERED 2026-08-20

1. **Default-on, really?** → **YES, default ON**, kill switch `RBOX_NO_MENUBAR_APP=1`.
   No first-run prompt (minimize-typing rule + default-on rule).
2. **Should `install.sh` install the app too?** → **NO.** One printed darwin-only
   line only; `install.sh` remains a binary swap (`docs/DEPLOYMENTS.md` contract).
3. **Browser download link on rbox.to?** → **NOT YET.** The worker must serve the
   zip because the CLI fetches it, but no site copy and no advertised link until
   Developer ID signing lands with 179A. §6's site paragraph is therefore
   **deferred**, not implemented.

---

## 7. Implementation contract (what actually ships in this PR)

### 7.1 `scripts/release.ts`

- New optional flag `--app=<path-to-zip>`. When present, the zip is copied into
  `dist/RboxBar.zip` and one artifact entry is added **after** the three binaries:
  `artifacts["RboxBar.zip"] = { sha256, path: \`${tag}/RboxBar-${version}.zip\` }`.
  Absent (`--dev`, local target-subset builds) → manifest is byte-shaped exactly
  as today.
- The key is appended last so `install.sh`'s compact-JSON sha grep
  (`"rbox-<os>-<arch>":{"sha256":…`) is untouched.
- `nextChannelStore` widens its two regexes so a prerelease publishes the
  immutable `releases/v<ver>/RboxBar-<ver>.zip` and still **skips** the stable
  alias `releases/RboxBar.zip` (design 245's contract).

### 7.2 `.github/workflows/release.yml`

- `build` gains `needs: rboxbar`, downloads `rboxbar-dist`, and passes
  `--app=rboxbar-dist/RboxBar-$VERSION.zip` to `bun scripts/release.ts`.
  `dist/` (uploaded as `rbox-dist`) therefore carries the zip into `publish`.
- The two bespoke `wrangler r2 object put` steps in `publish` and its
  `rboxbar-dist` download are **deleted** — `--upload-only` now publishes both
  objects through `publishReleaseObjects`, under the release signature and the
  fetch-back sha verification.

### 7.3 `apps/api/src/routes/release.ts`

`cachedReleaseResponse` accepts one additional, version-bound name shape:

| request | allowed name | headers |
|---|---|---|
| `/bin/<name>` | `rbox-<os>-<arch>` | octet-stream, `filename="rbox"`, `max-age=300` |
| `/bin/<name>` | `RboxBar.zip` | `application/zip`, `filename="RboxBar.zip"`, `max-age=300` |
| `/bin/v<ver>/<name>` | `rbox-<os>-<arch>` | octet-stream, `filename="rbox"`, immutable |
| `/bin/v<ver>/<name>` | `RboxBar-<ver>.zip` (**must equal the path's own version**) | `application/zip`, `filename="RboxBar.zip"`, immutable |

Existing binary requests are byte-identical to today. `worker.ts`'s
`routeTemplate` masks the app names to `:app` so the metrics dimension keeps its
allowlist privacy contract.

### 7.4 CLI

`downloadToTemp` moves out of `upgrade-cmd.ts` into `src/cli/release-download.ts`
(one owner for "stream a release URL to an O_EXCL temp, hashing inline"), imported
by both `upgrade-cmd.ts` and the new `src/cli/menubar-app.ts`. No behavior change.

`src/cli/menubar-app.ts` exports exactly one Interface:

```ts
export interface MenuBarDeps {
  platform?: string;                 // default process.platform
  env?: NodeJS.ProcessEnv;           // default process.env
  homeDir?: string;                  // default os.homedir()
  run?: (cmd: string[]) => Promise<{ code: number; stdout: string }>;
  download?: (url: string, dir: string) => Promise<{ tmp: string; sha256: string }>;
  log?: (line: string) => void;
}
export async function syncMenuBarApp(
  manifest: Manifest, remoteUrl: string, deps?: MenuBarDeps,
): Promise<void>;                    // NEVER throws
```

Only six effects are injected — the external commands (`plutil`, `pgrep`,
`pkill`, `ditto`, `xattr`, `open`) all go through `run`, and the download goes
through `download`. Everything else is plain `node:fs` against `homeDir`, which
makes the whole orchestration executable on Linux CI with a fake `run`.

Call sites (both already inside `withUpgradeLock`, both fenced by
`!ctx.elevated`, in a `finally` so a daemon-restart failure still updates the
app, never the reverse):

- upgraded path — after `restartDaemonsAfterUpgrade()`;
- already-current path — inside `noUpgrade()`, after `restartStaleDaemonsIfAny()`.

Never from either `--check` branch.

### 7.5 `scripts/install.sh`

One darwin-only line in the post-install summary block. No download logic.
