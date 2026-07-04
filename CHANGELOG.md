# Changelog

All notable changes to rbox are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions map to the
`v*` git tags that trigger the CLI release build.

## [Unreleased]

This week's merged work (designs 60–65) — the launch-readiness batch:

### Added
- **Self-serve genesis (design 60).** A cold account created via web signup or
  plain device-code `rbox login` can now mint its own encryption key world on the
  first machine — `rbox key genesis`, run inline by `rbox setup`. No longer a
  chicken-and-egg where enrollment required an already-enrolled machine.
- **Daemon autostart (design 61).** `rbox autostart enable|disable|status`
  registers a per-user login agent so background sync survives a reboot or
  re-login instead of silently dropping.
- **`rbox usage` + quota UX (design 62).** A dedicated command for plan limits vs
  current usage, and the typed `402 quota_exceeded` is now rendered as an
  actionable upgrade moment rather than a raw error string.
- **Data export (design 65).** `rbox export` decrypts every workspace under your
  own keys and writes it back out to a directory or `.tar.gz` — client-side
  takeout for an E2EE product.

### Changed
- **Team plan gated as "coming soon" (design 63).** Team is presented
  consistently as not-yet-purchasable across the CLI, web, and pricing surfaces;
  the server rejects Team checkout intent before any Stripe call.

### Security
- **Abuse hardening (design 64).** Rate limits on the anonymous edge
  (device-code start/poll, release, link/pair) plus a per-account durable-device
  cap.

## [0.7.1] — zero-network status
- Zero-network `rbox status` via daemon attribution (design 59) — status reads
  local daemon state on the happy path instead of round-tripping the server.

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
