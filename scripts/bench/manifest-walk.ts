import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIgnoreMatcher } from "../../src/engine/ignore.js";
import { HashCache } from "../../src/engine/hashcache.js";
import { scanManifest } from "../../src/engine/manifest.js";

const count = Number(process.argv[2] ?? 50_000);
if (!Number.isInteger(count) || count < 1) throw new Error("usage: bun scripts/bench/manifest-walk.ts [positive-file-count]");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-manifest-walk-bench-"));
const cache = new HashCache();
const matcher = buildIgnoreMatcher(root);

async function mapBatches<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  for (let offset = 0; offset < items.length; offset += 256) {
    await Promise.all(items.slice(offset, offset + 256).map(work));
  }
}

async function serialWarmWalk(): Promise<number> {
  let files = 0;
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!(matcher.prunes?.(`${childRel}/`) ?? matcher.ignores(`${childRel}/`))) await walk(childRel);
      } else if (entry.isFile() && !matcher.ignores(childRel)) {
        const st = await fs.stat(path.join(root, childRel));
        if (!cache.lookup(childRel, st.mtimeMs, st.size, st.ctimeMs)) throw new Error(`cold cache: ${childRel}`);
        files += 1;
      }
    }
  };
  await walk("");
  return files;
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const measure = async (work: () => Promise<unknown>): Promise<number> => {
  const started = performance.now();
  await work();
  return performance.now() - started;
};

try {
  const dirs = Array.from({ length: Math.ceil(count / 100) }, (_, index) => `d-${String(index).padStart(4, "0")}`);
  await mapBatches(dirs, (dir) => fs.mkdir(path.join(root, dir)));
  const files = Array.from({ length: count }, (_, index) => {
    const dir = dirs[Math.floor(index / 100)]!;
    return path.join(root, dir, `f-${String(index % 100).padStart(3, "0")}`);
  });
  await mapBatches(files, (file) => fs.writeFile(file, "x"));

  await scanManifest(root, matcher, cache); // populate the shared warm hash cache
  await serialWarmWalk();
  await scanManifest(root, matcher, cache);

  const pool1: number[] = [];
  const pool16: number[] = [];
  for (let run = 0; run < 3; run++) {
    pool1.push(await measure(serialWarmWalk));
    pool16.push(await measure(() => scanManifest(root, matcher, cache)));
  }
  const oldMs = median(pool1);
  const newMs = median(pool16);
  console.log(JSON.stringify({ files: count, pool1Ms: oldMs, pool16Ms: newMs, speedup: oldMs / newMs, pool1Runs: pool1, pool16Runs: pool16 }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
