# 121 — RboxBar: one-time update notification + one-click update

Status: draft (founder-requested 2026-07-15). Small, additive, macOS-only.

## Problem

RboxBar (macos/RboxBar) already polls the release endpoint
(`UpdateCheck.latestVersion()`, periodic timer in AppModel) and computes
`availableUpdate(for:)` — but the information is passive. A user who never
opens the menu never learns a new version exists, and the best action offered
is "copy the install command" (`copyInstallCommand`). With a real customer on
manual upgrades, the ask: notify ONCE per new version, and make updating one
click.

## Design

### 1. One-time notification per version

- When the periodic check observes `latestVersion` newer than the running
  version (reuse `UpdateCheck.newerVersion`, comparing against the CLI/daemon
  version the model already tracks), and `latestVersion !=
  UserDefaults["rbox.lastNotifiedUpdateVersion"]`:
  post a UNUserNotificationCenter notification —
  title "rbox <version> is available", body "Click to update — syncing pauses
  briefly and resumes." — then set `lastNotifiedUpdateVersion = latestVersion`
  (persisted: once per version across app restarts, never repeats for the
  same version).
- Request notification authorization lazily on FIRST availability (never at
  app launch); if denied, skip notifications silently — the menu affordance
  below still exists. Never re-prompt.
- Notification click action = the update action below.
- The decision logic ("should notify?") lives in a pure, testable type
  (version pair + last-notified + authorization state → decision), unit
  tested in macos/RboxBar/Tests.

### 2. One-click update

- Menu gains an "Update to <version>" item (visible only when an update is
  available) — replaces/augments the copy-install-command affordance in that
  state.
- Action: run the installed CLI's managed upgrade (`rbox upgrade`) via
  RboxActions' existing binary-resolution + queue (RBOX_BIN / standard
  locations), then `refresh()`. Design 118 (in flight) makes `rbox upgrade`
  stop-and-wait + restart all daemons, so this composes into a safe one-click.
  On failure: surface through the existing `errorMessage` path.
- While the upgrade runs, show the existing action-in-progress affordance;
  never fire two concurrently (reuse the actions queue semantics).

### 3. Non-goals

- No auto-update. No CLI/server changes (the endpoint and semver logic exist).
- No notification for prerelease/dev versions (`SemanticVersion` already
  handles prerelease ordering; notify only when the running version is a
  release version and latest is strictly newer).

## Acceptance

- Swift unit tests (macos/RboxBar/Tests): notify-decision matrix (newer/equal/
  older, already-notified same version, prerelease running version, auth
  denied), UserDefaults persistence key behavior.
- `swift build` + `swift test` green — NOTE: must run on the Mac
  (dfinitiv-macbook-pro), not this Linux host; the coordinating session
  validates there over ssh.
- No changes outside macos/RboxBar/.
