/**
 * Git ref-set comparison for `git-entanglement` (design 56 §9 / design 43 regression
 * net). The scenario proves sync never entangles git state: after A→B sync, B's ref
 * set (branches + tags + their object shas) must be byte-identical to A's. Raw
 * `git for-each-ref` output string-compares fine, but parsing it into structured
 * entries lets a mismatch name EXACTLY which ref diverged (missing tag, wrong sha)
 * instead of dumping two multi-line blobs — the same shape as lib/manifest-check.ts.
 *
 * PURE (unit-tested): the divergence verdict never depends on a container.
 */

/** One `git for-each-ref --format='%(objectname) %(refname)'` line. For an annotated
 *  tag `objectname` is the TAG object's sha (not the commit it points at) — that's the
 *  right identity to compare, since it is what synced through the bundle. */
export interface RefLine {
  /** 40/64-hex object id the ref resolves to. */
  objectname: string;
  /** Full refname, e.g. `refs/heads/main`, `refs/tags/v1`. */
  refname: string;
}

/**
 * Parse `git for-each-ref --format='%(objectname) %(refname)'` output. Blank lines and
 * surrounding whitespace are tolerated; each kept line splits on the FIRST space
 * (objectname is hex + space-free, refnames never contain spaces). Entries are sorted
 * by refname so the result is canonical regardless of git's emit order.
 */
export function parseForEachRef(out: string): RefLine[] {
  const lines: RefLine[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const sp = line.indexOf(" ");
    if (sp <= 0) continue; // malformed — skip (a real ref always has both fields)
    lines.push({ objectname: line.slice(0, sp), refname: line.slice(sp + 1).trim() });
  }
  return lines.sort((a, b) => (a.refname < b.refname ? -1 : a.refname > b.refname ? 1 : 0));
}

export interface RefDiff {
  identical: boolean;
  /** Refnames present on A but not B. */
  onlyA: string[];
  /** Refnames present on B but not A. */
  onlyB: string[];
  /** Refnames present on both but resolving to different object ids. */
  differing: string[];
}

/**
 * Compare two ref sets by refname → objectname. Both directions are reported so a
 * mismatch names precisely what diverged (a dropped tag, a branch pointing at the wrong
 * commit). PURE.
 */
export function diffRefLines(a: RefLine[], b: RefLine[]): RefDiff {
  const ma = new Map(a.map((e) => [e.refname, e.objectname]));
  const mb = new Map(b.map((e) => [e.refname, e.objectname]));
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  const differing: string[] = [];
  for (const [ref, sha] of ma) {
    const other = mb.get(ref);
    if (other === undefined) onlyA.push(ref);
    else if (other !== sha) differing.push(ref);
  }
  for (const ref of mb.keys()) if (!ma.has(ref)) onlyB.push(ref);
  onlyA.sort();
  onlyB.sort();
  differing.sort();
  return { identical: onlyA.length === 0 && onlyB.length === 0 && differing.length === 0, onlyA, onlyB, differing };
}

/** One-line ref-diff summary for an assertion detail (first 5 offenders). PURE. */
export function refDiffDetail(d: RefDiff): string {
  const sample = [...d.onlyA.map((r) => `A:${r}`), ...d.onlyB.map((r) => `B:${r}`), ...d.differing.map((r) => `≠:${r}`)].slice(0, 5);
  return `onlyA=${d.onlyA.length} onlyB=${d.onlyB.length} diff=${d.differing.length} (${sample.join(", ")})`;
}
