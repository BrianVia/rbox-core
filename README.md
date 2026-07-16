# rbox

**Dropbox for devs.** Continuous, end-to-end-encrypted, dev-aware sync of your working directories across machines. Source, configs, and uncommitted git state move; `node_modules`, build output, and secrets stay local. Files are encrypted under keys only you hold; rbox's servers store ciphertext, with no escrow.

Built on Cloudflare (Workers + D1 + R2 + Durable Objects) with a Bun/TypeScript client. rbox treats regenerable build output and secrets as local state.

## Install

```bash
curl -fsSL https://rbox.to/install.sh | sh
```

macOS (Apple Silicon) and Linux (x64/arm64). The installer downloads the prebuilt CLI to `~/.rbox/bin` and adds it to your `PATH`.

## Quickstart

```bash
rbox setup
```

`rbox setup` is the guided wizard: it signs this machine in (or creates an account), sets up encryption on the first machine, creates or joins a workspace, and offers to start background sync. Bare `rbox` (no args) opens the same menu.

Prefer flags for CI/scripting? `rbox init` is the headless form of `setup` (see [`docs/usage.md`](docs/usage.md)).

## Add a second machine

On a machine you're already set up on:

```bash
rbox pair            # prints a short-lived pairing token
```

On the new machine, paste that token:

```bash
echo <token> | rbox connect
```

That enrolls the new machine for encryption in two steps — no re-typing your recovery phrase. (The classic device-code path, `rbox login` then approve it from another device, still works too.)

Lost every machine? Re-enroll from your 24-word recovery phrase with `rbox recover`.

## Agent / CI sync (beta)

Create an expiring agent key on a trusted, already-enrolled machine:

```bash
rbox key create-ci --expires 7d
```

Put the printed `RBOX_KEY` in your CI or agent secret store, then bootstrap an
ephemeral machine without a browser:

```bash
export RBOX_KEY='...'
curl -fsSL https://rbox.to/agent.sh | sh -s -- --workspace <workspace> --pull-only
```

`RBOX_KEY` carries account decryption authority in this beta, so keep expiries
short and store it only where you would store a root-equivalent CI secret.

## What it does

- **Continuous sync.** A per-workspace daemon (`rbox start`) watches for changes, debounces, and prunes ignored trees so an `npm ci` or a giant clone never pegs your machine. `rbox status` avoids a network round-trip when the local daemon is live and attributable to the current workspace.
- **End-to-end encryption.** Full E2EE is the only mode — filenames and contents are encrypted client-side. See [`/security`](https://rbox.to/security).
- **Dev-aware ignores.** The builtin ignore layer is always enabled, filtering `node_modules`, common build caches, and secrets such as `.env` by default. Interactive wizards also respect `.gitignore` by default; a later `!` rule in `.rboxignore` can re-include a specific file (for example `!.env`), or you can opt into syncing Git-ignored files too — still end-to-end encrypted, though large ignored builds and datasets come along as well.
- **Syncs uncommitted git state safely.** Index, HEAD, stashes, and rebase state ride along via `git bundle` (never a torn copy of a live `.git`). On by default; `--git false` opts out per machine.
- **Secrets stay put.** `.env`, `*.pem`, and keys are ignored by default.
- **Version history & restore.** `rbox versions` / `rbox restore <path>@<seq>` on paid plans.
- **Local trash tier.** Destructive pulls move files to a recoverable local trash (`rbox trash list|restore|empty`) instead of deleting outright.
- **Autostart.** `rbox autostart enable` resumes background sync after a reboot or re-login.
- **Local export.** `rbox export` decrypts workspaces locally and writes a directory or `.tar.gz`.

Run `rbox help` for the full command list, or [`docs/usage.md`](docs/usage.md) for the narrative guide.

## Plans

| Plan | Price | Storage | Workspaces | Version history |
|---|---|---|---|---|
| Solo | $8/mo or $80/yr | 50 GiB | ∞ | 30 days |
| Pro | $20/mo or $200/yr | 250 GiB | ∞ | 365 days |
| Team* | not yet purchasable | 150 GiB/seat | ∞ | 90 days |

Solo and Pro include a 14-day card-upfront trial; annual billing is two months free.

\* Team is listed but not purchasable. Details and per-plan specifics: [`docs/pricing.md`](docs/pricing.md).

## Architecture

```
src/engine/   pure sync core — manifests, reconcile, apply, hashing, ignore,
              git-state capture, convergent crypto, project detection
src/cli/      client — daemon, watcher, sync (push/pull/conflict-retry),
              auth, setup wizard, remote client
apps/api/     Cloudflare Worker control plane — blobs (R2), manifests + the
              WorkspaceSync Durable Object (per-(ws,proj) commit sequencer +
              hibernating-WebSocket fanout), D1 (auth/accounts/quota), GC
apps/web/     dashboard (app.rbox.to)
```

The blob layer is content-addressed: a file's identity is `sha256(bytes)`, so dedup, integrity, and GC fall out for free. Commits are sequenced by the Durable Object with optimistic concurrency — a stale parent gets a 409 and the client pulls, re-scans, and retries.

## Deployment

Two independent pipelines — don't conflate them:

- **API (`apps/api`) → prod on merge that touches `apps/api/**`.** The control-plane Worker (`rbox-prod-api`, serving `api.rbox.to`) deploys via **Cloudflare's native GitHub integration (Workers Builds)** — *not* a GitHub Action. The build is **path-filtered** (configured in the Cloudflare Workers Builds settings, not in this repo): a merge to `main` triggers a prod build+deploy **only when it changes files under `apps/api/**`**; docs- or CLI-only merges are no-ops for prod. There is no separate deploy step and no approval gate: an `apps/api`-touching merge == prod deploy. Each such deploy **restarts the `WorkspaceSync` Durable Object**, so any DO change (or bug) is live on the next `apps/api` merge — and a restart mid-commit must be safe. That is exactly what design 91 guarantees: the head is DO-authoritative and fail-closed, so a restart can never regress it (worst case it serves `repair_required`, never a silent fork). The dev Worker (`rbox-dev-api`, its own D1/R2 and a *separate* `WorkspaceSync` namespace) builds from the same connection; keep `RBOX_API` pointed at prod for any real workspace — the two namespaces do not share a head.
- **CLI binaries → R2 on `v*` tag.** The `rbox` binaries are a separate GitHub Actions pipeline (`.github/workflows/release.yml`) triggered by pushing a `v*` tag; it signs the version manifest and publishes to the `rbox-releases` bucket, which `rbox upgrade` verifies. See [`docs/cicd-release-setup.md`](docs/cicd-release-setup.md).

## Docs

- [`docs/usage.md`](docs/usage.md) — CLI usage guide (commands, config files, `.rboxignore` semantics)
- [`docs/pricing.md`](docs/pricing.md) — plans
- [`docs/development.md`](docs/development.md) — building, testing, and benchmarking rbox (contributors)
- [`docs/diagnostics.md`](docs/diagnostics.md) — `rbox doctor` and the opt-in support-report flow
- [`docs/design/`](docs/design/) — one spec per design
- [`CHANGELOG.md`](CHANGELOG.md) — release highlights
