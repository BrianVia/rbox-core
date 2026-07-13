# rbox SwiftBar Plugin

`rbox.5s.sh` is a SwiftBar/xbar plugin for one rbox workspace.

1. Copy or symlink `rbox.5s.sh` into your SwiftBar plugin directory.
2. Set `RBOX_ROOT` to the absolute workspace root for that plugin instance.
3. Optional: set `RBOX_BIN` if `rbox` is not on SwiftBar's `PATH`.

The plugin reads `~/.rbox/daemons/<workspace-key>/daemon.status.json` and
`daemon.pid` every 5 seconds. It does not contact the daemon and does not require
`jq`; Python 3 is used for JSON parsing and staleness math.
