import path from "node:path";

/** A path argument as the workspace names it. Anything outside the workspace
 * throws, so a mistyped path refuses instead of quietly selecting nothing. */
export function workspaceRelativeRepo(root: string, arg: string): string {
  const rel = path.relative(root, path.resolve(arg)).split(path.sep).join("/");
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) {
    throw new Error(`${arg} is not inside this synced folder`);
  }
  return rel;
}
