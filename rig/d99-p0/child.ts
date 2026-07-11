import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runArmA } from "./arm-a.js";
import { runArmB } from "./arm-b.js";
import { startSamplers } from "./metrics.js";
import type { CorpusFile } from "./corpus.js";

const args = Object.fromEntries(process.argv.slice(2).map((v) => { const [k, ...r] = v.split("="); return [k.replace(/^--/, ""), r.join("=")]; }));
const arm = args.arm;
const workers = Number(args.workers);
process.env.RBOX_CRYPTO_WORKERS = String(workers);
const corpus = JSON.parse(await fs.readFile(args.manifest, "utf8")) as CorpusFile[];
const kek = Buffer.from(args.kek, "hex");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "d99-cell-"));
const sampler = startSamplers();
try {
  const metrics = arm === "A"
    ? await runArmA(corpus, kek, tmp, workers)
    : await runArmB(corpus, kek, tmp, workers, Number(args.budget) * 1048576, Number(args.inflight), Number(args.settle ?? 0), Number(args.maxjobs ?? 0));
  const memory = sampler.stop();
  process.stdout.write(JSON.stringify({ ...metrics, ...memory }));
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
