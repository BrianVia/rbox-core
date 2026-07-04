# Changelog

All notable changes to rbox are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions map to the
`v*` git tags that trigger the CLI release build.

## [Unreleased]

Merged work from designs 60-65:

### Added
- **Self-serve genesis (design 60).** Cold accounts created via web signup or
  device-code `rbox login` mint their first encryption keys with
  `rbox key genesis`; `rbox setup` runs it inline on the first machine.
- **Daemon autostart (design 61).** `rbox autostart enable|disable|status`
  registers a per-user login agent that restarts background sync after reboot or
  re-login.
- **`rbox usage` + quota UX (design 62).** A dedicated command for plan limits vs
  current usage; typed `402 quota_exceeded` errors name the cap and next step.
- **Data export (design 65).** `rbox export` decrypts every workspace under your
  keys and writes a directory or `.tar.gz`.

### Changed
- **Team checkout disabled (design 63).** Team is listed but not purchasable
  across the CLI, web, and pricing surfaces;
  the server rejects Team checkout intent before any Stripe call.

### Security
- **Abuse hardening (design 64).** Rate limits on the anonymous edge
  (device-code start/poll, release, link/pair) plus a per-account durable-device
  cap.

## [0.7.1] — status probe elision
- `rbox status` elides the remote-head probe when the local daemon is live and
  attributable to the current workspace (design 59); JSON status fetches account
  usage separately.

## [0.7.0] — doctor, diagnostics, recovery kit
- `rbox doctor` + opt-in plaintext support-report upload (design 56).
- Recovery kit: `--kit` / `--kit-path` write the 24-word phrase to a `0600` file,
  tracked by `rbox key status` (design 58).
- Setup picker UX polish; dev-gated bootstrap `--plan`.

## [0.6.8] — destructive-apply safety
- Local trash tier (`rbox trash list|restore|empty`), type-flip healing, and a
  push-side mass-delete guard (design 50).

## [0.6.7] — rbox.yml revival + usage guide
- Scoped `rbox.yml` design revival and the narrative usage guide; the `deps` CLI
  group disabled/commented out (design 51).

## [0.6.6] — daemon IO priority
- Daemon disk-IO priority + idle safety-scan backoff (design 49).

## [0.6.5] — browser-optional login
- Browser-optional device-code login (design 47).

## [0.6.4] — zsh integration
- zsh shell integration: ambient sync status in the prompt + completions
  (design 46).

## [0.6.3] — status health
- Status health verdict, daemon activity sidecar, and live transfer percentages
  (design 45).

## [0.6.2] — rebind safety
- Rebind safety: stream-ownership stamp + mass-delete guard, closing the
  design-44 mass-delete incident.

## [0.6.1] — maintainability pass
- Behavior-preserving module splits across the engine, CLI, and API (antislop
  refactor pass).

## [0.6.0] — nested-repo git sync
- Nested-repo git sync: per-repo GitSections, worktree materialization, all E2EE
  (design 43).
