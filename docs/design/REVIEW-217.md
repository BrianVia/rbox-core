# REVIEW-217 — adversarial review round 1

Date: 2026-07-28

## Evidence executed

- `bun run typecheck` — PASS.
- Acceptance command
  `bun test scripts/ src/cli/semver.test.ts src/cli/upgrade-cmd.test.ts` —
  FAIL at the pre-existing `scripts/e2e/dev-backed-scenario.test.ts` pairing
  fixtures: 355 pass, 2 fail. Also, `src/cli/semver.test.ts` does not exist yet.
- Focused baseline
  `bun test scripts/release.test.ts scripts/release-publish.test.ts src/cli/semver.test.ts src/cli/upgrade-cmd.test.ts`
  — PASS: 24 pass, 0 fail across the three existing suites (Bun silently has no
  fourth suite because `src/cli/semver.test.ts` is absent).

The repository was otherwise left unchanged.

## Blocking findings

### 1. The proposed `next/install.sh` does not install `next`

Section 3 only maps the existing `scripts/install.sh` bytes from
`releases/install.sh` to `releases/next/install.sh` and swallows mutable binary
aliases. Those installer bytes default to `https://api.rbox.to`, fetch
`$BASE/version`, and download `$BASE/bin/rbox-<target>`. They neither select
`/next/version` nor extract the signed manifest's immutable `path`. Therefore
the published `next/install.sh` would install stable (or fail if it were pointed
at a nonexistent next mutable alias), directly violating requirements 2 and 3.

The design must specify how `release.ts` creates the prerelease installer
variant without changing stable bytes. Given that next has no mutable binary
aliases, the variant must fetch the next manifest and download the shared
immutable `/bin/v<version>/rbox-<target>` path named by that manifest. Tests
must execute/inspect the variant and prove both URLs, not merely assert its R2
key.

### 2. A refused downgrade switch is persisted as successful

Section 4 says an explicit channel is persisted **before fetching**, but later
says switching `next` to an older `latest` throws. That ordering writes
`latest` before the barrier can refuse it. It also changes the durable choice
when fetching or signature verification fails. A subsequent unflagged upgrade
would then read `latest`, so the alleged refusal did not refuse the switch.

Read the old channel, fetch and authenticate the requested channel, apply the
B0/durable-floor downgrade barrier, and only then commit the new channel.
Specify crash semantics relative to binary replacement. Tests must assert that
network/signature failure and downgrade refusal leave `next` persisted.

### 3. First publication of `next` remains unresolved

Section 3 correctly observes that the existing `Bun.spawnSync(wrangler get)`
path treats every nonzero result as fatal, but then merely says bootstrap “must
be addressed” by one of two possibilities. That is not an implementable
design. Choose and specify a typed `found | missing` read seam, including how a
genuine R2 not-found is distinguished from authentication, network, parse, and
other failures. Only `missing` may bootstrap; every other failure must refuse
all mutable publication. Tests must cover missing-next success and non-missing
read failure with an empty write set.

### 4. The touch-only constraint conflicts with required end-to-end behavior

The conflict in section 6 is real:

- `apps/api/src/routes/release.ts` serves only `/version` and `/version.sig`
  from stable keys. No checked-in route can serve the next manifest/signature.
- `src/cli/main-dispatch.ts` currently passes only `--remote` and `--check` to
  `upgradeCmd`.
- `src/cli/help-registry.ts` is the public option/arity declaration and has no
  `--channel`.

Thus a reachable, documented `rbox upgrade --channel next` against the default
API cannot be implemented within the literal touch list. Option 2 does not
satisfy the spec, and option 3 has no existing route. The design must resolve
this as option 1 (the minimal API route, dispatch, help, and focused tests are
mechanically required by the explicit behavior), rather than leave a choice
open for implementation.

It must also name the exact route contract:
`/next/version` -> `releases/next/manifest.json`,
`/next/version.sig` -> `releases/next/manifest.json.sig`, and
`/next/install.sh` -> `releases/next/install.sh`, while immutable binaries
continue through the existing `/bin/v…` route. The API tests need to prove
stable and next key isolation.

### 5. The ≤500-line constraint has no feasible file plan

Current relevant lengths include:

- `src/cli/upgrade-cmd.ts`: 494 lines
- `src/cli/upgrade-cmd.test.ts`: 569 lines
- `src/cli/main-dispatch.ts`: 731 lines
- `src/cli/help-registry.ts`: 817 lines

Moving channel storage to a new module prevents growth of `upgrade-cmd.ts`, but
the design explicitly plans to edit multiple already-over-limit files and add
tests to the 569-line test. It must state whether the constraint applies only
to newly created/source implementation files or give a concrete split plan
(especially for the required upgrade tests). Leaving this to implementation
cannot satisfy “files ≤500 lines.”

## Additional required clarifications

- Strict SemVer parsing must avoid JavaScript `Number` precision corrupting
  precedence for large numeric core/prerelease identifiers. Specify either
  exact comparison (for example digit strings/BigInt) or an explicit,
  tested safe-integer rejection policy.
- The workflow section should state the exact stable-only expression used for
  both the changelog-heading gate and deploy hook. The version equality gate
  already accepts prerelease strings and should remain otherwise unchanged.
- The publisher test seam must record both reads and writes. For prerelease it
  must prove no read of `releases/version.json` and no stable mutable/changelog
  writes; write-set-only coverage cannot prove requirement 3's read isolation.
- The stable publication path should continue calling the existing publisher
  directly, with its existing assertions unchanged; tests should separately
  prove stable byte paths and ordering rather than relying on a key-remapping
  wrapper's behavior.

CHANGES-REQUIRED

## Round 2

The revision resolves the round-1 persistence ordering, typed bootstrap,
API/dispatch/help reachability, SemVer precision, workflow condition, read-set
coverage, and file-size-policy questions. Two implementation-contract gaps
remain:

1. Sections 3 and 3.1 do not connect the generated `dist/install-next.sh` to
   publication. The described store wrapper maps only the **key** passed for
   `scripts/install.sh`; `publishReleaseObjects` still passes the stable
   installer's file path. The design must explicitly remap both key and source
   file (or give the next publisher a direct operation) so
   `releases/next/install.sh` receives `dist/install-next.sh`, while stable
   continues receiving the checked-in file byte-for-byte.
2. The release entrypoint's build-metadata policy is unspecified. The current
   inline release regex rejects `1.2.3+build`, while `parseSemver` accepts build
   metadata; blindly replacing the regex with `releaseChannelForVersion` would
   newly publish it as stable even though the API's immutable binary route does
   not accept `+` in version paths. To preserve stable behavior and
   reachability, explicitly reject build metadata for non-dev release inputs
   (and test it as malformed for publication), or specify and test the larger
   route/path change.

CHANGES-REQUIRED

## Round 3

The final revision resolves both round-2 blockers: the next-channel adapter now
remaps the installer put's source file to generated `dist/install-next.sh`, and
non-dev publisher input explicitly rejects build metadata while the general
SemVer parser retains correct build parsing. The resulting design preserves
stable bytes and routes, gives next an isolated bootstrap/monotonic activation
path, makes the opt-in durable only after authenticated downgrade checks, and
specifies the mechanically required API/dispatch/help exceptions and acceptance
coverage. No remaining design-level blocker was found.

ALIGNED

## Post-implementation diff review

The first pass found a race because channel persistence preceded acquisition of
the executable upgrade lock. Implementation was revised so channel
read/barrier/write and binary replacement share that lock; floor and channel
are re-read under it, unflagged upgrades abort on channel drift, and artifact
validation precedes persistence. The stable publisher received an exact
read/write/order integration test, and the channel config reader now performs
bounded before/open/after file-identity checks. Focused re-review found no
remaining correctness or security blocker.
