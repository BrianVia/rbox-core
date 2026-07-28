# Design 217 — prerelease (`next`) release channel

Status: ALIGNED after adversarial review round 3; implemented, 2026-07-28

## 1. Goal and invariants

Implement `SPEC.md` without changing the stable release contract:

- Semver tags with a prerelease component select `next`; bare semver selects
  `latest`; malformed versions fail before build or publication.
- Immutable binaries remain at `releases/v<version>/rbox-<target>`.
- Stable mutable objects remain byte/path-identical:
  `releases/rbox-<target>`, `releases/install.sh`,
  `releases/version.json`, and `releases/version.json.sig`.
- Prerelease mutable objects are only `releases/next/install.sh`,
  `releases/next/manifest.json`, and
  `releases/next/manifest.json.sig`. A prerelease publish never reads or writes
  the stable manifest, mutable binary aliases, install script, changelog, or
  changelog deploy hook.
- Each channel has an independent monotonicity guard using the existing semver
  precedence implementation.
- Installed clients default to and persist `latest`; `--channel next` and
  `--channel latest` change that install-scoped choice without prompting.

## 2. Semver and channel derivation

`src/cli/semver.ts` owns strict parsing and exports:

```ts
type ReleaseChannel = "latest" | "next";
releaseChannelForVersion(version: string): ReleaseChannel;
```

The helper calls `parseSemver`; a non-null prerelease selects `next`. The parser
is tightened to Semver 2.0 identifier rules (no empty identifiers, no leading
zero in numeric prerelease identifiers, and no leading zero in core numbers),
so malformed publisher inputs cannot reach a channel. Core numeric fields must
be safe integers; larger values are rejected. Numeric prerelease identifiers
are compared as canonical digit strings by length and then lexically, never by
lossy JavaScript `Number`.

`scripts/release.ts` removes its inline version regex and derives the channel
through this helper for all non-dev release paths. Publisher input additionally
rejects a parsed non-null `build` component, preserving today's refusal of
`1.2.3+build` and the API's versioned-path grammar. Dev versions do not publish.

## 3. Publisher split

`scripts/release.ts` exports a small publication seam used by its test. The seam
takes a typed live-reader result:

```ts
type LiveChannelVersion =
  | { status: "found"; version: string }
  | { status: "missing" };
```

The production reader returns `missing` only when wrangler's bounded stderr is
the exact object-not-found diagnostic for the requested key. Authentication,
network, subprocess, malformed JSON, and missing/invalid version failures
throw. Stable never permits `missing`; next permits it only for initial
bootstrap. All reads complete and pass monotonicity before the first write.

The seam calls the existing `publishReleaseObjects` for stable releases
unchanged. For `next`, it wraps the object store:

- immutable `releases/v…` puts and hashes pass through unchanged;
- the three stable binary aliases are swallowed (prerelease installation uses
  the signed immutable artifact path);
- `releases/install.sh` maps to `releases/next/install.sh`;
- `releases/version.json[.sig]` maps to
  `releases/next/manifest.json[.sig]`;
- every unexpected mutable key fails closed.

The next wrapper remaps both sides of the installer put: key
`releases/install.sh` becomes `releases/next/install.sh` **and its source file**
becomes the generated `dist/install-next.sh`. All other source files remain
exactly those supplied by `publishReleaseObjects`. Stable uses no wrapper and
continues uploading the checked-in installer bytes directly.

The live-manifest reader is parameterized by the derived manifest key. Stable
reads `releases/version.json`; next reads `releases/next/manifest.json`.
After mutable activation, the same key is re-read and must equal the candidate.

Stable alone validates the newest changelog heading, publishes
`releases/changelog.md`, and triggers the website deploy hook. Next skips all
three.

### 3.1 Prerelease installer variant

Stable continues uploading the exact checked-in `scripts/install.sh`. For next,
`release.ts` deterministically derives `dist/install-next.sh` without editing
the stable file:

- manifest fetch: `<base>/next/version`;
- the constrained compact-JSON extraction obtains both the selected artifact's
  sha and its signed immutable `path`;
- binary fetch: `<base>/bin/<signed path>`, which remains in the shared
  immutable namespace;
- user-facing verification text names `/next/version`.

Generation fails unless every expected stable source fragment is found exactly
once, so an installer edit cannot silently produce a stale next variant. Tests
assert the generated next URLs/path extraction and that stable installer bytes
are not changed.

## 4. Client persistence and URL selection

Add a focused config module, `src/cli/upgrade-channel.ts`, because
`upgrade-cmd.ts` is already 494 lines. It stores canonical JSON next to the
installed executable (install-scoped and compatible with elevated upgrades):

```json
{"schema":1,"channel":"next"}
```

Absence means `latest`. Reads are bounded, no-follow, regular-file checked, and
schema validated; writes use `writeFileAtomic` and directory fsync. The command
validates an explicit `--channel`, reads the old choice, and selects:

| channel | manifest base |
| --- | --- |
| `latest` | `<remote>` |
| `next` | `<remote>/next` |

The explicit flag flows from `main-dispatch.ts`; help declares
`--channel <latest|next>` so the existing parser gives it value arity. Tests
cover both dispatch and command behavior.

The requested manifest and signature are fetched and authenticated before any
setting write. The signed manifest is compared to the executable-scoped B0
floor before any download. When switching explicitly from `next` to `latest`,
if either the running version or durable floor is newer than latest's manifest,
the command throws:

> cannot switch to the latest channel: installed rbox <installed> is newer than
> latest <latest>; install a newer latest release before switching back

No floor is lowered, no binary is replaced, and the persisted channel remains
`next`. Fetch/signature failure also leaves the old channel unchanged. After a
valid manifest passes this barrier, the requested channel is persisted before
the optional artifact download/replace. Thus a crash after replacement cannot
leave a next binary following latest accidentally; a later artifact-download
failure still leaves the explicitly selected, authenticated channel in effect.

## 5. Workflow

- The `v*` trigger is unchanged.
- Version consistency remains exact string equality; prerelease strings are
  already accepted by shell equality and the `version.ts` extractor.
- The script's changelog heading check remains the workflow's build-time rule
  and becomes stable-only based on the shared derived channel.
- The changelog deploy-hook step gains the exact condition
  `if: ${{ !contains(github.ref_name, '-') }}`. Semver validation in the script
  rejects malformed tags before this heuristic can publish.

## 6. Repository-scope conflicts requiring review

The current repository exposes only `/version` and `/version.sig` from stable
R2 keys in `apps/api/src/routes/release.ts`; there is no `/next/version` route.
Therefore the required client URL cannot work end-to-end without touching that
API route and its tests, but `SPEC.md` explicitly excludes those files.

The CLI flag also cannot be reachable without changing `main-dispatch.ts` and
`help-registry.ts` (and their tests), which are absent from the touch-only list.

The implementation therefore treats the explicit reachable behavior as
authorizing the smallest mechanically necessary exceptions:

- `main-dispatch.ts` passes the parsed channel;
- `help-registry.ts` declares its value arity and help;
- `apps/api/src/routes/release.ts` and focused tests expose
  `/next/version` -> `releases/next/manifest.json`,
  `/next/version.sig` -> `releases/next/manifest.json.sig`, and
  `/next/install.sh` -> `releases/next/install.sh`;
- shared immutable binaries continue through `/bin/v…`.

Stable routes and keys are unchanged. There is no implementation satisfying
both the explicit end-to-end behavior and the literal touch-only list; these
exceptions prefer the behavioral requirements and are recorded in the final
report.

The repository also already has touched public-surface files over 500 lines
(`main-dispatch.ts`, `help-registry.ts`, and `upgrade-cmd.test.ts`). They are
treated as grandfathered debt: edits are minimal and do not add a new
abstraction to them. `upgrade-cmd.ts` remains at or below 500 by extracting
channel config, and every new module is below 500. Channel-focused tests go in
a new sub-500 `upgrade-channel.test.ts`; the acceptance-named
`upgrade-cmd.test.ts` receives only the required integration cases, with enough
older state tests mechanically moved to `upgrade-state.test.ts` if needed to
avoid net growth.

## 7. Tests and acceptance

- `src/cli/semver.test.ts`: stable, beta, rc, and malformed channel matrix plus
  prerelease ordering; publisher tests separately pin `+build` as rejected
  release input even though the general parser accepts build metadata.
- `scripts/release.test.ts`: exact prerelease read/write set; stable paths
  unchanged; independent monotonic guards; missing-next bootstrap;
  non-missing read failure causes zero writes; prerelease never observes stable
  state.
- `src/cli/upgrade-cmd.test.ts`: absent default, persistence, URL derivation,
  switching back, and exact downgrade-refusal copy.
- Dispatch/help tests for the public flag and API release-route tests for next
  manifest/signature/install serving and stable/next key isolation.
- Required acceptance:
  `bun run typecheck`
  and
  `bun test scripts/ src/cli/semver.test.ts src/cli/upgrade-cmd.test.ts`.
- Repository flow validation: run the targeted API route suite and an executable
  simulated publisher test whose recorded write set proves stable isolation.
