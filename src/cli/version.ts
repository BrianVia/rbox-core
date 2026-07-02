/** The running binary's version. The release workflow OVERWRITES this file from
 *  the git tag before `bun build --compile`, so a compiled binary knows its own
 *  version (used by `rbox --version` and the forward-only `rbox upgrade` check).
 *  In a source checkout it stays the package.json version. */
export const RBOX_VERSION = "0.6.1";
