/** The checked-in package version. The release workflow's consistency gate reads
 *  the first quoted string in this file, so keep this literal first. */
const CHECKED_IN_RBOX_VERSION = "0.9.13";

declare const __RBOX_DEV_VERSION__: string | undefined;

export function resolveRboxVersion(definedVersion: string | undefined): string {
  return definedVersion ?? CHECKED_IN_RBOX_VERSION;
}

/** The running binary's version. The release workflow OVERWRITES this file from
 *  the git tag before `bun build --compile`, so a compiled binary knows its own
 *  version (used by `rbox --version` and the forward-only `rbox upgrade` check).
 *  In a source checkout it stays the package.json version. Dev builds pass
 *  __RBOX_DEV_VERSION__ via `bun build --compile --define`. */
export const RBOX_VERSION = resolveRboxVersion(typeof __RBOX_DEV_VERSION__ === "string" ? __RBOX_DEV_VERSION__ : undefined);
