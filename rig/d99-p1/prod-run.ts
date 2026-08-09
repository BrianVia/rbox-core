// THROWAWAY — design 99 Phase 1 step-4 production-path A/B runner.
// Generates a 20k corpus, runs Arm A (oracle pool) vs Arm B (production encryptStream,
// null consumer) interleaved in per-arm child processes, reports the encrypt-wall delta,
// peak RSS vs the 96 MiB + control bound, and peak FD. Confirms the ≥30% gate holds
// end-to-end against the PRODUCTION code path (not the Phase-0 prototype).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKek } from "../../src/engine/crypto.js";
import { generateCorpus } from "../d99-p0/corpus.js";
import { summary, bootstrapDeltaCI } from "../d99-p0/metrics.js";
interface BunSpawnOptions { stdout: "pipe"; stderr: "pipe"; env: NodeJS.ProcessEnv }
declare const Bun: { spawn(args: string[], opts: BunSpawnOptions): { stdout: ReadableStream; stderr: ReadableStream; exited: Promise<number> } };

const argv = process.argv.slice(2);
const value = (name: string, fallback: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const files = Number(value("--files", "20000"));
const runs = Number(value("--runs", "5"));
const dispatch = Number(value("--dispatch", "4"));
const budget = Number(value("--budget", "96"));
const parallel = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
const workers = Math.min(Math.max(parallel - 2, 2), 16, Math.max(1, Math.floor(os.totalmem() / (512 * 1048576)))); // = configuredWorkers()

const redact = (s: string) => s.split(/\s+/).map((t) => (t.includes("/") ? "[redacted]" : t)).join(" ");
async function child(arm: string): Promise<any> {
  const a = [process.execPath, new URL("./prod-child.ts", import.meta.url).pathname, `--arm=${arm}`, `--manifest=${manifest}`, `--kek=${kek.toString("hex")}`, `--workers=${workers}`, `--dispatch=${dispatch}`, `--budget=${budget}`];
  const proc = Bun.spawn(a, { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`child ${arm} failed: ${redact(err)}`);
  return JSON.parse(out);
}

const kek = generateKek();
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "d99p1-corpus-"));
const manifest = path.join(dir, "manifest.json");
const aWalls: number[] = [], bWalls: number[] = [];
let aRss = 0, bRss = 0, aFd = 0, bFd = 0, bFps = 0;
try {
  console.log(`generating ${files} files; workers=${workers}, dispatch=${dispatch}, budget=${budget}MiB`);
  const corpus = await generateCorpus(dir, files, 9901);
  await fs.writeFile(manifest, JSON.stringify(corpus));
  for (const f of corpus) await fs.readFile(f.absPath); // uniform page-cache warm
  for (let run = 1; run <= runs; run++) {
    const a = await child("A"); aWalls.push(a.wallMs); aRss = Math.max(aRss, a.maxRssBytes); aFd = Math.max(aFd, a.peakFdCount);
    const b = await child("B"); bWalls.push(b.wallMs); bRss = Math.max(bRss, b.maxRssBytes); bFd = Math.max(bFd, b.peakFdCount); bFps = Math.max(bFps, b.filesPerSecond);
    console.log(`run ${run}/${runs}: A ${a.wallMs.toFixed(0)}ms  B ${b.wallMs.toFixed(0)}ms  delta ${(((a.wallMs - b.wallMs) / a.wallMs) * 100).toFixed(1)}%`);
  }
} finally { await fs.rm(dir, { recursive: true, force: true }); }

const aP50 = summary(aWalls).p50, bP50 = summary(bWalls).p50;
const delta = (aP50 - bP50) / aP50;
const ci = bootstrapDeltaCI(aWalls, bWalls);
const rssBound = aRss + budget * 1048576 + 32 * 1048576;
const rssOk = bRss <= rssBound;
const fdOk = bFd <= aFd;
const gate = delta >= 0.30 && ci.lo >= 0.30 && rssOk && fdOk;
console.log("\n=== PRODUCTION-PATH A/B (design 99 Phase 1, step 4) ===");
console.log(`A p50 ${aP50.toFixed(0)}ms  B p50 ${bP50.toFixed(0)}ms  files/s ${bFps.toFixed(0)}`);
console.log(`delta p50 ${(delta * 100).toFixed(1)}%  bootstrap 95% CI [${(ci.lo * 100).toFixed(1)}%, ${(ci.hi * 100).toFixed(1)}%]`);
console.log(`peak RSS: A ${(aRss / 1048576).toFixed(0)}MiB  B ${(bRss / 1048576).toFixed(0)}MiB  bound(A+budget+32) ${(rssBound / 1048576).toFixed(0)}MiB  ok=${rssOk}`);
console.log(`peak FD: A ${aFd}  B ${bFd}  ok=${fdOk}`);
console.log(`GATE (≥30%, CI>30%, RSS ok, FD ok): ${gate ? "PASS" : "FAIL"}`);
