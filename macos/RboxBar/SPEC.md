# RboxBar — native macOS menu bar app (design 88)

Build a SwiftUI `MenuBarExtra` app that replaces the SwiftBar shell plugin
(`contrib/swiftbar/rbox.5s.sh`). It reads the daemon's atomic JSON status files
(no daemon round-trip, file reads only) and renders the design-88 dropdown.
macOS 14+, arm64. Everything must build from the CLI via `swift build` and a
bundling script — DO NOT create an .xcodeproj.

The icon assets already exist and are DONE — do not regenerate or touch:
`Resources/AppIcon.icns` and `Resources/Assets.xcassets/RGlyph.imageset` (a
template-rendered vector PDF glyph loaded as `NSImage(named:"RGlyph", bundle:.module)`).

## File layout (create these under `macos/RboxBar/`)
```
Package.swift
Sources/RboxBar/
  RboxBarApp.swift        // @main App + MenuBarExtra(.window) + AppModel wiring
  Models.swift            // WorkspaceStatus, DaemonState, severity/reason enums, Operation, TransferPhase
  StatusReader.swift      // discovery + verdict logic (mirror the TS/py reference EXACTLY)
  AppModel.swift          // ObservableObject: holds [WorkspaceStatus], selection, poll Timer
  MenuBarLabel.swift      // the menu-bar icon view (RGlyph template + state badge)
  MenuContentView.swift   // the dropdown panel matching 88-menubar-mockup.html
  RboxActions.swift       // shell out: start/stop, open dashboard/log, resolve `rbox` binary, version
scripts/bundle.sh         // swift build -c release -> RboxBar.app (Info.plist LSUIElement, icns)
README.md
```

## Package.swift
- swift-tools-version:5.9 (works under Swift 6.3 toolchain).
- One executable target `RboxBar`, platforms `.macOS(.v14)`.
- `resources: [.process("../../Resources/Assets.xcassets"), .copy("../../Resources/AppIcon.icns")]`
  — actually place a `Resources` symlink or use path. SIMPLER: move nothing; set the
  target `path: "Sources/RboxBar"` and add `resources` referencing the assets by
  relative path from the target dir. If SwiftPM rejects `../`, instead COPY the assets
  into `Sources/RboxBar/Resources/` inside the script is NOT allowed (icons are committed
  at `macos/RboxBar/Resources`). Resolve by giving the target `resources:
  [.process("Resources")]` where you create `Sources/RboxBar/Resources` as the resource
  dir — BUT the committed assets live at `macos/RboxBar/Resources`. To keep one source of
  truth, set the executable target's `resources` to reference `Assets.xcassets` and
  `AppIcon.icns` via a target `path` of `Sources/RboxBar` and symlink
  `Sources/RboxBar/Assets.xcassets -> ../../Resources/Assets.xcassets`. If symlinks are
  fragile, the ACCEPTED approach: keep assets where they are and declare the whole
  `macos/RboxBar` as package root with the executable target path `Sources/RboxBar` and
  `resources: [.process("../../Resources/Assets.xcassets"), .process("../../Resources/AppIcon.icns")]`.
  Verify `swift build` accepts it; if not, fall back to copying assets to
  `Sources/RboxBar/` and update generate-icons.sh output path — but PREFER not moving them.
  Whatever works and builds is fine; the runtime must find `RGlyph` via `.module` and the
  bundle script must find the icns.

## Status file schema (authoritative — from src/cli/daemon/ambient-status.ts & populate-marker.ts)
Runtime dir: `${RBOX_HOME or ~}/.rbox/daemons/<workspaceKey>/`. Files:

`daemon.status.json` (AmbientDaemonStatusV1):
```
{ schemaVersion:1, state:"synced"|"syncing"|"attention"|"paused",
  heartbeatAt: ISO8601 string, sequence: int|null, lastSyncedAt: ISO8601|null,
  operation?: { kind:"pull"|"push", phase?:"scan"|"gitcap"|"encrypt"|"upload"|"download",
                filesDone?:number, filesTotal?:number, bytesDone?:int, bytesTotal?:int,
                currentPath?:string },
  attentionReason?: "halt"|"out-of-storage"|"watcher-degraded"|"ownership-lost"|"unknown-error" }
```
`populate.status.json` (PopulateStatusV1 — initial populate):
```
{ schemaVersion:1, kind:"initial-populate", workspaceId, projectId, stream, pid:int,
  startedAt: ISO, heartbeatAt: ISO, operation:{ kind:"pull", phase, filesDone, filesTotal, bytesDone?, bytesTotal? } }
```
`desired.json` (per-daemon desired state — USE THIS FOR DISCOVERY):
```
{ rootPath: string, state:"running"|"stopped", accountId, workspaceId, at: ISO }
```
Other runtime artifacts may appear in this directory, including `daemon.pid` (whose
presence matters for staleness) and daemon log files. The menu's **Open logs** affordance
opens the runtime directory; use `rbox logs` to follow the live daemon log stream.

## Discovery (StatusReader.workspaces())
1. `daemonsDir = (getenv RBOX_HOME ?? $HOME)/.rbox/daemons` — mirror rbox-paths.ts
   `daemonHome = (RBOX_HOME ?? homedir)/.rbox`. NOTE: rbox-paths uses `RBOX_HOME`
   for the .rbox home (not $HOME). Use `ProcessInfo.processInfo.environment["RBOX_HOME"] ?? NSHomeDirectory()`.
2. Enumerate subdirectories. For each dir:
   - Read `desired.json` → `rootPath` (the workspace root, needed for actions + name).
     If `desired.json` absent/invalid, still surface the workspace using `rootPath = nil`
     and derive a display name by stripping the trailing `-<8 hex>` from the dir name.
   - Display name: if `rootPath` exists, read `<rootPath>/.rbox/workspace.json` `.name`
     (string, non-empty) else use `basename(rootPath)`; else the de-hashed dir name.
   - Compute the verdict (below) from `daemon.status.json` / `populate.status.json` / `daemon.pid`.
3. Sort by name. Skip dirs that are not directories.

## Verdict rules (mirror readPromptStatus in ambient-status.ts + verdict() in rbox.5s.sh)
Constants: `STALE_MS = 15_000` (heartbeat*3). Order:
1. **Fresh populate**: if `populate.status.json` parses valid AND `now - heartbeatAt <= STALE_MS`
   AND `isProcessAlive(pid)` → state `syncing`, operation = its pull operation (kind pull,
   phase, filesDone/filesTotal/bytes). (Identity match against workspace.json is optional;
   heartbeat-fresh + pid-alive is sufficient.) Process-alive check: `kill(pid, 0)` returns 0,
   or errno == EPERM → alive; ESRCH → dead.
2. Else read `daemon.status.json`:
   - **absent** (ENOENT): pidfile present → attention/dead ; else → paused.
   - **corrupt / invalid schema** → attention/dead.
   - parse OK: `stale = now - heartbeatAt > STALE_MS`.
     - not stale → use the status as-is.
     - stale + pidfile present → attention/dead (keep sequence & lastSyncedAt from the file).
     - stale + status.state == "paused" → paused (keep fields).
     - stale otherwise → attention/dead.
   Validation of daemon.status.json mirrors `valid_status` in rbox.5s.sh (schemaVersion==1,
   state in the 4, heartbeatAt string, sequence null|int, lastSyncedAt null|string).
   `attention/dead` carries a synthetic reason `dead` and the heartbeat age (seconds).
   Map file `attentionReason` → display reason exactly like reason() in the plugin:
   halt→halt, out-of-storage→quota, watcher-degraded→watcher, ownership-lost→owner, else→error.
   A real (non-stale) `attention` state uses that mapped reason.

`WorkspaceStatus` fields: name, rootPath?, dirURL, logURL, state (enum), reason? (string),
attentionReason? (enum; the single source for ok/degraded/critical severity),
operation? (kind, phase?, filesDone?, filesTotal?, currentPath?, bytesDone?, bytesTotal?),
sequence: Int?, lastSyncedAt: Date?, heartbeatAgeSeconds: Double?, desiredState? ("running"/"stopped").

## Menu-bar label (MenuBarLabel.swift)
- Base = an 18pt open-box `RGlyph` rendered as a template so it adapts to the
  light/dark bar. The box itself is never severity-tinted.
- Severity badge = a 5pt bottom-trailing dot with a 1pt knockout gap: none for
  ok, systemOrange for degraded, and systemRed for critical. Critical workspaces
  win over degraded ones when choosing the aggregate label workspace.
- The label must render crisp; don't add text counts in the bar (badge only) to stay clean.

## Dropdown (MenuContentView.swift) — match docs/design/assets/88-menubar-mockup.html
Panel width ~296. Reproduce faithfully but theme-aware (works in light AND dark; the mockup
is dark — use materials / semantic colors so light mode looks native too). Use
`.menuBarExtraStyle(.window)`. Structure per selected workspace:
- **Header**: workspace name (13pt semibold) + spacer + a state **pill** (colored dot + label):
  synced→green "Synced", syncing→blue "Pushing"/"Pulling" (by op.kind: push→Pushing, pull→Pulling),
  degraded→orange "Degraded", critical→red "Attention", paused→gray "Paused".
- **If syncing** — an op block:
  - `Status` row: the phase (encrypting/uploading/scanning/downloading/…). Map phase→verb:
    scan→"scanning", gitcap→"reading git", encrypt→"encrypting", upload→"uploading", download→"downloading".
    If no phase, "working".
  - `File` row: `operation.currentPath` middle-truncated (head+"…"+tail, limit ~42 chars),
    monospaced, low-key blue. If absent → "—".
  - `Progress` row: `filesDone / filesTotal — NN%` with thousands separators; if total<=0 → "working…".
  - A progress bar: fraction = filesDone/filesTotal clamped 0..1 (if total<=0 show a thin
    indeterminate/empty track). Blue gradient fill like the mockup.
  Key column labels ("Status/File/Progress") are a fixed ~58pt-wide dim column.
- **If attention** — a severity banner (orange for degraded, red for critical): bold reason title then a second
  line "Last heartbeat NN s ago — changes are not being synced." (use heartbeatAgeSeconds; if
  the reason isn't "dead", phrase it from the reason, e.g. quota/watcher/owner/halt — a short
  human sentence). Red translucent background + border per mockup `.banner`.
- **Meta line** (synced & attention): "Last synced <rel> · seq <n>" and, when available and
  synced, "· <files> files" (files = the last known filesTotal if you have it; otherwise omit —
  do NOT invent a count). Relative time helper: just now / N min ago / N hr ago / N d ago.
- **Divider**, then **action items** (hover highlight like the mockup `.item`):
  - Attention → primary "Restart Background Sync" (↻) = `rbox start <root>`.
    Otherwise if paused → "Resume Background Sync" (▶) = `rbox start <root>`,
    else → "Pause Syncing" (⏸) = `rbox stop <root>`. Disable + explain if rootPath is nil.
  - "Open Dashboard" (↗) → open `https://app.rbox.to/dashboard`.
  - "View Daemon Log…" (≡) → `NSWorkspace.shared.open(logURL)`.
- **Divider**, **footer**: left = "rbox <version>" (from RboxActions.version(), cached),
  right = short hostname (`ProcessInfo.processInfo.hostName` first label, or
  `Host.current().localizedName`). Small dim text.
- **Multi-workspace**: if >1 workspace, show a compact switcher at the very top of the panel
  (a segmented Picker or a small `Menu`/`Picker` bound to AppModel.selectionID) listing each
  workspace name; render the selected workspace's panel below. Keep single-workspace clean
  (no switcher shown when count==1). Also add a bottom "Quit rbox Bar" item and a divider.
- Add a "Quit" item at the very bottom (⌘Q also via `.keyboardShortcut`).

## Actions (RboxActions.swift)
- **rbox binary resolver** (GUI apps have a minimal PATH): first `RBOX_BIN` env; else check
  `/opt/homebrew/bin/rbox`, `/usr/local/bin/rbox`, `~/.bun/bin/rbox`, `~/.local/bin/rbox`,
  `/usr/bin/rbox`; else try `which rbox` via a login shell (`/bin/zsh -lc "command -v rbox"`).
  Cache the result. If unresolved, actions that need it show an error alert / disabled state.
- **start/stop**: `Process` running `rbox start <root>` / `rbox stop <root>` with
  `currentDirectoryURL = rootPath`. Run off the main thread; on completion trigger an immediate
  AppModel refresh. These write `desired.json` so the icon flips correctly on next poll.
- **version()**: run `rbox --version` (timeout ~1s), cache; fallback "rbox". Never block UI —
  fetch once on launch, store in AppModel.
- **open dashboard / log**: NSWorkspace.

## Polling (AppModel)
- On launch + every 2.5s: rebuild `[WorkspaceStatus]` via StatusReader on a background queue,
  publish on main. Keep the selected workspace stable across refreshes (match by dirURL).
- Optional nicety (only if trivial & robust): also watch `daemonsDir` with a DispatchSource /
  FSEvents to refresh sooner; the Timer remains the source of truth. Timer alone is acceptable.

## RboxBarApp.swift
- `@main struct RboxBarApp: App`. `MenuBarExtra { MenuContentView(...) } label { MenuBarLabel(...) }`
  `.menuBarExtraStyle(.window)`. Own an `@StateObject AppModel`.
- Set activation policy so no Dock icon (LSUIElement handles it in the bundle; also fine to set
  `NSApp.setActivationPolicy(.accessory)` on launch).

## scripts/bundle.sh
- `swift build -c release` (from macos/RboxBar). Assemble `RboxBar.app`:
  ```
  RboxBar.app/Contents/{MacOS/RboxBar, Resources/AppIcon.icns, Info.plist, Resources/<bundled .bundle>}
  ```
  Copy the built executable, the `.build/release/RboxBar_RboxBar.bundle` (SwiftPM resource
  bundle) into Contents/Resources so `Bundle.module` resolves, and `Resources/AppIcon.icns`.
  Write Info.plist: CFBundleName=rbox Bar, CFBundleIdentifier=to.rbox.RboxBar,
  CFBundleExecutable=RboxBar, CFBundleIconFile=AppIcon, CFBundlePackageType=APPL,
  LSMinimumSystemVersion=14.0, LSUIElement=true, CFBundleShortVersionString=0.1.0.
  Ad-hoc codesign: `codesign --force --deep -s - RboxBar.app` (best effort; ignore failure).
  Print the .app path and a run hint. Make it re-runnable (rm -rf the app first).

## README.md
Build/run instructions: `./icon/generate-icons.sh` (only if regenerating icons),
`swift build`, `./scripts/bundle.sh`, `open ./RboxBar.app`. Document the
`xattr -dr com.apple.quarantine RboxBar.app` / ad-hoc-sign workaround for Gatekeeper.
Explain it reads the same status files as the SwiftBar plugin and needs no daemon round-trip.
Note macOS 14+ requirement and that it auto-discovers all `~/.rbox/daemons/*` workspaces.

## Acceptance
- `swift build` succeeds with zero errors.
- `./scripts/bundle.sh` produces a launchable `RboxBar.app`.
- Reader logic matches the reference (staleness=15s, absent/corrupt/paused handling, populate).
- Dropdown visually corresponds to the three mockup states; light + dark both look native.
