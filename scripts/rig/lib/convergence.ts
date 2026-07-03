/**
 * Tree convergence: the whole point of the bench is "did both devices end up with
 * byte-identical trees?" We fingerprint each guest's workspace IN the guest (a
 * `find` + `sha256sum` sweep, symlinks captured by target), then compare the two
 * fingerprints on the host, excluding `.rbox/` (per-device state, never synced).
 *
 * The script builder / parser / comparator are PURE (unit-tested); only
 * {@link fingerprintTree} touches a device.
 */
import type { Device } from "./device.js";

/** sha256 of the empty byte string — used to assert an empty file round-tripped. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface FpEntry {
  path: string;
  /** File → hex sha256; symlink → `symlink:<target>`. */
  digest: string;
  kind: "file" | "symlink";
}

export interface Fingerprint {
  entries: FpEntry[];
  fileCount: number;
}

/**
 * Shell snippet emitting one tab-separated record per entry:
 *   `F\t<relpath>\t<sha256>`   for regular files
 *   `L\t<relpath>\t<target>`   for symlinks
 * `.rbox/` is pruned. (Paths with tabs/newlines aren't handled — the seeded
 * corpus never produces them; a P1+ concern for arbitrary real workloads.)
 */
export function fingerprintScript(dir: string): string {
  return [
    `cd '${dir}' 2>/dev/null || exit 0`,
    `find . -path ./.rbox -prune -o -type f -print 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do`,
    `  printf 'F\\t%s\\t%s\\n' "$f" "$(sha256sum "$f" | cut -d' ' -f1)"`,
    `done`,
    `find . -path ./.rbox -prune -o -type l -print 2>/dev/null | LC_ALL=C sort | while IFS= read -r l; do`,
    `  printf 'L\\t%s\\t%s\\n' "$l" "$(readlink "$l")"`,
    `done`,
  ].join("\n");
}

export function parseFingerprint(stdout: string): Fingerprint {
  const entries: FpEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const tab1 = line.indexOf("\t");
    const tab2 = line.indexOf("\t", tab1 + 1);
    if (tab1 < 0 || tab2 < 0) continue;
    const kindChar = line.slice(0, tab1);
    const path = line.slice(tab1 + 1, tab2);
    const rest = line.slice(tab2 + 1);
    if (kindChar === "F") entries.push({ path, digest: rest, kind: "file" });
    else if (kindChar === "L") entries.push({ path, digest: `symlink:${rest}`, kind: "symlink" });
  }
  entries.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return { entries, fileCount: entries.filter((e) => e.kind === "file").length };
}

export interface Divergence {
  identical: boolean;
  onlyInA: string[];
  onlyInB: string[];
  /** Paths present on both but with differing digest. */
  differing: string[];
}

export function compareFingerprints(a: Fingerprint, b: Fingerprint): Divergence {
  const ma = new Map(a.entries.map((e) => [e.path, e.digest]));
  const mb = new Map(b.entries.map((e) => [e.path, e.digest]));
  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  const differing: string[] = [];
  for (const [p, d] of ma) {
    if (!mb.has(p)) onlyInA.push(p);
    else if (mb.get(p) !== d) differing.push(p);
  }
  for (const p of mb.keys()) if (!ma.has(p)) onlyInB.push(p);
  onlyInA.sort();
  onlyInB.sort();
  differing.sort();
  return { identical: onlyInA.length === 0 && onlyInB.length === 0 && differing.length === 0, onlyInA, onlyInB, differing };
}

export async function fingerprintTree(device: Device, dir: string): Promise<Fingerprint> {
  const res = await device.exec(["sh", "-c", fingerprintScript(dir)]);
  return parseFingerprint(res.stdout);
}
