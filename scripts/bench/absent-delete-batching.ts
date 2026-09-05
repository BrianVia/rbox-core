/** Opt-in: bun scripts/bench/absent-delete-batching.ts. No wall-clock CI gate. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyWatchEvents } from "../../src/engine/manifest.js";
import { buildIgnoreMatcher } from "../../src/engine/ignore.js";
import type { FileEntry } from "../../src/engine/types.js";
import type { WatchEvent } from "../../src/engine/manifest-observation.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-absent-delete-bench-"));
const files: FileEntry[] = Array.from({ length: 124_000 }, (_, i) => ({
  path: `d${String(i).padStart(6, "0")}/f`,
  sha256: "a".repeat(64),
  size: 1,
  mode: 0o644,
  mtimeMs: 0,
  type: "file"
}));
const events: WatchEvent[] = files.slice(0, 1_000).map((file) => ({ relPath: file.path.slice(0, -2), kind: "unlinkDir" }));
const matcher = buildIgnoreMatcher(root);
const measurements: number[] = [];
try {
  for (let run = 0; run < 4; run++) {
    const started = performance.now();
    const result = await applyWatchEvents({ generatedAt: "", files }, root, matcher, events);
    const elapsed = performance.now() - started;
    if (result.files.length !== 123_000 || result.files[0]?.path !== "d001000/f") throw new Error("deletion result mismatch");
    if (run > 0) measurements.push(elapsed);
  }
  console.log(
    JSON.stringify({
      runtime: Bun.version,
      entries: files.length,
      deletes: events.length,
      warmups: 1,
      measurements,
      medianMs: [...measurements].sort((a, b) => a - b)[1],
      scope: "consecutive absent unlinkDir only; interleaved events break runs"
    })
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
