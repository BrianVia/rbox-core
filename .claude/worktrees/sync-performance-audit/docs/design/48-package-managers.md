# 48 — Package-manager distribution (brew, bun/npm, AUR)

Status: draft (not scheduled)
Depends on: design 14 (release pipeline), design 41 (signed artifacts)

## 1. The question

opencode installs via five different installers (curl, npm, bun, brew, paru).
Can rbox — closed source — offer `brew install rbox` and `bun install -g rbox`?

**Yes.** Closed source is not a blocker for any of these channels. Homebrew,
npm, and the AUR all happily distribute proprietary prebuilt binaries (ngrok,
1Password CLI, Bun itself ships its npm packages as bare binaries). The only
thing off the table is **homebrew-core** — the default tap requires open
source plus notability — which costs us the bare `brew install rbox` spelling
until/unless we open-source. A custom tap gets us `brew install rbox-to/tap/rbox`
(and plain `brew install rbox` after a one-time `brew tap rbox-to/tap`), which
is exactly how ngrok et al. do it.

## 2. What we already have (and what's missing)

The release pipeline (design 14) already produces everything a package manager
needs to *reference*:

- Immutable versioned binaries: `releases/v<ver>/rbox-<target>` on the
  `rbox-releases` R2 bucket, for darwin-arm64 / linux-x64 / linux-arm64.
- An Ed25519-signed `version.json` binding each artifact's sha256 to the
  version — verified in CI before anything uploads, and by `rbox upgrade`
  on clients.
- Smoke-gated publish: no target ships unless its native watcher self-test
  passed on real hardware.

Missing pieces:

1. **Tarballs.** Homebrew formulas want a versioned archive URL; we publish
   bare binaries. Add `rbox-<target>.tar.gz` per target to `release.ts`,
   included in the signed manifest like any other artifact.
2. **A public tap repo.** `rbox-to/homebrew-tap` on GitHub containing only
   `Formula/rbox.rb` — no source, just URLs + sha256s. This is the one place
   we'd have a public repo; it leaks nothing (the binaries are already
   world-downloadable).
3. **npm packages.** See §4.
4. **A `packages` CI job** after `publish` that bumps the tap formula and
   runs `npm publish` (new secrets: a fine-grained PAT scoped to the tap
   repo, and an npm automation token — both on the `release` environment).
5. **Install-ownership detection** so `rbox upgrade` and the package manager
   don't fight over the binary (§6 — the only genuinely interesting design
   problem here).

## 3. Channel: Homebrew tap

A **formula** (not a cask) — casks are macOS-only and rbox supports Linuxbrew
users too. Sketch:

```ruby
class Rbox < Formula
  desc "E2EE dev-workspace sync"
  homepage "https://rbox.to"
  version "0.6.4"
  license :cannot_represent  # proprietary

  on_macos do
    url "https://api.rbox.to/releases/v0.6.4/rbox-darwin-arm64.tar.gz"
    sha256 "<from signed manifest>"
  end
  on_linux do
    on_intel { url ".../rbox-linux-x64.tar.gz";  sha256 "..." }
    on_arm   { url ".../rbox-linux-arm64.tar.gz"; sha256 "..." }
  end

  def install
    bin.install "rbox"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/rbox --version")
  end
end
```

Intel Macs already error clearly in install.sh; the formula gets the same
behavior for free (`on_macos` + `depends_on arch: :arm64`).

The CI bump job renders this file from a template with the new version +
shas **taken from the verified signed manifest** and pushes a commit to the
tap repo. That preserves our signature chain transitively: the shas in the
formula were extracted only after `verifyReleaseArtifacts` passed, and brew
then enforces them on every user install. Brew users don't run our Ed25519
verification, but they get sha256-pinning rooted in it.

Effort: ~half a day (tarball artifact + tap repo + template + CI step).

## 4. Channel: npm / bun

`bun install -g rbox` and `npm i -g rbox` are the same channel — one set of
npm packages. Two viable patterns:

- **Platform packages via `optionalDependencies`** (esbuild / Biome / turbo /
  Bun pattern): a meta package `rbox` whose bin is a tiny JS shim, plus
  `@rbox/cli-darwin-arm64`, `@rbox/cli-linux-x64`, `@rbox/cli-linux-arm64`
  each declaring `os`/`cpu` so the installer fetches exactly one. **Choose
  this.**
- **Postinstall downloader** (playwright pattern): rejected — Bun blocks
  lifecycle scripts for untrusted dependencies by default, so the flagship
  `bun install -g rbox` spelling would install a broken stub unless users
  add `trustedDependencies`. Dead on arrival for a Bun-first audience.

Notes:

- **Size**: Bun-compiled binaries are ~60 MB each; npm accepts this (Bun's
  own platform packages are the precedent). Three packages per release.
- **Closed source on npm**: fine — `"license": "SEE LICENSE IN LICENSE"`,
  package contains only the binary + a short README.
- **Startup overhead**: the JS shim spawns the real binary (~30–50 ms of
  node/bun startup per invocation). Acceptable for a CLI whose hot path is a
  daemon; if it ever grates, the esbuild trick (shim replaces itself with a
  symlink to the binary on first run) removes it.
- **Integrity**: npm's per-tarball integrity (sha512 in the consumer's
  lockfile / registry) plays the role brew's sha256 plays. The publish step
  runs only after manifest verification, same transitivity argument as §3.
  npm *provenance* is skipped — it requires a public source repo.
- **Name check (done 2026-07-02)**: `rbox` on npm is **taken** — a Chinese
  "data manager" (v1.0.1, single maintainer, untouched since 2022-08). It
  likely qualifies for npm's [package-name dispute](https://docs.npmjs.com/policies/disputes)
  process (contact the author, cc npm support, ~4-week clock). Worth filing
  when we start this work; fallback is `@rbox/cli` with `"bin": {"rbox": ...}`
  — the installed command is still `rbox`, only the install spelling suffers
  (`bun i -g @rbox/cli`). `rbox-cli` is free but splits the brand; prefer the
  scoped name if the dispute fails.

Effort: ~a day (package scaffolding, shim, publish script, CI wiring, npm
org + token setup).

## 5. Channel: AUR (`paru`/`yay`)

`rbox-bin` PKGBUILD pointing at the versioned tarballs — the AUR is the one
mainstream channel *designed* for exactly this (closed-source `-bin`
packages). Effort is an hour, but it implies either manual bumps or another
CI push target, for a user base we have no signal on yet. **Defer until an
Arch user asks.** (Windows/scoop/winget: out of scope — no windows target.)

## 6. The real design problem: two updaters, one binary

Today `rbox upgrade` downloads the manifest, verifies the signature, and
replaces `~/.rbox/bin/rbox`. A brew- or npm-installed rbox lives in the
manager's prefix (Cellar / npm global bin) — if `rbox upgrade` runs there it
would either fail on permissions or, worse, write a second binary in
`~/.rbox/bin` that shadows/fights the managed one via PATH ordering, and
`brew upgrade` would later silently "downgrade" the shadowed copy.

Rule: **the installer that put the binary on disk owns its upgrades.**

- At build time (or first run), detect ownership from
  `process.execPath`: under a Homebrew Cellar → `brew`; under an npm/bun
  global dir (path contains `node_modules`) → `npm`; else → `curl` (ours).
- `rbox upgrade` on a manager-owned install prints the manager's own upgrade
  command and exits 0 (`--check` still works — it only reads the manifest —
  and should say when the manager's channel lags the latest release).
- The daemon's update *nag* (if/when we add one) uses the same detection to
  suggest the right command.

This is small (path sniffing + one branch in `upgrade-cmd.ts`) but must ship
**in the binary before the channels open**, or early brew users get the
shadow-binary failure mode on their first `rbox upgrade`.

## 7. Release-lag policy

curl/install.sh and `rbox upgrade` remain the canonical channel and always
have the newest version (the `latest` alias flips at publish). Brew/npm lag
by however long the `packages` CI job takes (~minutes, automated). If the
bump job fails, the release is still fully live on the canonical channel —
package channels are best-effort mirrors, and the job should alert (issue
comment / notification) rather than block.

## 8. Recommendation & order

1. **Ownership detection in `rbox upgrade`** (§6) — prerequisite, ship in a
   regular release first.
2. **Homebrew tap** (§3) — cheapest, highest credibility-per-effort for a
   dev-tools audience.
3. **npm/bun** (§4) — after the npm name check; biggest reach.
4. **AUR** (§5) — on demand.

Total: ~2 days of work across two releases, no open-sourcing required.
