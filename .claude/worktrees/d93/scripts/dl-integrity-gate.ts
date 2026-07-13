import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const FILE_COUNT = 10_000;
const LARGE_FILE_COUNT = 2_000;
const SMALL_FILE_COUNT = FILE_COUNT - LARGE_FILE_COUNT;
const CORRUPTION_PROBABILITY = 0.02;
const CORRUPTION_SEED = 7;
const CONTENT_SEED = 0x72626f78;
const LARGE_PLAINTEXT_BYTES = 256 * 1024 + 1;
const RUN_MODES = ["A", "B", "C"] as const;
type RunMode = (typeof RUN_MODES)[number];

interface GateResult {
  run: RunMode;
  assertion: string;
  retries: number;
  seed: number | null;
  probability: number | null;
  fileCount: number;
  largeFileCount: number;
  selectedFaults: number;
  corruptionEvents: number;
  largeGets: number;
  recoveredExpected: number;
  persistentAttempts: number;
  bytesReceived: number | null;
  expectedSize: number | null;
  finalFilesVerified: number;
  largeBatchViolations: number;
  durationMs: number;
  keyLogLine: string;
}

interface SpawnedRun {
  result: GateResult;
  stdout: string;
  stderr: string;
  recoveredLines: string[];
  durationMs: number;
}

function isRunMode(value: string | undefined): value is RunMode {
  return RUN_MODES.includes(value as RunMode);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    let value = (state += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function deterministicLargeBuffer(): Uint8Array {
  const bytes = new Uint8Array(LARGE_PLAINTEXT_BYTES);
  let state = CONTENT_SEED >>> 0;
  for (let i = 0; i < bytes.byteLength; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

function causeChain(error: unknown): Error[] {
  const chain: Error[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return chain;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`gate assertion failed: ${message}`);
}

function cleanChildEnv(mode: RunMode, runRoot: string): Record<string, string> {
  const removed = new Set([
    "RBOX_NET_INTEGRITY_RETRIES",
    "RBOX_DOWNLOAD_CONCURRENCY",
    "RBOX_BATCH_BLOBS",
    "RBOX_BATCH_RECORDS",
    "RBOX_BATCH_RECORD_BYTES",
    "RBOX_BATCH_BODY_BYTES",
    "RBOX_BATCH_SLOTS",
    "RBOX_DEBUG",
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !removed.has(entry[0]))
  );
  env.GATE_RUN_ROOT = runRoot;
  env.GATE_RUN_MODE = mode;
  if (mode === "A") env.RBOX_NET_INTEGRITY_RETRIES = "0";
  return env;
}

async function writeStdout(value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(value, (error) => (error ? reject(error) : resolve()));
  });
}

async function runChild(mode: RunMode): Promise<GateResult> {
  const startedAt = performance.now();
  const runRoot = process.env.GATE_RUN_ROOT;
  requireCondition(runRoot, "GATE_RUN_ROOT must be provided by the controller");
  requireCondition(process.env.RBOX_DOWNLOAD_CONCURRENCY === undefined, "production-default download concurrency must be used");
  if (mode === "A") requireCondition(process.env.RBOX_NET_INTEGRITY_RETRIES === "0", "Run A must set retries to zero before imports");
  else requireCondition(process.env.RBOX_NET_INTEGRITY_RETRIES === undefined, `Run ${mode} must use the unset default retry budget`);

  // Project imports stay inside the child: blobs.ts reads the retry env at module load.
  const [{ FakeServer, bootstrapOnto, cfgFor, remoteFor }, { encryptFileNameProbe }, { pull }, { RboxApi }, { BlobDownloadIntegrityError }] =
    await Promise.all([
      import("../src/cli/e2ee-fake-server.js"),
      import("../src/engine/e2ee/e2ee-e2e.helpers.js"),
      import("../src/cli/sync.js"),
      import("../src/cli/remote/api.js"),
      import("../src/cli/remote/blobs.js"),
    ]);
  const { hashFile } = await import("../src/engine/hash.js");

  const server = new FakeServer();
  const accountId = `acct_dl_gate_${mode}`;
  const workspaceId = `ws_dl_gate_${mode}`;
  const deviceId = `dev_dl_gate_${mode}`;
  const now = 1_920_000_000_000;
  const secrets = await bootstrapOnto(server, accountId, deviceId, now);
  const seedRemote = remoteFor(server, secrets, accountId, workspaceId, now + 1_000);
  const seedCfg = await cfgFor(runRoot, secrets, seedRemote, workspaceId);
  requireCondition(seedCfg.kek, "seed configuration must contain a KEK");

  const manifestFiles: Array<{
    path: string;
    type: "file";
    sha256: string;
    encSha: string;
    size: number;
    mode: number;
    mtimeMs: number;
  }> = [];
  const largeShas = new Set<string>();
  const largeBySha = new Map<string, { path: string; expectedSize: number }>();
  const selectedFaultShas = new Set<string>();
  const faultRng = mulberry32(CORRUPTION_SEED);
  const largePlaintext = deterministicLargeBuffer();

  for (let i = 0; i < LARGE_FILE_COUNT; i++) {
    new DataView(largePlaintext.buffer).setUint32(0, i, false);
    const encrypted = await encryptFileNameProbe(new Uint8Array(seedCfg.kek), largePlaintext);
    const relPath = `large/${i.toString().padStart(4, "0")}.bin`;
    const expectedSize = encrypted.ciphertext.byteLength;
    requireCondition(expectedSize > 256 * 1024, `${relPath} must exceed the streaming threshold`);
    server.store.blobs.set(encrypted.encSha, encrypted.ciphertext);
    largeShas.add(encrypted.encSha);
    largeBySha.set(encrypted.encSha, { path: relPath, expectedSize });
    if (faultRng() < CORRUPTION_PROBABILITY) selectedFaultShas.add(encrypted.encSha);
    manifestFiles.push({
      path: relPath,
      type: "file",
      sha256: encrypted.plaintextSha,
      encSha: encrypted.encSha,
      size: largePlaintext.byteLength,
      mode: 0o644,
      mtimeMs: 1,
    });
  }

  const smallPlaintext = new TextEncoder().encode("rbox dl-integrity gate small fixture\n");
  const smallEncrypted = await encryptFileNameProbe(new Uint8Array(seedCfg.kek), smallPlaintext);
  server.store.blobs.set(smallEncrypted.encSha, smallEncrypted.ciphertext);
  for (let i = 0; i < SMALL_FILE_COUNT; i++) {
    manifestFiles.push({
      path: `small/${i.toString().padStart(4, "0")}.txt`,
      type: "file",
      sha256: smallEncrypted.plaintextSha,
      encSha: smallEncrypted.encSha,
      size: smallPlaintext.byteLength,
      mode: 0o644,
      mtimeMs: 1,
    });
  }
  requireCondition(manifestFiles.length === FILE_COUNT, "fixture manifest must contain exactly 10,000 files");
  requireCondition(selectedFaultShas.size > 0, "seeded 2% fault selection must choose at least one large blob");
  const firstSelectedSha = manifestFiles
    .filter((entry) => entry.path.startsWith("large/"))
    .map((entry) => entry.encSha)
    .find((sha) => selectedFaultShas.has(sha));
  requireCondition(firstSelectedSha, "seed must select a persistent-fault target");

  await seedRemote.commit(0, deviceId, { generatedAt: "", files: manifestFiles });

  let corruptionEvents = 0;
  let largeGets = 0;
  let largeBatchViolations = 0;
  let persistentAttempts = 0;
  const corruptedSizes: Array<{ received: number; expected: number }> = [];
  const corruptedOnce = new Set<string>();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.endsWith("/v1/blob-batch/get") && method === "POST") {
      const raw = typeof init?.body === "string" ? init.body : "[]";
      const shas = JSON.parse(raw) as string[];
      largeBatchViolations += shas.filter((sha) => largeShas.has(sha)).length;
      return server.blobBatchGet(shas);
    }
    const match = url.match(/\/v1\/blobs\/([0-9a-f]{64})$/);
    if (method === "GET" && match) {
      const sha = match[1]!;
      const stored = server.store.blobs.get(sha);
      if (!stored) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      if (largeShas.has(sha)) largeGets++;
      const oneShot = mode !== "C" && selectedFaultShas.has(sha) && !corruptedOnce.has(sha);
      const persistent = mode === "C" && sha === firstSelectedSha;
      if (oneShot || persistent) {
        corruptedOnce.add(sha);
        corruptionEvents++;
        if (persistent) persistentAttempts++;
        const bad = new Uint8Array(stored);
        bad[0] = bad[0]! ^ 0xff;
        const expected = largeBySha.get(sha)!.expectedSize;
        corruptedSizes.push({ received: bad.byteLength, expected });
        return new Response(bad, { status: 200 });
      }
      return new Response(stored, { status: 200 });
    }
    throw new Error(`gate FakeServer received unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  const http = new RboxApi("https://api.test", "gate-token", workspaceId, "root");
  server.blobStore = () => http.blobStore();
  const pullRemote = remoteFor(server, secrets, accountId, workspaceId, now + 2_000);
  const pullCfg = await cfgFor(runRoot, secrets, pullRemote, workspaceId);
  let thrown: unknown;
  try {
    await pull(runRoot, pullCfg, { remote: pullRemote });
  } catch (error) {
    thrown = error;
  }

  requireCondition(largeBatchViolations === 0, "large file blobs must never enter the batch endpoint");
  for (const event of corruptedSizes) {
    requireCondition(event.received === event.expected, "every injected corruption must preserve the exact byte length");
  }

  const retryBudget = mode === "A" ? 0 : 4;
  if (mode === "A") {
    const integrity = causeChain(thrown).find((error) => error instanceof BlobDownloadIntegrityError) as InstanceType<typeof BlobDownloadIntegrityError> | undefined;
    requireCondition(integrity, "Run A must abort with BlobDownloadIntegrityError in its cause chain");
    requireCondition(corruptionEvents >= 1, "Run A fault must demonstrably fire");
    requireCondition(integrity.bytesReceived === integrity.expectedSize, "Run A mismatch must be same-length corruption");
    const result: GateResult = {
      run: mode,
      assertion: "join aborted with a same-length download-integrity error",
      retries: retryBudget,
      seed: CORRUPTION_SEED,
      probability: CORRUPTION_PROBABILITY,
      fileCount: FILE_COUNT,
      largeFileCount: LARGE_FILE_COUNT,
      selectedFaults: selectedFaultShas.size,
      corruptionEvents,
      largeGets,
      recoveredExpected: 0,
      persistentAttempts,
      bytesReceived: integrity.bytesReceived,
      expectedSize: integrity.expectedSize ?? null,
      finalFilesVerified: 0,
      largeBatchViolations,
      durationMs: Math.round(performance.now() - startedAt),
      keyLogLine: integrity.message,
    };
    console.log(`[Run A] PASS: ${result.assertion}`);
    console.log(`[Run A] ${result.keyLogLine}`);
    return result;
  }

  if (mode === "B") {
    requireCondition(thrown === undefined, `Run B must complete, got: ${causeChain(thrown)[0]?.message ?? String(thrown)}`);
    requireCondition(corruptionEvents === selectedFaultShas.size, "Run B must serve exactly one corruption for every selected large blob");
    requireCondition(corruptedOnce.size === selectedFaultShas.size, "Run B must recover every selected fault");
    let verified = 0;
    for (const entry of manifestFiles) {
      const abs = path.join(runRoot, entry.path);
      const stat = await fs.stat(abs);
      requireCondition(stat.isFile(), `${entry.path} must be present as a file`);
      requireCondition(stat.size === entry.size, `${entry.path} must have the manifest size`);
      requireCondition((await hashFile(abs, entry.size)) === entry.sha256, `${entry.path} plaintext hash must match the harness manifest`);
      verified++;
    }
    requireCondition(verified === FILE_COUNT, "Run B must verify all 10,000 plaintext files");
    const result: GateResult = {
      run: mode,
      assertion: "join completed and every plaintext file matched the harness manifest",
      retries: retryBudget,
      seed: CORRUPTION_SEED,
      probability: CORRUPTION_PROBABILITY,
      fileCount: FILE_COUNT,
      largeFileCount: LARGE_FILE_COUNT,
      selectedFaults: selectedFaultShas.size,
      corruptionEvents,
      largeGets,
      recoveredExpected: selectedFaultShas.size,
      persistentAttempts,
      bytesReceived: corruptedSizes[0]?.received ?? null,
      expectedSize: corruptedSizes[0]?.expected ?? null,
      finalFilesVerified: verified,
      largeBatchViolations,
      durationMs: Math.round(performance.now() - startedAt),
      keyLogLine: `verified ${verified} files against the harness manifest`,
    };
    console.log(`[Run B] PASS: ${result.assertion}`);
    console.log(`[Run B] ${result.keyLogLine}`);
    return result;
  }

  const integrity = causeChain(thrown).find((error) => error instanceof BlobDownloadIntegrityError) as InstanceType<typeof BlobDownloadIntegrityError> | undefined;
  requireCondition(integrity, "Run C must fail with BlobDownloadIntegrityError in its cause chain");
  requireCondition(persistentAttempts === retryBudget + 1, "Run C must exhaust the initial attempt plus all four retries");
  requireCondition(integrity.bytesReceived === integrity.expectedSize, "Run C mismatch must be same-length corruption");
  const target = largeBySha.get(firstSelectedSha)!;
  const targetAbs = path.join(runRoot, target.path);
  const targetExists = await fs.stat(targetAbs).then(() => true, () => false);
  requireCondition(!targetExists, "Run C must leave no partial file at the final destination");
  const targetDirEntries = await fs.readdir(path.dirname(targetAbs));
  const targetBase = path.basename(targetAbs);
  const remnants = targetDirEntries.filter((name) => name.includes(targetBase) && (name.startsWith(".rbox-tmp-") || name.includes(".rboxdl-") || name.endsWith(".ct")));
  requireCondition(remnants.length === 0, `Run C must leave no staging remnants for ${target.path}`);
  const result: GateResult = {
    run: mode,
    assertion: "persistent corruption exhausted retries loudly and left no partial destination",
    retries: retryBudget,
    seed: null,
    probability: null,
    fileCount: FILE_COUNT,
    largeFileCount: LARGE_FILE_COUNT,
    selectedFaults: 1,
    corruptionEvents,
    largeGets,
    recoveredExpected: 0,
    persistentAttempts,
    bytesReceived: integrity.bytesReceived,
    expectedSize: integrity.expectedSize ?? null,
    finalFilesVerified: 0,
    largeBatchViolations,
    durationMs: Math.round(performance.now() - startedAt),
    keyLogLine: integrity.message,
  };
  console.log(`[Run C] PASS: ${result.assertion}`);
  console.log(`[Run C] ${result.keyLogLine}`);
  return result;
}

async function spawnRun(mode: RunMode, artifactDir: string): Promise<SpawnedRun> {
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), `rbox-dl-gate-${mode.toLowerCase()}-`));
  const startedAt = performance.now();
  try {
    const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "dl-integrity-gate.ts"), "--run", mode], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: cleanChildEnv(mode, runRoot),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const durationMs = Math.round(performance.now() - startedAt);
    const raw = `command: bun scripts/dl-integrity-gate.ts --run ${mode}\nexit: ${exitCode}\nduration_ms: ${durationMs}\n\n[stdout]\n${stdout}\n[stderr]\n${stderr}`;
    await fs.writeFile(path.join(artifactDir, `run-${mode.toLowerCase()}.log`), raw);
    process.stdout.write(`\n===== Run ${mode} stdout =====\n${stdout}`);
    process.stderr.write(`\n===== Run ${mode} stderr =====\n${stderr}`);
    requireCondition(exitCode === 0, `Run ${mode} child exited ${exitCode}`);
    const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith("GATE_RESULT "));
    requireCondition(resultLine, `Run ${mode} must emit a structured result`);
    const result = JSON.parse(resultLine.slice("GATE_RESULT ".length)) as GateResult;
    const recoveredLines = stderr.split(/\r?\n/).filter((line) => line.includes("download integrity recovered"));
    if (mode === "B") {
      requireCondition(recoveredLines.length >= 1, "Run B stderr must contain at least one recovery line");
      requireCondition(recoveredLines.length === result.recoveredExpected, "Run B must log one recovery line per recovered fault");
    } else {
      requireCondition(recoveredLines.length === 0, `Run ${mode} must not log a false recovery`);
    }
    return { result, stdout, stderr, recoveredLines, durationMs };
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
}

async function runController(): Promise<void> {
  const artifactDir = path.resolve(import.meta.dir, "../gate-artifacts");
  await fs.mkdir(artifactDir, { recursive: true });
  const results: SpawnedRun[] = [];
  for (const mode of RUN_MODES) results.push(await spawnRun(mode, artifactDir));
  const summary = results.map(({ result, recoveredLines, durationMs }) => ({ ...result, recoveredLines, controllerDurationMs: durationMs }));
  await fs.writeFile(path.join(artifactDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log("\nDL-INTEGRITY GATE PASS: Runs A, B, and C satisfied every gate assertion.");
  console.log(`Raw output: ${artifactDir}`);
}

const runArgIndex = process.argv.indexOf("--run");
const requestedMode = runArgIndex >= 0 ? process.argv[runArgIndex + 1] : undefined;
if (requestedMode !== undefined) {
  if (!isRunMode(requestedMode)) throw new Error(`unknown gate run mode: ${requestedMode}`);
  const result = await runChild(requestedMode);
  await writeStdout(`GATE_RESULT ${JSON.stringify(result)}\n`);
  process.exit(0); // fail-fast pull leaves sibling workers alive; the controller owns cleanup.
} else {
  await runController();
}
