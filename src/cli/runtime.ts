import path from "node:path";

/** True when running as a compiled Bun standalone binary (design 14 U1'): only then is
 *  `process.execPath` the rbox binary itself (under `bun run` it's Bun). Used by `upgrade`
 *  (only a real binary may replace itself) and daemon spawning (see `daemonSpawnArgs`).
 *  `Bun.isStandaloneExecutable` is the documented flag but is absent in some Bun versions
 *  (e.g. 1.3.5), so we also accept the `$bunfs` `Bun.main` signal; either + execPath not
 *  being `bun` ⇒ a real installed binary. */
export function isStandaloneBinary(): boolean {
  const bun = (globalThis as { Bun?: { isStandaloneExecutable?: boolean; main?: string } }).Bun;
  if (!bun) return false;
  const compiled = bun.isStandaloneExecutable === true || (typeof bun.main === "string" && bun.main.startsWith("/$bunfs/"));
  return compiled && path.basename(process.execPath) !== "bun";
}
