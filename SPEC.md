# Redundant test cull — mechanical deletion

KILL-LIST.json lists 64 adjudicated tests (file, line, name, verdict, reason).
Founder rubric: existence tests, typecheck-satisfiable tests, provider-shape
assumption tests, UI/UX copy ceremony.

For each entry:
1. Delete the ENTIRE test(...) block (or test.each block when the entry names
   the parameterized test). Line numbers are from origin/main — re-locate by
   NAME if drifted.
2. Remove imports/helpers/consts that become unused ONLY because of the
   deletion. Do not touch helpers still used by surviving tests.
3. If a file loses ALL its tests, delete the file. If a describe block empties,
   delete the block.
4. NEVER delete a test not on the list. NEVER edit non-test source files.

Acceptance:
- Every touched test file still parses and its remaining tests pass:
  run per-file `bun test <file>` (wrap in a script if the guard refuses).
- `bun run typecheck` green.
- `bun run lint:affected` introduces no NEW warnings.
- Final tally in CULL-REPORT.md: tests deleted per file, files fully removed,
  helpers/imports pruned.
