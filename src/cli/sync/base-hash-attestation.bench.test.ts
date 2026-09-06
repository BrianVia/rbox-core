/**
 * Issue #816's measurement: what a push stops doing once its base hash is attested.
 *
 * Every push over the desktop fleet's 182k-entry manifest re-derives three facts
 * about a base that changed by one entry — the delta-base seam's
 * `validateManifest` and `canonicalManifestHashStreaming`, and then the encoder's
 * own `assertManifest(base)`. All three are pure functions of the base, so this
 * measures them directly on a synthetic manifest of fleet size rather than
 * through a daemon.
 *
 * The gate is a RATIO, not a millisecond budget: the removed work is O(entries)
 * and the retained work is O(1), so the margin is enormous on any machine and
 * nothing here is load-sensitive. The absolute numbers are printed for the record.
 */
import { expect, test } from "bun:test";
import { canonicalManifestHashStreaming, validateManifest, type FileEntry, type Manifest } from "../../engine/index.js";
import { encodeDeltaEnvelope } from "../../engine/manifest-delta.js";

const ENTRIES = 180_000;

function syntheticManifest(count: number): Manifest {
  const files: FileEntry[] = new Array(count);
  for (let index = 0; index < count; index++) {
    files[index] = {
      path: `workspace/dir${String(index % 512).padStart(4, "0")}/file${String(index).padStart(7, "0")}.ts`,
      sha256: index.toString(16).padStart(64, "0"),
      size: 1024 + index,
      mode: 0o644,
      mtimeMs: 1_700_000_000_000 + index,
      type: "file",
      encSha: (index + 1).toString(16).padStart(64, "0"),
    } as FileEntry;
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { generatedAt: "2026-08-24T00:00:00.000Z", files, manifestSchema: 2 };
}

const millis = (run: () => void): number => {
  const t0 = performance.now();
  run();
  return performance.now() - t0;
};

test(`the attested base skips both O(${ENTRIES}) base passes a push repeats today (#816)`, async () => {
  const base = syntheticManifest(ENTRIES);
  const target: Manifest = {
    ...base,
    generatedAt: "2026-08-24T00:00:01.000Z",
    files: [{ ...base.files[0]!, size: base.files[0]!.size + 89 }, ...base.files.slice(1)],
  };
  const baseManifestHash = canonicalManifestHashStreaming(base);
  const options = { baseEncSha: "a".repeat(64), baseManifestHash, compress: true };

  // BEFORE — what push.ts's `delta_base_ms` span costs on every push: the base's
  // shape pass plus the canonical re-hash of the whole entry stream.
  const deltaBaseMs = millis(() => {
    expect(validateManifest(base).ok).toBe(true);
    expect(canonicalManifestHashStreaming(base)).toBe(baseManifestHash);
  });
  // BEFORE — and the encoder walks the SAME base a third time inside `encodeMs`.
  const encoderBaseMs = millis(() => { expect(validateManifest(base).ok).toBe(true); });

  // AFTER — the attestation is an O(1) lookup, and the encoder is told to skip.
  // Min-of-3, alternating: a single cold-vs-warm shot lost to JIT/GC noise on shared
  // CI runners three times on 2026-09-06 (validated 4.8s vs plain 4.25s). The claim is
  // about work skipped, which the minimum isolates; the bytes must still be identical.
  let validatedMs = Infinity;
  let plainMs = Infinity;
  let validated = await encodeDeltaEnvelope(base, target, { ...options, baseValidated: true });
  let plain = await encodeDeltaEnvelope(base, target, options);
  for (let round = 0; round < 3; round++) {
    const t0 = performance.now();
    validated = await encodeDeltaEnvelope(base, target, { ...options, baseValidated: true });
    validatedMs = Math.min(validatedMs, performance.now() - t0);
    const t1 = performance.now();
    plain = await encodeDeltaEnvelope(base, target, options);
    plainMs = Math.min(plainMs, performance.now() - t1);
  }

  const recovered = deltaBaseMs + encoderBaseMs;
  console.error(`#816 bench (${ENTRIES} entries): delta_base ${deltaBaseMs.toFixed(0)}ms + encoder assertManifest(base) ${encoderBaseMs.toFixed(0)}ms `
    + `= ${recovered.toFixed(0)}ms recovered per push; encode ${plainMs.toFixed(0)}ms -> ${validatedMs.toFixed(0)}ms`);

  // The wire is unchanged whichever arm produced it — the saving is pure waste removed.
  expect(validated.bytes).toEqual(plain.bytes);
  expect(validated.resultHash).toBe(plain.resultHash);

  // Both removed passes are real work at this size, and the encoder's own base
  // pass is a measurable share of the encode it sits inside.
  expect(deltaBaseMs).toBeGreaterThan(20);
  expect(encoderBaseMs).toBeGreaterThan(5);
  expect(validatedMs).toBeLessThan(plainMs);
}, 120_000);
