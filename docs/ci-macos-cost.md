# macOS CI cost — the problem and the sourcing options

Written 2026-08-20 while moving the Linux test shards to Cloudflare runners
(#797). Linux is handled; **macOS minutes are now the dominant remaining CI
cost**, and nothing like the Cloudflare option exists for macOS (no
virtualized Apple-silicon containers from CF). This doc is the shopping brief
for fixing that: either a self-hosted Apple-silicon box or a cheaper
pay-per-use macOS runner service.

## The numbers (GitHub billing API, exact)

| Month | macOS minutes | Paid | Notes |
|---|---:|---:|---|
| July 2026 | 1,412 | $85.12 | full month |
| August 2026 (through the 20th) | 1,150 | $64.85 | run-rate ≈ $97/mo |

- SKU: "Actions macOS 3-core" at $0.062/min paid (list $0.08/min for larger).
- Essentially all rbox-core (August: 1,150 of 1,158 total mac minutes).
- For comparison, Linux was 12,421 min/$67.60 in the same August window —
  macOS costs ~10× per minute, so ~1/10 the minutes produce a similar bill.

## What actually runs on macOS (all `macos-14`, GitHub-hosted M-series)

| Job | Workflow | Why it's macOS |
|---|---|---|
| `RboxBar · swift build + test (release toolchain)` | ci.yml | Swift/Xcode; pins the release-toolchain floor. Path-gated (`run_rboxbar`), so it skips on most PRs |
| `compiled TUI · darwin-arm64` | ci.yml | cross-build + smoke on real darwin |
| `compiled TUI · startup/size budget` | ci.yml | perf budget measured on darwin |
| release build job | release.yml | builds/signs darwin binaries per `v*` tag; receives the step-scoped signing key |
| e2e | e2e.yml | already `[self-hosted, macOS, ARM64]` — costs $0 |

## Hard constraints (settled 2026-08-20)

- **Must be Apple silicon.** An Intel Mac can cross-*compile* arm64 but cannot
  *execute* arm64 binaries (Rosetta only translates x86→arm). Tests on Intel
  run as x86_64 — an architecture no fleet machine uses — and old Intel
  hardware caps the macOS/Xcode version, defeating the RboxBar toolchain-floor
  lane. Intel is a non-option.
- **Fleet is macOS + Linux, all Apple-silicon Macs** — darwin-arm64 test
  fidelity is the entire point of these lanes.
- **Keep release.yml's signing job on GitHub-hosted** regardless of choice:
  the step-scoped signing key should not land on a homelab box or a
  third-party VM without a deliberate trust decision.
- Self-hosted runners are acceptable here because the repo is private
  (self-hosted + public repos is the classic security foot-gun).

## Option A — second-hand Apple-silicon Mac mini (self-hosted)

The runner plumbing already exists: e2e.yml has used `[self-hosted, macOS,
ARM64]` labels for months. Adding a mini means installing the GitHub runner
agent on it and flipping the three ci.yml jobs' `runs-on` to the self-hosted
labels.

- Payback vs ~$97/mo run-rate (prices are ballpark second-hand market,
  verify when shopping): M1 mini 16GB ≈ $300–450 → pays back in 4–5 months;
  M2 mini ≈ $450–550 → 5–6 months. Any M-series with 16GB is enough for
  these jobs.
- Power draw is negligible (a mini idles under 10W).
- Real costs to weigh: it must stay on and reachable (the e2e runner's
  offline windows already show what that looks like); macOS updates are
  manual; one box = no concurrency and a single point of failure for
  merge-gating lanes (mitigation: keep `macos-14` as a fallback label or
  gate only non-blocking lanes on it initially).

## Option B — third-party pay-per-use macOS runners

Drop-in services that replace `runs-on: macos-14` with their label, billed
per minute. Prices below are from memory / marketing pages and MUST be
re-verified before committing (they change often):

- **Depot** — mac runners around half GitHub's rate; already evaluated for
  Linux and parked because it required moving the repo into a GitHub org
  (docs/STATUS 2026-08-19). Same blocker likely applies.
- **WarpBuild / FlyCI / Namespace** — advertised macOS arm runners in the
  $0.04–0.06/min range (~25–50% below GitHub's $0.08 list).
- **Cirrus Runners** — flat ~$150/mo per always-on M-series runner slot:
  only wins above ~2,400 mac min/mo, which we are well under. Skip.
- **AWS EC2 Mac / Scaleway Apple silicon** — rented dedicated minis
  (~$0.65/hr with 24h minimum on AWS; Scaleway hourly is cheaper). These are
  rentals, not per-job runners — you'd still run the GitHub agent yourself.
  Only sensible if a self-hosted mini is wanted without owning hardware;
  monthly cost exceeds the current bill, so skip unless consolidating.

At ~1,200–1,400 mac min/mo, a ~$0.05/min service lands around **$60–70/mo →
saves only ~$25–35/mo**. A $350 used mini beats every service within half a
year and also gives the fleet a real darwin-arm64 field machine.

## Recommendation

Buy the used M-series mini (Option A): payback ~5 months against the current
run-rate, it reuses existing self-hosted plumbing, and services only shave
~30% where the mini shaves ~100% of the recurring bill. Keep release signing
on GitHub-hosted, and keep `macos-14` available as a fallback while the mini
proves a few weeks of uptime.
