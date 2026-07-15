#!/usr/bin/env bash
set -euo pipefail

python3 <<'PY'
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

STALE_SECONDS = 15
APP_URL = os.environ.get("RBOX_APP", "https://app.rbox.to").rstrip("/")
RBOX_BIN = os.environ.get("RBOX_BIN", "rbox")


def esc(s):
    return str(s).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ").replace("|", "\\|")


def item(label, **params):
    bits = [esc(label)]
    if params:
        bits.append("|")
        for k, v in params.items():
            if isinstance(v, bool):
                bits.append(f"{k}={'true' if v else 'false'}")
            else:
                bits.append(f'{k}="{esc(v)}"')
    print(" ".join(bits))


def workspace_key(root):
    # Keep parity with src/cli/rbox-paths.ts and src/cli/daemon-control.ts:
    # workspaceKey = path.resolve(root) + "/" + hash8 of full root, plus a
    # sanitized basename using /[^A-Za-z0-9._-]/g behavior.
    resolved = os.path.abspath(root)
    h = hashlib.sha256(resolved.encode()).hexdigest()[:8]
    base = os.path.basename(resolved) or "root"
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", base)
    return f"{safe}-{h}"


def present(path):
    try:
        path.stat()
        return True
    except FileNotFoundError:
        return False
    except OSError:
        return True


def read_json(path):
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return "absent"
    except Exception:
        return "corrupt"


def valid_status(j):
    if not isinstance(j, dict) or j.get("schemaVersion") != 1:
        return False
    if j.get("state") not in ("synced", "syncing", "attention", "paused"):
        return False
    if not isinstance(j.get("heartbeatAt"), str):
        return False
    if not (j.get("sequence") is None or isinstance(j.get("sequence"), int)):
        return False
    if not (j.get("lastSyncedAt") is None or isinstance(j.get("lastSyncedAt"), str)):
        return False
    return True


def parse_iso_seconds(s):
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        from datetime import datetime

        return datetime.fromisoformat(s).timestamp()
    except Exception:
        return 0


def reason(j):
    raw = j.get("attentionReason")
    return {
        "halt": "halt",
        "out-of-storage": "quota",
        "watcher-degraded": "watcher",
        "ownership-lost": "owner",
        "unknown-error": "error",
    }.get(raw, "error")


def verdict(root, runtime):
    status_path = runtime / "daemon.status.json"
    pid_present = present(runtime / "daemon.pid")
    raw = read_json(status_path)
    if raw == "absent":
        return {"state": "attention", "reason": "dead", "inferred": True} if pid_present else {"state": "paused", "inferred": True}
    if raw == "corrupt" or not valid_status(raw):
        return {"state": "attention", "reason": "dead", "inferred": True}

    age = time.time() - parse_iso_seconds(raw["heartbeatAt"])
    stale = age > STALE_SECONDS
    if not stale:
        raw["inferred"] = False
        raw["age"] = age
        return raw
    if pid_present:
        return {"state": "attention", "reason": "dead", "inferred": True, "age": age, "sequence": raw.get("sequence"), "lastSyncedAt": raw.get("lastSyncedAt")}
    if raw.get("state") == "paused":
        raw["inferred"] = True
        raw["age"] = age
        return raw
    return {"state": "attention", "reason": "dead", "inferred": True, "age": age, "sequence": raw.get("sequence"), "lastSyncedAt": raw.get("lastSyncedAt")}


def title(v):
    state = v.get("state")
    if state == "synced":
        return "✓"
    if state == "paused":
        return "○"
    if state == "attention":
        return "!"
    op = v.get("operation") or {}
    arrow = "↓" if op.get("kind") == "pull" else "↑"
    done = op.get("filesDone")
    total = op.get("filesTotal")
    if isinstance(done, (int, float)) and isinstance(total, (int, float)) and total > 0:
        return f"{arrow}{max(0, int(total - done))}"
    return arrow


def state_label(v):
    state = v.get("state")
    if state == "synced":
        return "Synced"
    if state == "paused":
        return "Paused"
    if state == "attention":
        r = v.get("reason") or reason(v)
        return f"Attention: {r}"
    op = v.get("operation") or {}
    return "Pulling" if op.get("kind") == "pull" else "Pushing"


def rel_time(iso):
    if not iso:
        return "never"
    age = max(0, int(time.time() - parse_iso_seconds(iso)))
    if age < 60:
        return "just now"
    if age < 3600:
        return f"{age // 60} min ago"
    if age < 86400:
        return f"{age // 3600} hr ago"
    return f"{age // 86400} d ago"


def middle(s, limit=42):
    if not s or len(s) <= limit:
        return s or "—"
    left = max(8, limit // 2 - 1)
    right = limit - left - 1
    return s[:left] + "…" + s[-right:]


def progress_text(op):
    done = op.get("filesDone")
    total = op.get("filesTotal")
    if isinstance(done, (int, float)) and isinstance(total, (int, float)) and total > 0:
        pct = max(0, min(100, int(done / total * 100)))
        return f"{int(done):,} / {int(total):,} — {pct}%"
    return "Working…"


def progress_bar(op):
    done = op.get("filesDone")
    total = op.get("filesTotal")
    if not (isinstance(done, (int, float)) and isinstance(total, (int, float)) and total > 0):
        return "▰▱▱▱▱▱▱▱"
    fill = max(0, min(8, round(done / total * 8)))
    return "▰" * fill + "▱" * (8 - fill)


def workspace_name(root, key):
    try:
        with (root / ".rbox" / "workspace.json").open("r", encoding="utf-8") as f:
            cfg = json.load(f)
        name = cfg.get("name")
        if isinstance(name, str) and name:
            return name
        rid = cfg.get("remoteWorkspaceId")
        if isinstance(rid, str) and rid:
            return rid[:12]
        return key
    except Exception:
        return key


def version():
    if os.environ.get("RBOX_VERSION"):
        return os.environ["RBOX_VERSION"]
    try:
        res = subprocess.run([RBOX_BIN, "--version"], capture_output=True, text=True, timeout=0.4)
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip()
    except Exception:
        pass
    return "unknown"


root_env = os.environ.get("RBOX_ROOT")
if not root_env:
    print("○")
    print("---")
    item("Set RBOX_ROOT to a workspace root")
    sys.exit(0)

root = Path(root_env).resolve()
if not (root / ".rbox" / "workspace.json").exists():
    print("○")
    print("---")
    item("RBOX_ROOT is not an rbox workspace")
    item(str(root))
    sys.exit(0)

key = workspace_key(root)
runtime = Path(os.environ.get("RBOX_HOME", str(Path.home() / ".rbox"))) / "daemons" / key
v = verdict(root, runtime)
name = workspace_name(root, key)


def log_lines():
    try:
        res = subprocess.run(
            [RBOX_BIN, "logs", str(root), "--limit", "8"],
            capture_output=True,
            text=True,
            timeout=1.5,
        )
        if res.returncode == 0:
            return res.stdout.splitlines()[-8:]
        return ["logs unavailable"]
    except Exception:
        return ["logs unavailable"]

print(title(v))
print("---")
item(name)
item(state_label(v))

seq = v.get("sequence")
last = v.get("lastSyncedAt")
seq_text = f"seq {seq}" if isinstance(seq, int) and seq > 0 else "seq —"
item(f"Last synced {rel_time(last)} · {seq_text}")

if v.get("state") == "syncing":
    op = v.get("operation") or {}
    item("---")
    item(f"Status: {op.get('phase') or state_label(v).lower()}")
    item(f"File: {middle(op.get('currentPath'))}")
    item(f"Progress: {progress_text(op)}")
    item(progress_bar(op))
elif v.get("state") == "attention":
    item("---")
    age = int(v.get("age") or 0)
    r = v.get("reason") or reason(v)
    item(f"Background sync needs attention ({r})")
    if age:
        item(f"Last heartbeat {age} s ago")

item("---")
if v.get("state") == "paused":
    item("Resume Background Sync", bash=RBOX_BIN, param1="start", param2=str(root), terminal=False, refresh=True)
else:
    item("Pause Syncing", bash=RBOX_BIN, param1="stop", param2=str(root), terminal=False, refresh=True)
item("Open Dashboard", href=f"{APP_URL}/dashboard")
item("Open Daemon Logs", bash=RBOX_BIN, param1="logs", param2=str(root), param3="--follow", terminal=True)

item("---")
item("Daemon Log")
lines = log_lines()
if lines:
    for line in lines:
        item(f"--{line[:100]}")
else:
    item("--no log yet")

item("---")
item(f"rbox {version()}")
item(socket.gethostname().split(".")[0])
PY
