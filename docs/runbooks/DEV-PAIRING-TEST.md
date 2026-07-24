# Two-machine dev test — web-approved pairing (design 189)

Goal: on two real machines, confirm the **deployed dev dashboard** approve page
drives the real key delivery — machine B receives encryption keys automatically
after you approve it in the browser.

Runs entirely against **dev** (dev API + dev Clerk + `main.rbox-app.pages.dev`).
Your real `~/.rbox` / prod daemon are never touched.

---

## Prerequisites (both machines)

- The `rbox-core` repo on **current `main`** — 189 landed *after* the v1.8.0
  release, so the `install.sh` binary does **not** have it.
- `bun` installed.

---

## Step 0 — setup (run once on EACH machine, in a dedicated terminal)

```bash
# in your rbox-core checkout (or a fresh clone), get current main:
git fetch origin && git checkout main && git pull --ff-only

# build a 189-capable native binary from this checkout:
bun scripts/dev-install.ts

# ^ installs ~/.local/bin/rbox-dev

# isolate this dev test from your real ~/.rbox (credentials key off HOME):
export RBOX="$HOME/.local/bin/rbox-dev"
export DEVHOME="$HOME/rbox-devtest"
export DEVAPI="https://rbox-dev-api.brian-via.workers.dev"
mkdir -p "$DEVHOME"
rbdev() { HOME="$DEVHOME" RBOX_APP="https://main.rbox-app.pages.dev" "$RBOX" "$@"; }
```

Everything below uses `rbdev`, which overrides `HOME` **only** for that one
command — so prod is untouched. `RBOX_APP` points the approval URL at the dev
dashboard.

---

## Step 1 — Machine A (the admin that hands out keys)

```bash
rbdev login --label machine-A --remote "$DEVAPI"
```

- It prints an approval URL on `main.rbox-app.pages.dev`.
- Open it, sign in to the dev dashboard (creates your throwaway dev account if new),
  and approve machine A. (First device — no key-consent option; just approve.)

Then:

```bash
rbdev key genesis --yes     # create the account's encryption; A becomes admin
rbdev start                 # bring A's daemon ONLINE (required to fulfill B)
rbdev status                # confirm: enrolled + daemon running
```

Optional file check (proves the delivered key decrypts real data):

```bash
mkdir -p /tmp/rbox-test-A && cd /tmp/rbox-test-A
rbdev init --new --no-interactive --remote "$DEVAPI"
# ^ note the WORKSPACE ID it prints
echo "hello from A $(date)" > hello.txt
rbdev push
```

---

## Step 2 — Machine B (the new machine)

Do this ONLY after A is enrolled and its daemon is online.

```bash
rbdev login --label machine-B --remote "$DEVAPI"
```

- It prints an approval URL (carrying B's fingerprint).
- Open it, sign in as the **SAME** dev account, and this time approve **WITH the
  "grant encryption keys" / key-consent option enabled**.
- Complete the Clerk re-verification prompt.
- Back in B's terminal, `login` is polling. Within ~10s it should print:

  **`encryption enrolled`**  ← THIS is the success signal (keys delivered via the real web approve)

```bash
rbdev status      # confirm B enrolled
```

Optional file check:

```bash
mkdir -p /tmp/rbox-test-B && cd /tmp/rbox-test-B
rbdev init --workspace <WORKSPACE_ID_FROM_A> --no-interactive --remote "$DEVAPI"
rbdev pull
cat hello.txt     # should match what A wrote
```

---

## Success criteria

Machine B prints **`encryption enrolled`** (NOT a pairing-token or 24-word-phrase
prompt). If you did the file step, `hello.txt` matches byte-for-byte.

## If it fails

- **B falls back to a pairing token / phrase prompt** → key-consent wasn't
  granted on the approve page, or A's daemon wasn't online. Re-approve with key
  consent; confirm `rbdev status` on A shows the daemon running.
- Always use `rbdev` (never the bare `rbox-dev` binary) so `HOME` stays isolated.

## Cleanup (each machine)

```bash
rbdev stop
rm -rf "$DEVHOME" /tmp/rbox-test-A /tmp/rbox-test-B
```

Real `~/.rbox` is untouched. The dev Clerk account can be left or deleted from
the dashboard.
