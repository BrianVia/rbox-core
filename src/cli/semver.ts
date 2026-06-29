/** Minimal semver for the forward-only upgrade gate (design 14 U4'). Parses
 *  `MAJOR.MINOR.PATCH` (optional leading `v`, optional `-prerelease` which we treat
 *  as lower than the same release). Rejects malformed input rather than guessing. */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseSemver(s: string): SemVer {
  const m = RE.exec(s.trim());
  if (!m) throw new Error(`not a semver: ${s}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null };
}

/** True iff `a` is strictly newer than `b`. A release (no prerelease) outranks the
 *  same x.y.z prerelease; prereleases compare lexically (sufficient for our use). */
export function semverGt(a: string, b: string): boolean {
  const x = parseSemver(a);
  const y = parseSemver(b);
  for (const k of ["major", "minor", "patch"] as const) {
    if (x[k] !== y[k]) return x[k] > y[k];
  }
  if (x.prerelease === y.prerelease) return false;
  if (x.prerelease === null) return true; // release > prerelease of same x.y.z
  if (y.prerelease === null) return false;
  return x.prerelease > y.prerelease;
}
