/**
 * Design 263 §6 settled-authority load measurements.
 *
 * Fixture construction and mutex acquisition sit outside timed regions. A cold
 * sample runs one load in a fresh Bun process and starts its clock immediately
 * before importing the compatibility Adapter; a warm sample repeats after one
 * discarded load in the resident graph.
 *
 * usage:
 *   bun scripts/bench/genesis-admission-loads.ts --samples 25
 *   bun scripts/bench/genesis-admission-loads.ts --samples 25 --repo /tmp/rbox-origin
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type AuthorityKind = "json" | "q";
interface Summary { readonly p50Ms: number; readonly p95Ms: number; readonly samples: number }

const moduleUrl = (repo: string, relative: string): string =>
  pathToFileURL(path.join(repo, relative)).href;

async function childSample(repo: string, kind: AuthorityKind, root: string, stream: string): Promise<void> {
  const mutexes = await import(moduleUrl(repo, "src/cli/sync-mutex.ts"));
  const mutex = await mutexes.acquireWorkspaceSyncMutex(root, "cli");
  try {
    const startedAt = performance.now();
    const { loadState } = await import(moduleUrl(repo, "src/cli/state-plane/adapters/whole-state-compat.ts"));
    const state = await loadState(root, stream, () => undefined, mutex);
    const elapsedMs = performance.now() - startedAt;
    if (state.stream !== stream) throw new Error(`${kind} fixture selected the wrong stream`);
    process.stdout.write(JSON.stringify({ elapsedMs }));
  } finally {
    await mutexes.releaseWorkspaceSyncMutex(mutex);
  }
}

function summary(values: readonly number[]): Summary {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return { p50Ms: round(percentile(0.5)), p95Ms: round(percentile(0.95)), samples: sorted.length };
}

async function fixtures(repo: string): Promise<{
  readonly stream: string;
  readonly jsonRoot: string;
  readonly qRoot: string;
  readonly cleanup: () => void;
}> {
  const [configModule, legacy, paths, stores, marker] = await Promise.all([
    import(moduleUrl(repo, "src/cli/workspace-config.ts")),
    import(moduleUrl(repo, "src/cli/state-plane/adapters/legacy-json-store.ts")),
    import(moduleUrl(repo, "src/cli/state-plane/paths.ts")),
    import(moduleUrl(repo, "src/cli/state-plane/store/open.ts")),
    import(moduleUrl(repo, "src/cli/state-plane/authority-marker.ts")),
  ]);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-genesis-load-bench-"));
  const jsonRoot = fs.realpathSync(fs.mkdtempSync(path.join(parent, "json-")));
  const qRoot = fs.realpathSync(fs.mkdtempSync(path.join(parent, "q-")));
  const stream = "https://bench.invalid::ws-genesis-load::root";
  const configure = async (root: string): Promise<void> => {
    await configModule.saveConfig(root, {
      schema: "e2ee/v1",
      remoteWorkspaceId: "ws-genesis-load",
      projectId: "root",
      deviceId: "dev-genesis-load",
      rootPath: root,
      remoteUrl: "https://bench.invalid",
      token: "",
    });
    fs.mkdirSync(paths.sqliteResetPaths.stateRoot(root), { recursive: true });
  };
  await configure(jsonRoot);
  await legacy.saveStateUnsafeLegacyOrTest(jsonRoot, {
    stream,
    stateNonce: "c".repeat(32),
    stateRevision: 0,
    lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
  });
  await configure(qRoot);
  const authorityId = "a".repeat(32);
  stores.createStateStore(paths.sqliteResetPaths.active(qRoot), {
    authorityId,
    lineageId: "b".repeat(32),
    stream,
    createdBy: "bench",
    stateNonce: "c".repeat(32),
    stateRevision: 0,
  }).close();
  fs.writeFileSync(paths.statePath(qRoot), marker.authorityMarkerBytes(authorityId));
  return { stream, jsonRoot, qRoot, cleanup: () => fs.rmSync(parent, { recursive: true, force: true }) };
}

function coldSamples(repo: string, kind: AuthorityKind, root: string, stream: string, samples: number): number[] {
  const values: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const child = spawnSync(process.execPath, [import.meta.path, "--child", repo, kind, root, stream], {
      encoding: "utf8",
    });
    if (child.status !== 0) throw new Error(`cold ${kind} sample failed: ${child.stderr}`);
    values.push((JSON.parse(child.stdout) as { elapsedMs: number }).elapsedMs);
  }
  return values;
}

async function warmSamples(repo: string, root: string, stream: string, samples: number): Promise<number[]> {
  const [{ loadState }, mutexes] = await Promise.all([
    import(moduleUrl(repo, "src/cli/state-plane/adapters/whole-state-compat.ts")),
    import(moduleUrl(repo, "src/cli/sync-mutex.ts")),
  ]);
  const mutex = await mutexes.acquireWorkspaceSyncMutex(root, "cli");
  try {
    await loadState(root, stream, () => undefined, mutex);
    const values: number[] = [];
    for (let index = 0; index < samples; index += 1) {
      const startedAt = performance.now();
      await loadState(root, stream, () => undefined, mutex);
      values.push(performance.now() - startedAt);
    }
    return values;
  } finally {
    await mutexes.releaseWorkspaceSyncMutex(mutex);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const samplesAt = args.indexOf("--samples");
  const repoAt = args.indexOf("--repo");
  const samples = samplesAt === -1 ? 25 : Number(args[samplesAt + 1]);
  const repo = path.resolve(repoAt === -1 ? process.cwd() : args[repoAt + 1] ?? "");
  if (!Number.isSafeInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");
  if (!fs.existsSync(path.join(repo, "src/cli/state-plane/adapters/whole-state-compat.ts"))) {
    throw new Error(`--repo is not an rbox source tree: ${repo}`);
  }

  const fixture = await fixtures(repo);
  try {
    const result = {
      version: 1,
      repo,
      bun: Bun.version,
      host: `${os.platform()}-${os.arch()} ${os.cpus()[0]?.model ?? "unknown-cpu"}`,
      json: {
        cold: summary(coldSamples(repo, "json", fixture.jsonRoot, fixture.stream, samples)),
        warm: summary(await warmSamples(repo, fixture.jsonRoot, fixture.stream, samples)),
      },
      q: {
        cold: summary(coldSamples(repo, "q", fixture.qRoot, fixture.stream, samples)),
        warm: summary(await warmSamples(repo, fixture.qRoot, fixture.stream, samples)),
      },
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    fixture.cleanup();
  }
}

if (process.argv[2] === "--child") {
  const [, repo, kind, root, stream] = process.argv.slice(2);
  if (!repo || (kind !== "json" && kind !== "q") || !root || !stream) throw new Error("invalid child arguments");
  await childSample(repo, kind, root, stream);
} else {
  await main();
}
