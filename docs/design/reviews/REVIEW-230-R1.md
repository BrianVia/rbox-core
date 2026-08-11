# Review 230 · Round 1

**Reviewer:** adversarial subagent
**Result:** not aligned; revised before implementation

## Findings

1. Creating `~/rbox` is a filesystem policy effect, not copy-only work. The
   design must name `stepWorkspace` as its owner and give the branch a deletion
   condition.
2. Completion must render the collapsed local root, never relabel the remote
   display name as a folder.
3. Machine status must distinguish the optional label (`NAME`) from the local
   path (`FOLDER`) instead of renaming a label column to `FOLDER`.
4. “Add another synced folder” must not default to the already-bound current
   root and route the user into a rebind flow.
5. A top-level `rbox conflicts` alias is deferred. Existing durable evidence is
   Git-only and cannot honestly represent file conflicts.

## Revision

Design 230 now:

- scopes the work as CLI Adapter policy plus presentation;
- records ownership and a deletion condition for recommended-root creation;
- specifies `folder: <collapsed-root>` completion output;
- specifies truthful `NAME` and `FOLDER` machine columns;
- passes the current root as an excluded root for “Add another,” with no reuse
  before any rebind or remote effect; and
- retains the unified conflict inbox as a follow-up requiring authoritative
  evidence from both conflict planes.
