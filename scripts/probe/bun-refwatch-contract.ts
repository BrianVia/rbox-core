#!/usr/bin/env bun

/**
 * Behavioral contract for the Bun fs.watch Git-ref side channel proposed by
 * RECOMMENDATION.md section 6.
 *
 * This file intentionally imports no rbox product code. It combines Bun's
 * node:fs watch implementation with a separate @parcel/watcher subscription
 * so a Bun upgrade must demonstrate the required behavior, regardless of how
 * that runtime is implemented.
 */

import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const ATTEMPTS = positiveInt(process.env.RBOX_REFWATCH_PROBE_ATTEMPTS, 5);
const DEADLINE_MS = 5_000;
const PARENT_TO_REF_DELAY_MS = 15;
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox refwatch probe",
  GIT_AUTHOR_EMAIL: "refwatch-probe@local",
  GIT_COMMITTER_NAME: "rbox refwatch probe",
  GIT_COMMITTER_EMAIL: "refwatch-probe@local",
};

type ParcelSubscription = { unsubscribe(): Promise<void> };
type ParcelWatcher = {
  subscribe(
    root: string,
    callback: (error: Error | null, events: Array<{ path: string; type: string }>) => void,
    options?: object,
  ): Promise<ParcelSubscription>;
};

type RefEvent = {
  path: string;
  eventType: string;
  observedAt: number;
  root: string;
};

type AttemptResult = {
  callbackPath: string;
  latencyMs: number;
  churnOperations: number;
  parcelEvents: number;
  refValue: string;
};

type CaseResult = {
  case: string;
  result: "PASS" | "FAIL";
  attempts: string;
  callbackLatency: string;
  churnOps: number;
  parcelEvents: number;
  detail: string;
};

type Flood = {
  churnOperationCount(): number;
  parcelEventCount(): number;
  stop(): Promise<void>;
};

const parcel = require("@parcel/watcher") as ParcelWatcher;

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", repo, ...args], { env: GIT_ENV });
  return stdout.trim();
}

async function initRepo(repo: string, withCommit: boolean): Promise<void> {
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "--initial-branch=main", "--quiet");
  if (withCommit) await emptyCommit(repo, "seed");
}

async function emptyCommit(repo: string, message: string): Promise<void> {
  await git(repo, "commit", "--allow-empty", "--quiet", "-m", message);
}

/**
 * The proposed positive watch surface. A normal repository has gitDir ===
 * commonDir, so identical (path, recursive-mode) handles are deduplicated and
 * their shallow filters are combined, as the production registry would do.
 */
class RefWatchLayout {
  readonly events: RefEvent[] = [];
  readonly errors: string[] = [];
  readonly #handles = new Map<string, { watcher: FSWatcher; filters: Set<string> | null }>();

  constructor(
    readonly gitDir: string,
    readonly commonDir: string,
  ) {}

  arm(): void {
    const refs = path.join(this.commonDir, "refs");
    this.#attach(this.gitDir, false, ["HEAD", "HEAD.lock"]);
    this.#attach(this.commonDir, false, ["packed-refs", "packed-refs.lock", "refs"]);
    this.#attach(refs, false, ["stash", "stash.lock", "heads", "tags"]);
    this.#attach(path.join(refs, "heads"), true, null);
    this.#attach(path.join(refs, "tags"), true, null);
  }

  close(): void {
    for (const { watcher } of this.#handles.values()) watcher.close();
    this.#handles.clear();
  }

  waitForTarget(target: string, operationStartedAt: number): Promise<RefEvent> {
    const admitted = new Set([path.resolve(target), path.resolve(`${target}.lock`)]);
    const existing = this.events.find(
      (event) => event.observedAt >= operationStartedAt && admitted.has(event.path),
    );
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const poll = setInterval(() => {
        const event = this.events.find(
          (candidate) =>
            candidate.observedAt >= operationStartedAt && admitted.has(candidate.path),
        );
        if (event) {
          clearInterval(poll);
          clearTimeout(timeout);
          resolve(event);
        }
      }, 2);
      const timeout = setTimeout(() => {
        clearInterval(poll);
        const recent = this.events
          .slice(-8)
          .map((event) => path.relative(this.commonDir, event.path) || ".")
          .join(", ");
        reject(
          new Error(
            `no callback for ${path.relative(this.commonDir, target)} or its .lock within ${DEADLINE_MS}ms` +
              (recent ? `; recent admitted callbacks: ${recent}` : "; no admitted callbacks") +
              (this.errors.length ? `; watcher errors: ${this.errors.join(" | ")}` : ""),
          ),
        );
      }, DEADLINE_MS);
    });
  }

  #attach(root: string, recursive: boolean, acceptedNames: string[] | null): void {
    const key = `${root}\0${recursive ? "recursive" : "shallow"}`;
    const existing = this.#handles.get(key);
    if (existing) {
      if (existing.filters && acceptedNames) {
        for (const name of acceptedNames) existing.filters.add(name);
      }
      return;
    }

    const filters = acceptedNames ? new Set(acceptedNames) : null;
    const watcher = watch(root, { recursive, encoding: "utf8" }, (eventType, filename) => {
      if (filename === null) return;
      const relative = path.normalize(String(filename));
      // Shallow roots are positive surfaces, not blanket directory watches.
      if (filters && (relative.includes(path.sep) || !filters.has(relative))) return;

      this.events.push({
        path: path.resolve(root, relative),
        eventType,
        observedAt: performance.now(),
        root,
      });
    });
    watcher.on("error", (error) => this.errors.push(`${root}: ${error.message}`));
    this.#handles.set(key, { watcher, filters });
  }
}

async function startParcelFlood(tree: string): Promise<Flood> {
  await mkdir(tree, { recursive: true });
  let parcelEvents = 0;
  let churnOperations = 0;
  let parcelError: Error | undefined;
  let stopping = false;
  const subscription = await parcel.subscribe(tree, (error, events) => {
    if (error) parcelError = error;
    parcelEvents += events?.length ?? 0;
  });

  const churn = (async () => {
    let round = 0;
    while (!stopping) {
      const generation = path.join(tree, `generation-${round}`);
      await mkdir(generation, { recursive: true });
      churnOperations += 1;
      await Promise.all(
        Array.from({ length: 96 }, (_, index) =>
          writeFile(path.join(generation, `file-${index}.tmp`), `${round}:${index}\n`),
        ),
      );
      churnOperations += 96;
      await Promise.all(
        Array.from({ length: 24 }, (_, index) =>
          rename(
            path.join(generation, `file-${index}.tmp`),
            path.join(generation, `file-${index}.dat`),
          ),
        ),
      );
      churnOperations += 24;
      await Promise.all(
        Array.from({ length: 24 }, (_, index) =>
          unlink(path.join(generation, `file-${index + 24}.tmp`)),
        ),
      );
      churnOperations += 24;
      if (round >= 2) {
        await rm(path.join(tree, `generation-${round - 2}`), { recursive: true, force: true });
        churnOperations += 1;
      }
      round += 1;
      await delay(0);
    }
  })();

  return {
    churnOperationCount: () => churnOperations,
    parcelEventCount: () => parcelEvents,
    async stop() {
      stopping = true;
      await churn;
      // Let Parcel drain its native queue before measuring and unsubscribing.
      await delay(25);
      await subscription.unsubscribe();
      if (parcelError) throw parcelError;
    },
  };
}

async function withHarness(
  prepare: (root: string) => Promise<{ repo: string; beforeFlood?: () => Promise<void> }>,
  targetForRepo: (repo: string) => string,
  mutate: (repo: string) => Promise<{ target: string }>,
): Promise<AttemptResult> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rbox-bun-refwatch-"));
  let layout: RefWatchLayout | undefined;
  let flood: Flood | undefined;
  let parcelEvents = 0;
  try {
    const { repo, beforeFlood } = await prepare(root);
    const churnTree = path.join(root, "parcel-churn");
    flood = await startParcelFlood(churnTree);
    await beforeFlood?.();

    const gitDir = path.join(repo, ".git");
    const commonDir = gitDir;
    layout = new RefWatchLayout(gitDir, commonDir);
    layout.arm();
    await delay(20);

    const operationStartedAt = performance.now();
    // Register the deadline before the Git operation so lock-only callbacks count.
    const target = targetForRepo(repo);
    const eventPromise = layout.waitForTarget(target, operationStartedAt);
    const mutation = await mutate(repo);
    const event = await eventPromise;
    const refValue = (await readFile(mutation.target, "utf8")).trim();
    if (!/^[0-9a-f]{40,64}$/.test(refValue)) {
      throw new Error(`callback fired but ${mutation.target} did not contain a Git object id`);
    }

    await flood.stop();
    const churnOperations = flood.churnOperationCount();
    parcelEvents = flood.parcelEventCount();
    flood = undefined;
    if (parcelEvents === 0) throw new Error("Parcel subscription observed no churn events");

    return {
      callbackPath: path.relative(commonDir, event.path),
      latencyMs: event.observedAt - operationStartedAt,
      churnOperations,
      parcelEvents,
      refValue,
    };
  } finally {
    layout?.close();
    if (flood) {
      try {
        await flood.stop();
      } catch {
        // Preserve the primary failure; a successful path checks flood errors above.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function createNestedBranch(repo: string): Promise<{ target: string }> {
  const target = path.join(repo, ".git", "refs", "heads", "a", "b");
  await mkdir(path.dirname(target), { recursive: true });
  await delay(PARENT_TO_REF_DELAY_MS);
  await git(repo, "branch", "a/b");
  return { target };
}

const cases: Array<{
  name: string;
  run(): Promise<AttemptResult>;
}> = [
  {
    name: "fast git init -> empty commit",
    run: () =>
      withHarness(
        async (root) => {
          const repo = path.join(root, "workspace", "fast-init");
          return {
            repo,
            beforeFlood: () => initRepo(repo, false),
          };
        },
        (repo) => path.join(repo, ".git", "refs", "heads", "main"),
        async (repo) => {
          await emptyCommit(repo, "empty after fast init");
          return { target: path.join(repo, ".git", "refs", "heads", "main") };
        },
      ),
  },
  {
    name: "atomic move-in -> empty commit",
    run: () =>
      withHarness(
        async (root) => {
          const incoming = path.join(root, "incoming", "prebuilt");
          const repo = path.join(root, "workspace", "moved-repo");
          await initRepo(incoming, true);
          await mkdir(path.dirname(repo), { recursive: true });
          return {
            repo,
            beforeFlood: () => rename(incoming, repo),
          };
        },
        (repo) => path.join(repo, ".git", "refs", "heads", "main"),
        async (repo) => {
          await emptyCommit(repo, "empty after atomic move");
          return { target: path.join(repo, ".git", "refs", "heads", "main") };
        },
      ),
  },
  {
    name: "nested namespace refs/heads/a/b",
    run: () =>
      withHarness(
        async (root) => {
          const repo = path.join(root, "workspace", "nested-ref");
          await initRepo(repo, true);
          return { repo };
        },
        (repo) => path.join(repo, ".git", "refs", "heads", "a", "b"),
        createNestedBranch,
      ),
  },
];

async function runCase(testCase: (typeof cases)[number]): Promise<CaseResult> {
  const successes: AttemptResult[] = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      successes.push(await testCase.run());
    } catch (error) {
      return {
        case: testCase.name,
        result: "FAIL",
        attempts: `${attempt - 1}/${ATTEMPTS}`,
        callbackLatency: "-",
        churnOps: successes.reduce((sum, result) => sum + result.churnOperations, 0),
        parcelEvents: successes.reduce((sum, result) => sum + result.parcelEvents, 0),
        detail: `attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const latencies = successes.map((result) => result.latencyMs);
  const callbackKinds = [...new Set(successes.map((result) => result.callbackPath))].join(", ");
  return {
    case: testCase.name,
    result: "PASS",
    attempts: `${ATTEMPTS}/${ATTEMPTS}`,
    callbackLatency: `${Math.min(...latencies).toFixed(1)}-${Math.max(...latencies).toFixed(1)}ms`,
    churnOps: successes.reduce((sum, result) => sum + result.churnOperations, 0),
    parcelEvents: successes.reduce((sum, result) => sum + result.parcelEvents, 0),
    detail: callbackKinds,
  };
}

console.log(`bun --version: ${Bun.version}`);
console.log(`attempts per case: ${ATTEMPTS}; callback deadline: ${DEADLINE_MS}ms`);

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase));
console.table(results);

const failures = results.filter((result) => result.result === "FAIL");
if (failures.length > 0) {
  console.error(`Bun ref-watch contract FAILED (${failures.length}/${results.length} cases)`);
  process.exitCode = 1;
} else {
  console.log(`Bun ref-watch contract PASSED (${results.length}/${results.length} cases)`);
}
