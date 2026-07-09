# rbox Bar

Native macOS 14+ SwiftUI `MenuBarExtra` app for rbox background-sync status —
the native replacement for the SwiftBar shell plugin (`contrib/swiftbar/`).
It implements the design-88 ambient-status UI (`docs/design/88-ambient-sync-status.md`,
mockup at `docs/design/assets/88-menubar-mockup.html`).

The app reads the same atomic daemon status files as the SwiftBar plugin from
`~/.rbox/daemons/*` or `$RBOX_HOME/.rbox/daemons/*`. It does not make daemon
round-trips for status; the menu is rebuilt from local JSON files every ~2.5s.

## What it shows

- **Menu-bar icon**: an open-box template glyph, automatically tinted for the
  bar, with no badge when healthy, an amber dot when degraded, and a red dot
  only for critical attention. The box itself never changes color.
- **Dropdown** (matches the mockup, light + dark):
  - Header: workspace name + a colored state pill.
  - Syncing: a Status / File (middle-truncated, monospaced) / Progress block
    with a blue progress bar.
  - Attention: an amber degraded banner or red critical banner + status detail.
  - Last-synced + sequence meta, then Pause/Resume/Restart · Open Dashboard ·
    View Daemon Log, and a version/hostname footer.
- Multi-workspace: a segmented switcher appears when more than one workspace
  daemon is discovered.

## Test

```sh
swift test
```

`StatusReaderTests` locks the verdict matrix and severity mapping against the
reference reader. `DropdownSnapshotTests` renders ok, degraded, and critical
tiers to `/tmp/rboxbar-snapshots/*.png` for visual review.

## Build

```sh
swift build
```

Icon assets are already committed. Only regenerate them when intentionally
changing the icon:

```sh
./icon/generate-icons.sh
```

## Bundle And Run

```sh
./scripts/bundle.sh
open ./RboxBar.app
```

If Gatekeeper blocks a local build, remove quarantine metadata and run the
bundle script again so the app is ad-hoc signed:

```sh
xattr -dr com.apple.quarantine RboxBar.app
./scripts/bundle.sh
```

The app auto-discovers all workspace daemon directories under
`~/.rbox/daemons/*`. Actions such as pause, resume, and restart shell out to the
`rbox` binary. GUI apps have a minimal `PATH`, so set `RBOX_BIN` if `rbox` is not
installed in a standard location.
