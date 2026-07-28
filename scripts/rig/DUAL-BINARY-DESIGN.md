# Dual-binary rig plumbing

Authority: design 163 §U3, “Dual-binary rig plumbing.” This scoped note exists
inside `scripts/rig/` because the deliverable is explicitly limited to that tree.

## Contract

- `--binary <path>` remains the shorthand for the same compiled binary on A and B.
- `--binary-a <path>` and `--binary-b <path>` override the shorthand per device.
  Every supplied path receives the existing exact-absolute, regular non-symlink,
  canonical, executable validation.
- Provisioning receives a per-device selection and creates each container with
  its own staged mount. Changing either selection recreates only the container
  whose create specification changed.
- Resolution validates every supplied path, including an overridden shorthand,
  then selects A as `binary-a ?? binary ?? source` and B equivalently.
- A binary identity contains the device, source/compiled mode, exact executable
  content SHA-256, canonical host path when compiled, and the observed
  `rbox --version` string. Source mode hashes the mounted `src/` tree and all
  baked dependency inputs. Both identities are persisted in `report.json`.
- A run is “mismatched” when the effective modes or content digests differ; two
  canonical paths containing identical bytes are the same binary. It is refused
  before provisioning unless the selected scenario declares dual-binary support.
  `run all` is refused because the suite contains scenarios without that support.
- For a declared dual-binary scenario, mismatched selection additionally requires
  different observed version strings before scenario assertions run. This is the
  design-163 guard against one binary masquerading as a differential. An equal or
  failed version probe writes a FAIL report containing both identities and does
  not reset guests or call `scenario.run`.
- `up` permits per-device selection because it does not execute a scenario.
- Scenario capability is explicit and closed by default:
  `supportsDualBinary?: true`. No existing scenario is opted in. Git-entanglement
  parses legacy `.rbox/state.json`, which is not present after 2.0 migration.
  Two-device-live never explicitly migrates its 2.0 side, so it would only prove
  mixed executables in legacy-state mode, not design 163's mixed-authority case.

## Structure

- Extend `lib/binary.ts` with pure selection, content-based mismatch, identity,
  and per-device mount helpers. Keep filesystem validation injectable for tests.
- Stage each unique compiled path once; calculate the digest from the same byte
  buffer written to the staging directory to avoid identity/staging races.
- Extract command-level binary policy/report shaping into a small rig library so
  refusal and identity behavior have Docker-free tests.
- Thread prepared selections through `ensureUp`, workload reprovisioning, and
  scenario execution.
- Keep `rig.ts` below 500 lines by extracting the existing doctor command rather
  than growing the current oversized entrypoint.

## Validation

- `bun test ./scripts/rig/`
- `bun run typecheck`
- `bun run rig doctor` only when the local Docker daemon is reachable
- Diff-scoped simplification review, explicit-path staging, local commit only
