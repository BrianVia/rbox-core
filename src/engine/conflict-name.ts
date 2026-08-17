/** `conflictName` mints `<stem>.<token>.<14 digits>.conflict[<ext>]`; `~N` is `claimUnclobberedName`'s `i = 2` suffix. */
const RBOX_CONFLICT_ARTIFACT =
  /^(?<stem>.+)\.(?<token>[^./]+)\.(?<ts>[0-9]{14})\.conflict(?<ext>\.[^./]*)?(?<dup>~(?:[2-9]|[1-9][0-9]+))?$/;

/** A NAMESPACE CLAIM over one path component, not an unforgeable test. */
export function isRboxConflictArtifact(component: string): boolean {
  return RBOX_CONFLICT_ARTIFACT.test(component);
}

/** The `rbox status` count: how many OBJECTS rbox minted, not how many files sit
 *  under them. The shallowest conflict-named component of a path names the minted
 *  object, so a moved-aside directory counts once however many files it holds, and
 *  a whole repo living under a conflict-named ancestor contributes that ancestor
 *  once. This is the number the user must act on — one thing to inspect and delete. */
export function countConflictCopies(files: ReadonlyArray<{ path: string }>): number {
  const minted = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    const at = parts.findIndex(isRboxConflictArtifact);
    if (at !== -1) minted.add(parts.slice(0, at + 1).join("/"));
  }
  return minted.size;
}
