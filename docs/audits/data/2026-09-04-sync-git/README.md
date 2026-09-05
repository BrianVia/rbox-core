# Audit evidence

These are diagnostic records for the September 4 sync/Git review, not production code or a new test suite. Lane reports describe their exact scope and limitations.

Reproduction scripts have a `.ts.txt` suffix to keep them out of source and lint inventories. Copy a chosen script into a temporary `.ts` file, update its absolute imports to your checkout, and execute it with Bun. Git probes create isolated temporary repositories; some deliberately retain those repositories for inspection. Do not run these scripts inside a live workspace as application commands.

The deletion comparison implements only the absent-delete fixture, and the ancestry comparison only a simple owned-ancestor case. The DO experiment uses stub storage. None demonstrates production performance or a fully equivalent replacement.

`rbox-audit-codec-tests.log` and `rbox-audit-git-confirm.log` were captured by the primary reviewer. `rbox-git-tests.log` records both passing tests and environment-limited failures.
