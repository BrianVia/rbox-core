import { describe, expect, test } from "vitest";

/** A small deterministic generator keeps failures reproducible without another dependency. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function union<T>(sets: Iterable<ReadonlySet<T>>): Set<T> {
  const result = new Set<T>();
  for (const set of sets) for (const value of set) result.add(value);
  return result;
}

describe("dropped-set index algebra", () => {
  test("matches the brute-force retained union across churn, re-adds, re-drops, and prune floors", () => {
    // Exercise enough independent walks that a counterexample reports its exact seed.
    for (let seed = 1; seed <= 100; seed++) {
      const rng = random(seed);
      const history: Array<Set<string>> = [new Set()];
      const dropped = new Map<string, number>();
      const seqRoots = new Map<number, Set<string>>();

      for (let seq = 1; seq <= 80; seq++) {
        const previous = history[seq - 1]!;
        const current = new Set(previous);

        // Toggle refs rather than only replacing them: this deliberately creates
        // remove -> re-add -> re-drop histories, the subtle case for last_seq.
        for (let ref = 0; ref < 48; ref++) {
          if (rng() < 0.13) {
            const sha = `data-${ref}`;
            if (current.has(sha)) current.delete(sha);
            else current.add(sha);
          }
        }

        for (const sha of previous) {
          if (!current.has(sha)) dropped.set(sha, seq - 1);
        }
        for (const sha of current) {
          if (!previous.has(sha)) dropped.delete(sha);
        }
        history.push(current);

        const roots = new Set([`manifest-${seq}`]);
        if (rng() < 0.55) roots.add(`carrier-${seq}`);
        seqRoots.set(seq, roots);

        // Check several floors after every fold, including the inclusive-base
        // boundary where last_seq === floor must not be retained.
        const floors = new Set([0, seq - 1, Math.floor(rng() * seq), Math.floor(rng() * seq)]);
        for (const floor of floors) {
          const bruteData = union(history.slice(floor + 1, seq + 1));
          const bruteSeqRoots = union([...seqRoots].filter(([s]) => s > floor && s <= seq).map(([, roots]) => roots));
          const brute = union([bruteData, bruteSeqRoots]);

          const indexed = new Set(history[seq]);
          for (const [sha, lastSeq] of dropped) if (lastSeq > floor) indexed.add(sha);
          for (const [s, rootsForSeq] of seqRoots) {
            if (s > floor && s <= seq) for (const sha of rootsForSeq) indexed.add(sha);
          }

          expect(indexed, `seed=${seed}, head=${seq}, floor=${floor}`).toEqual(brute);
        }
      }

      // The bounded sweeper is semantics-preserving at and above the new floor.
      const floor = 40;
      for (const [sha, lastSeq] of dropped) if (lastSeq <= floor) dropped.delete(sha);
      for (const seq of seqRoots.keys()) if (seq <= floor) seqRoots.delete(seq);
      const brute = union([
        union(history.slice(floor + 1)),
        union([...seqRoots].filter(([seq]) => seq > floor).map(([, roots]) => roots)),
      ]);
      const indexed = new Set(history.at(-1));
      for (const [sha, lastSeq] of dropped) if (lastSeq > floor) indexed.add(sha);
      for (const roots of seqRoots.values()) for (const sha of roots) indexed.add(sha);
      expect(indexed, `post-sweep seed=${seed}`).toEqual(brute);
    }
  });
});
