# Planning evidence for design 287

These are diagnostic planning probes, not implementation acceptance tests. Sources are preserved as `.ts.txt` so they do not enter product test/build inventories. Copy to a temporary `.ts` file before running with Bun. The read-only matcher probe has a session-specific absolute source import that must be adjusted in another checkout. All fixtures are temporary; the split-index probe prints and retains its fixture directory for inspection.

Reported execution in this planning session (Bun 1.3.14, Apple Git 2.50.1):

- `rbox-git-plan-probe.ts.txt`: private split-index normalization left the live index hash unchanged; assume-unchanged/skip-worktree flags matched at the receiver; receiver index readable with no shared-index dependency. This does not prove sparse/unmerged identity convergence or owned-scratch dependency routing.
- `rbox-git-reuse-probe.ts.txt`: staged Git blob was 8 LF bytes while the working file was 10 CRLF bytes; plaintext hashes differed. Object reuse must verify actual manifest bytes.
- `rbox-plan-readonly-index-probe.ts.txt`: fresh Git and the current matcher correctly identified the force-added `a.secret` while `.git` was mode 0555; copying a private sibling index failed EACCES. This invalidated the first draft's write-access assumption.
- `bun test src/cli/state-plane/schema/store-open.test.ts`: planning pass reported 13 pass / 2 failures associated with foreign-WAL and unavailable immutable-URI behavior in this runtime. This is not supported-runtime acceptance; the project requires Bun ^1.4.0.

The two `review1-*.md` files preserve skeptical review findings against the first draft. They describe that draft, not unresolved defects automatically applicable to the revised document. See the numbered review dispositions for resolution and remaining focused design gates. No product code, API deployment or live fleet state was changed for this plan.
