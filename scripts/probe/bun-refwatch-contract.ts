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
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createWrapper } from "@parcel/watcher/wrapper";

const exec = promisify(execFile);
const ATTEMPTS = positiveInt(process.env.RBOX_REFWATCH_PROBE_ATTEMPTS, 5);
const DEADLINE_MS = 5_000;
const PARCEL_MIN_EVENTS = 100;
const PARCEL_DIRECTORY_COUNT = 16;
const PARCEL_FILES_PER_ROUND = 192;
const PARCEL_OVERLAP_FILES = 4_096;
const PARCEL_OVERLAP_MIN_MS = 50;
const ROOT_REUSE_LIMIT = 10_000;
const COMPILED_CHILD_ENV = "RBOX_REFWATCH_PROBE_COMPILED_CHILD";
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
  parcelEvents: string;
  detail: string;
};

type Flood = {
  churnOperationCount(): number;
  parcelEventCount(): number;
  startOverlapBurst(): { completed(): boolean; done: Promise<void> };
  waitForPressure(): Promise<void>;
  waitForPressureSince(baseline: number, startedAt: number): Promise<void>;
  stop(): Promise<void>;
};

type RawWatchEvent = {
  eventType: string;
  filename: string | null;
  observedAt: number;
};

function loadHostParcelBinding(): unknown {
  const key = `${process.platform}-${process.arch}`;
  switch (key) {
    case "darwin-arm64":
      return require("@parcel/watcher-darwin-arm64");
    case "linux-x64":
      return require("@parcel/watcher-linux-x64-glibc");
    case "linux-arm64":
      return require("@parcel/watcher-linux-arm64-glibc");
    default:
      throw new Error(`no @parcel/watcher native binding for ${key}`);
  }
}

const parcel = createWrapper(loadHostParcelBinding()) as ParcelWatcher;

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  condition: () => boolean,
  failure: () => string,
  timeoutMs = DEADLINE_MS,
): Promise<void> {
  const startedAt = performance.now();
  while (!condition()) {
    if (performance.now() - startedAt >= timeoutMs) throw new Error(failure());
    await delay(5);
  }
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
      if (filename === null || filename === undefined) return;
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
  const directories = Array.from({ length: PARCEL_DIRECTORY_COUNT }, (_, index) =>
    path.join(tree, `watched-${index}`),
  );
  await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })));

  let parcelEvents = 0;
  const parcelDeliveryTimes: number[] = [];
  let parcelEventsBeforeFlood = 0;
  let churnOperations = 0;
  let parcelError: Error | undefined;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let baselineObserved = false;
  let overlapBurst = 0;
  const baseline = path.join(directories[0]!, "baseline.txt");
  const subscription = await parcel.subscribe(tree, (error, events) => {
    if (error) parcelError = error;
    parcelEvents += events?.length ?? 0;
    const observedAt = performance.now();
    for (let index = 0; index < (events?.length ?? 0); index += 1) {
      parcelDeliveryTimes.push(observedAt);
    }
    if (events?.some((event) => path.resolve(event.path) === path.resolve(baseline))) {
      baselineObserved = true;
    }
  });

  try {
    await writeFile(baseline, "baseline\n");
    await waitFor(
      () => baselineObserved || parcelError !== undefined,
      () => "Parcel subscription did not deliver the baseline child event",
    );
    if (parcelError) throw parcelError;
    parcelEventsBeforeFlood = parcelEvents;
  } catch (error) {
    await subscription.unsubscribe();
    throw error;
  }

  const churn = (async () => {
    let round = 0;
    while (!stopping) {
      const files = Array.from({ length: PARCEL_FILES_PER_ROUND }, (_, index) =>
        path.join(
          directories[index % directories.length]!,
          `round-${round}-file-${index}.tmp`,
        ),
      );
      await Promise.all(files.map((file, index) => writeFile(file, `${round}:${index}\n`)));
      churnOperations += files.length;
      await delay(5);

      const renamed = files.slice(0, 64).map((file) => file.replace(/\.tmp$/, ".dat"));
      await Promise.all(
        files.slice(0, renamed.length).map((file, index) => rename(file, renamed[index]!)),
      );
      churnOperations += renamed.length;
      await delay(5);

      await Promise.all([...renamed, ...files.slice(renamed.length)].map((file) => unlink(file)));
      churnOperations += files.length;
      round += 1;
      await delay(0);
    }
  })();

  return {
    churnOperationCount: () => churnOperations,
    parcelEventCount: () => parcelEvents - parcelEventsBeforeFlood,
    startOverlapBurst() {
      const burst = overlapBurst;
      overlapBurst += 1;
      let complete = false;
      const files = Array.from({ length: PARCEL_OVERLAP_FILES }, (_, index) =>
        path.join(
          directories[index % directories.length]!,
          `overlap-${burst}-file-${index}.tmp`,
        ),
      );
      const startedAt = performance.now();
      const done = (async () => {
        for (let offset = 0; offset < files.length; offset += 64) {
          const batch = files.slice(offset, offset + 64);
          await Promise.all(
            batch.map((file, index) => writeFile(file, `overlap:${burst}:${offset + index}\n`)),
          );
          churnOperations += batch.length;
          await delay(0);
        }
        while (performance.now() - startedAt < PARCEL_OVERLAP_MIN_MS) {
          const batch = files.slice(0, 64);
          await Promise.all(
            batch.map((file, index) => writeFile(file, `overlap:${burst}:tail:${index}\n`)),
          );
          churnOperations += batch.length;
          await delay(0);
        }
        complete = true;
      })();
      return { completed: () => complete, done };
    },
    waitForPressure: () =>
      waitFor(
        () => parcelEvents - parcelEventsBeforeFlood >= PARCEL_MIN_EVENTS || parcelError !== undefined,
        () =>
          `Parcel delivered ${parcelEvents - parcelEventsBeforeFlood} flood events; expected at least ${PARCEL_MIN_EVENTS}`,
      ).then(() => {
        if (parcelError) throw parcelError;
      }),
    waitForPressureSince: (baseline, startedAt) => {
      const targetIndex = parcelEventsBeforeFlood + baseline + PARCEL_MIN_EVENTS - 1;
      return waitFor(
        () => {
          if (parcelError) return true;
          const deliveredAt = parcelDeliveryTimes[targetIndex];
          if (deliveredAt === undefined) return false;
          if (deliveredAt - startedAt > DEADLINE_MS) {
            throw new Error(
              `Parcel's ${PARCEL_MIN_EVENTS}th additional event arrived after the ref deadline`,
            );
          }
          return true;
        },
        () =>
          `Parcel delivered ${parcelEvents - parcelEventsBeforeFlood - baseline} events during the ref deadline; expected at least ${PARCEL_MIN_EVENTS}`,
        Math.max(1, DEADLINE_MS - (performance.now() - startedAt)),
      ).then(() => {
        if (parcelError) throw parcelError;
      });
    },
    stop() {
      stopPromise ??= (async () => {
        stopping = true;
        await churn;
        // Let Parcel drain its native queue before measuring and unsubscribing.
        await delay(25);
        await subscription.unsubscribe();
        if (parcelError) throw parcelError;
      })();
      return stopPromise;
    },
  };
}

async function withHarness(
  prepare: (root: string) => Promise<{ repo: string; beforeFlood?: () => Promise<void> }>,
  mutate: (
    repo: string,
    layout: RefWatchLayout,
    flood: Flood,
  ) => Promise<{ target: string; event: RefEvent; operationStartedAt: number }>,
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
    await flood.waitForPressure();

    const mutation = await mutate(repo, layout, flood);
    const { event, operationStartedAt } = mutation;
    const refValue = (await readFile(mutation.target, "utf8")).trim();
    if (!/^[0-9a-f]{40,64}$/.test(refValue)) {
      throw new Error(`callback fired but ${mutation.target} did not contain a Git object id`);
    }

    await flood.stop();
    const churnOperations = flood.churnOperationCount();
    parcelEvents = flood.parcelEventCount();
    flood = undefined;
    if (parcelEvents < PARCEL_MIN_EVENTS) {
      throw new Error(
        `Parcel delivered ${parcelEvents} flood events; expected at least ${PARCEL_MIN_EVENTS}`,
      );
    }

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

async function observeMutation(
  layout: RefWatchLayout,
  flood: Flood,
  target: string,
  mutate: () => Promise<void>,
): Promise<{ target: string; event: RefEvent; operationStartedAt: number }> {
  const operationStartedAt = performance.now();
  // Register the deadline before the operation so lock-only callbacks count.
  const eventPromise = layout.waitForTarget(target, operationStartedAt);
  const parcelBaseline = flood.parcelEventCount();
  const parcelPressure = flood.waitForPressureSince(parcelBaseline, operationStartedAt);
  const overlap = flood.startOverlapBurst();
  await mutate();
  const event = await eventPromise;
  if (overlap.completed()) {
    throw new Error("Parcel overlap burst completed before the Bun ref callback");
  }
  await parcelPressure;
  await overlap.done;
  return { target, event, operationStartedAt };
}

async function movePopulatedRefSubtree(
  repo: string,
  layout: RefWatchLayout,
  flood: Flood,
): Promise<{ target: string; event: RefEvent; operationStartedAt: number }> {
  const gitDir = path.join(repo, ".git");
  const stagedTop = path.join(gitDir, "ref-stage", "x");
  const stagedDeepest = path.join(stagedTop, "y", "z", "deepest");
  const stagedSibling = path.join(stagedTop, "y", "z", "already-present");
  const liveTop = path.join(gitDir, "refs", "heads", "x");
  const target = path.join(liveTop, "y", "z", "deepest");
  const originalOid = await git(repo, "rev-parse", "HEAD");

  await mkdir(path.dirname(stagedDeepest), { recursive: true });
  await Promise.all([
    writeFile(stagedDeepest, `${originalOid}\n`),
    writeFile(stagedSibling, `${originalOid}\n`),
  ]);
  await emptyCommit(repo, "oid for populated descendant mutation");
  const replacementOid = await git(repo, "rev-parse", "HEAD");

  const moveStartedAt = performance.now();
  const moveObserved = layout.waitForTarget(liveTop, moveStartedAt);
  await rename(stagedTop, liveTop);
  await moveObserved;

  return observeMutation(layout, flood, target, () => writeFile(target, `${replacementOid}\n`));
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
        async (repo, layout, flood) => {
          const target = path.join(repo, ".git", "refs", "heads", "main");
          return observeMutation(layout, flood, target, () =>
            emptyCommit(repo, "empty after fast init"),
          );
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
        async (repo, layout, flood) => {
          const target = path.join(repo, ".git", "refs", "heads", "main");
          return observeMutation(layout, flood, target, () =>
            emptyCommit(repo, "empty after atomic move"),
          );
        },
      ),
  },
  {
    name: "populated ref subtree move-in",
    run: () =>
      withHarness(
        async (root) => {
          const repo = path.join(root, "workspace", "nested-ref");
          await initRepo(repo, true);
          return { repo };
        },
        movePopulatedRefSubtree,
      ),
  },
];

function formatRawEvents(events: RawWatchEvent[]): string {
  if (events.length === 0) return "none";
  return events.map((event) => `${event.eventType}/${event.filename ?? "<null>"}`).join(", ");
}

async function reportRootReplacement(): Promise<void> {
  // Use the worktree filesystem: inode reuse is allocator/filesystem-dependent,
  // and the dead-handle counterexample under review was observed here rather than on tmpfs.
  const root = await mkdtemp(path.join(process.cwd(), ".rbox-bun-refwatch-replace-"));
  const refs = path.join(root, "refs");
  const events: RawWatchEvent[] = [];
  let watcher: FSWatcher | undefined;
  let watcherError: Error | undefined;

  try {
    await mkdir(path.join(refs, "heads"), { recursive: true });
    const original = await stat(refs, { bigint: true });
    watcher = watch(refs, { recursive: true, encoding: "utf8" }, (eventType, filename) => {
      events.push({
        eventType,
        filename: filename === null || filename === undefined ? null : String(filename),
        observedAt: performance.now(),
      });
    });
    watcher.on("error", (error) => {
      watcherError = error;
    });
    await delay(20);

    const baseline = path.join(refs, "heads", "baseline");
    await writeFile(baseline, `${"b".repeat(40)}\n`);
    await waitFor(
      () =>
        events.some((event) => event.filename === path.join("heads", "baseline")) ||
        watcherError !== undefined,
      () => "recursive root watch did not deliver its baseline child event",
    );
    if (watcherError) throw watcherError;
    await unlink(baseline);
    await rm(path.join(refs, "heads"), { recursive: true, force: true });
    await delay(50);
    events.length = 0;

    const removalStartedAt = performance.now();
    await rm(refs, { recursive: true, force: true });
    try {
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.observedAt >= removalStartedAt &&
              event.eventType === "rename" &&
              event.filename === null,
          ) || watcherError !== undefined,
        () => `root removal produced no rename/<null> callback within ${DEADLINE_MS}ms`,
      );
    } catch {
      // Report the observed removal behavior below; this case never controls PASS/FAIL.
    }
    await delay(25);
    const removalEvents = events.filter((event) => event.observedAt >= removalStartedAt);
    events.length = 0;

    let reuseAttempt = 0;
    let reused = false;
    while (reuseAttempt < ROOT_REUSE_LIMIT) {
      reuseAttempt += 1;
      await mkdir(refs);
      const replacement = await stat(refs, { bigint: true });
      if (replacement.dev === original.dev && replacement.ino === original.ino) {
        reused = true;
        break;
      }
      await rename(refs, path.join(root, `parked-${reuseAttempt}`));
    }

    if (!reused) {
      console.log(
        `root replacement REPORT INCONCLUSIVE: original tuple=(${original.dev},${original.ino}); ` +
          `not reused after ${ROOT_REUSE_LIMIT} recreations; removal callbacks=${formatRawEvents(removalEvents)}`,
      );
      return;
    }

    const recreatedAt = performance.now();
    await mkdir(path.join(refs, "heads"));
    await writeFile(path.join(refs, "heads", "main"), `${"a".repeat(40)}\n`);
    await delay(DEADLINE_MS);
    const replacementEvents = events.filter((event) => event.observedAt >= recreatedAt);
    console.log(
      `root replacement REPORT: tuple=(${original.dev},${original.ino}) reused after ` +
        `${reuseAttempt} recreation(s); removal callbacks within ${DEADLINE_MS}ms=${formatRawEvents(removalEvents)}; ` +
        `post-recreate callbacks within ${DEADLINE_MS}ms=${formatRawEvents(replacementEvents)}; ` +
        `expected=rename/<null> then none`,
    );
  } catch (error) {
    console.log(
      `root replacement REPORT INCONCLUSIVE: observation error=${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    watcher?.close();
    await rm(root, { recursive: true, force: true });
  }
}

function numericRange(values: number[]): string {
  if (values.length === 0) return "-";
  return `${Math.min(...values)}-${Math.max(...values)}`;
}

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
        parcelEvents: numericRange(successes.map((result) => result.parcelEvents)),
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
    parcelEvents: numericRange(successes.map((result) => result.parcelEvents)),
    detail: callbackKinds,
  };
}

async function runCompiledProbe(): Promise<void> {
  const compileRoot = await mkdtemp(path.join(os.tmpdir(), "rbox-bun-refwatch-compiled-"));
  const binary = path.join(compileRoot, "bun-refwatch-contract");
  try {
    await exec(
      process.execPath,
      ["build", fileURLToPath(import.meta.url), "--compile", "--outfile", binary],
      { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
    );
    const compiled = await exec(binary, [], {
      cwd: process.cwd(),
      env: { ...process.env, [COMPILED_CHILD_ENV]: "1" },
      maxBuffer: 10 * 1024 * 1024,
    });
    process.stdout.write(compiled.stdout);
    process.stderr.write(compiled.stderr);
    if (!compiled.stdout.includes("Bun ref-watch contract PASSED (3/3 cases)")) {
      throw new Error("compiled probe exited without the required 3/3 PASS marker");
    }
    console.log("Compiled execution PASSED (3/3 cases)");
  } finally {
    await rm(compileRoot, { recursive: true, force: true });
  }
}

const compiledChild = process.env[COMPILED_CHILD_ENV] === "1";
console.log(`bun --version: ${Bun.version}`);
console.log(`execution mode: ${compiledChild ? "compiled" : "source"}`);
console.log(`attempts per case: ${ATTEMPTS}; callback deadline: ${DEADLINE_MS}ms`);

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase));
console.table(results);
await reportRootReplacement();

const failures = results.filter((result) => result.result === "FAIL");
if (failures.length > 0) {
  console.error(`Bun ref-watch contract FAILED (${failures.length}/${results.length} cases)`);
  process.exitCode = 1;
} else {
  console.log(`Bun ref-watch contract PASSED (${results.length}/${results.length} cases)`);
  if (!compiledChild) await runCompiledProbe();
}
