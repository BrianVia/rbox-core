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
      if (x !== y) return Number(x) - Number(y);
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers are lower than alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1; // both alphanumeric ⇒ ASCII order
    }
  }
  return 0;
}

/** True iff `a` is strictly newer than `b`. A release (no prerelease) outranks the
 *  same x.y.z prerelease; prereleases use semver §11 identifier precedence. */
export function semverGt(a: string, b: string): boolean {
  const x = parseSemver(a);
  const y = parseSemver(b);
  for (const k of ["major", "minor", "patch"] as const) {
    if (x[k] !== y[k]) return x[k] > y[k];
  }
  if (x.prerelease === y.prerelease) return false;
  if (x.prerelease === null) return true; // release > prerelease of same x.y.z
  if (y.prerelease === null) return false;
  return comparePrerelease(x.prerelease, y.prerelease) > 0;
}
