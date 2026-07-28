/** Minimal semver for the forward-only upgrade gate (design 14 U4'). Parses
 *  `MAJOR.MINOR.PATCH` (optional leading `v`, optional `-prerelease` which we treat
 *  as lower than the same release, and optional `+build` ignored for precedence).
 *  Rejects malformed input rather than guessing. */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
  build: string | null;
}

export type ReleaseChannel = "latest" | "next";

const RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const DEV_BUILD_RE = /^dev\.[0-9a-f]{7,64}$/i;

export function parseSemver(s: string): SemVer {
  const m = RE.exec(s.trim());
  if (!m) throw new Error(`not a semver: ${s}`);
  const core = [m[1]!, m[2]!, m[3]!].map(Number);
  if (core.some((value) => !Number.isSafeInteger(value))) throw new Error(`not a semver: ${s}`);
  const prerelease = m[4] ?? null;
  if (prerelease?.split(".").some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
    throw new Error(`not a semver: ${s}`);
  }
  return {
    major: core[0]!,
    minor: core[1]!,
    patch: core[2]!,
    prerelease,
    build: m[5] ?? null,
  };
}

export function releaseChannelForVersion(version: string): ReleaseChannel {
  return parseSemver(version).prerelease === null ? "latest" : "next";
}

/** Compare two prerelease strings by semver §11 precedence: dot-separated
 *  identifiers, numeric ones compared numerically (so `rc.2` < `rc.10`, NOT the
 *  lexical reverse), numeric < alphanumeric, and a longer identifier list wins
 *  when all shared identifiers are equal. Returns <0, 0, or >0. */
function comparePrerelease(a: string, b: string): number {
  const ai = a.split(".");
  const bi = b.split(".");
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    if (i >= ai.length) return -1; // a is a prefix of b ⇒ a is lower
    if (i >= bi.length) return 1;
    const x = ai[i]!;
    const y = bi[i]!;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (x.length !== y.length) return x.length - y.length;
      if (x !== y) return x < y ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers are lower than alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1; // both alphanumeric ⇒ ASCII order
    }
  }
  return 0;
}

/** True iff `a` is strictly newer than `b`. A release (no prerelease) outranks the
 *  same x.y.z prerelease; prereleases use semver §11 identifier precedence.
 *
 * Build metadata normally has equal semver precedence. rbox adds one operational
 * tie-break: an unadorned version outranks the same version carrying `dev.*`
 * metadata. That lets an official release replace a local build of itself without
 * making one local build newer than another. */
export function semverGt(a: string, b: string): boolean {
  const x = parseSemver(a);
  const y = parseSemver(b);
  for (const k of ["major", "minor", "patch"] as const) {
    if (x[k] !== y[k]) return x[k] > y[k];
  }
  if (x.prerelease === y.prerelease) {
    return x.build === null && y.build !== null && DEV_BUILD_RE.test(y.build);
  }
  if (x.prerelease === null) return true; // release > prerelease of same x.y.z
  if (y.prerelease === null) return false;
  return comparePrerelease(x.prerelease, y.prerelease) > 0;
}
