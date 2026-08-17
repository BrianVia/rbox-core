/** `conflictName` mints `<stem>.<token>.<14 digits>.conflict[<ext>]`; `~N` is `claimUnclobberedName`'s `i = 2` suffix. */
const RBOX_CONFLICT_ARTIFACT =
  /^(?<stem>.+)\.(?<token>[^./]+)\.(?<ts>[0-9]{14})\.conflict(?<ext>\.[^./]*)?(?<dup>~(?:[2-9]|[1-9][0-9]+))?$/;

/** A NAMESPACE CLAIM over one path component, not an unforgeable test. */
export function isRboxConflictArtifact(component: string): boolean {
  return RBOX_CONFLICT_ARTIFACT.test(component);
}

/** The `rbox status` count: locally observed entries carrying a conflict-copy component. */
export function countConflictCopies(files: ReadonlyArray<{ path: string }>): number {
  return files.filter((file) => file.path.split("/").some(isRboxConflictArtifact)).length;
}
