import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RemoteContext } from "../../src/cli/remote/context.js";
import { putBlobMultipart } from "../../src/cli/remote/multipart.js";
import { resetMultipartMetricsSinkForTests, setMultipartMetricsSink } from "../../src/cli/remote/multipart-metrics.js";
import { startFakeMultipartServer } from "../../src/cli/remote/multipart-fake-server.js";

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const numberArg = (name: string, fallback: number, min: number): number => {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) throw new Error(`${name} must be a number >= ${min}`);
  return value;
};

const mib = arg("--gib") === undefined ? numberArg("--mib", 24, 1) : numberArg("--gib", 2, 1) * 1024;
const size = Math.round(mib * 1024 * 1024);
const latencyMs = Math.round(numberArg("--latency-ms", 0, 0));
const failPart = arg("--fail-part") === undefined ? undefined : Math.round(numberArg("--fail-part", 1, 1));

async function writeSynthetic(file: string, bytes: number, random: boolean): Promise<void> {
  const handle = await fs.open(file, "w");
  const chunkSize = 1024 * 1024;
  const repetitive = Buffer.alloc(chunkSize, 0x61);
  try {
    for (let offset = 0; offset < bytes; offset += chunkSize) {
      const length = Math.min(chunkSize, bytes - offset);
      const chunk = random ? randomBytes(length) : repetitive.subarray(0, length);
      await handle.write(chunk, 0, length, offset);
    }
  } finally {
    await handle.close();
  }
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-d101-p0-"));
const server = await startFakeMultipartServer({ partLatencyMs: latencyMs, failPartOnce: failPart });
const lines: string[] = [];
setMultipartMetricsSink((line) => lines.push(line));
process.env.RBOX_METRICS = "1";

try {
  const ctx = new RemoteContext(server.baseUrl, "local-token", "local-workspace", "local-project");
  for (const [label, random] of [["incompressible", true], ["compressible", false]] as const) {
    const file = path.join(temp, `${label}.bin`);
    await writeSynthetic(file, size, random);
    const digest = await sha256(file);
    const before = server.stats.completedParts;
    const lineOffset = lines.length;
    await putBlobMultipart(ctx, digest, file, size);
    console.log(`${label} bytes=${size} parts=${server.stats.completedParts - before}`);
    for (const line of lines.slice(lineOffset)) console.log(line);
  }
} finally {
  resetMultipartMetricsSinkForTests();
  await server.close();
  await fs.rm(temp, { recursive: true, force: true });
}
