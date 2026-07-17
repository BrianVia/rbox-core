const API_VERSION = "2022-11-28";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 10_000;

export interface WorkflowRun {
  id: number;
  event: string;
  head_branch: string | null;
  head_sha: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
}

export interface WorkflowRunPage {
  total_count: number;
  workflow_runs: WorkflowRun[];
}

export type GateState =
  | { kind: "success"; run: WorkflowRun }
  | { kind: "active"; runs: WorkflowRun[] }
  | { kind: "failure"; runs: WorkflowRun[] }
  | { kind: "none" };

export class TransientGitHubApiError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

export function classifyRuns(page: WorkflowRunPage, sha: string): GateState {
  if (!Number.isSafeInteger(page.total_count) || page.total_count < 0 || !Array.isArray(page.workflow_runs)) {
    throw new Error("GitHub workflow-runs response is malformed");
  }
  if (page.total_count > page.workflow_runs.length) {
    throw new Error(`GitHub returned ${page.total_count} exact-SHA CI runs but only ${page.workflow_runs.length} records; refusing an incomplete verdict`);
  }

  const qualifying = page.workflow_runs.filter((run) => {
    if (!run || typeof run.id !== "number" || typeof run.event !== "string" || typeof run.head_sha !== "string" || typeof run.status !== "string") {
      throw new Error("GitHub workflow run record is malformed");
    }
    return run.event === "push" && run.head_branch === "main" && run.head_sha === sha;
  });
  const success = qualifying.find((run) => run.status === "completed" && run.conclusion === "success");
  if (success) return { kind: "success", run: success };

  // GitHub has added statuses over time. Anything other than the terminal
  // `completed` status is conservatively treated as still active.
  const active = qualifying.filter((run) => run.status !== "completed");
  if (active.length > 0) return { kind: "active", runs: active };
  if (qualifying.length > 0) return { kind: "failure", runs: qualifying };
  return { kind: "none" };
}

export async function fetchMainCiRuns(opts: {
  repository: string;
  sha: string;
  token: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<WorkflowRunPage> {
  const [owner, repo, extra] = opts.repository.split("/");
  if (!owner || !repo || extra) throw new Error(`invalid GITHUB_REPOSITORY: ${opts.repository}`);
  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/ci.yml/runs`);
  url.searchParams.set("head_sha", opts.sha);
  url.searchParams.set("event", "push");
  url.searchParams.set("branch", "main");
  url.searchParams.set("per_page", "100");

  const response = await (opts.fetchImpl ?? fetch)(url, {
    signal: opts.signal,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${opts.token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "rbox-release-ci-gate",
    },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 512);
    const message = `GitHub workflow-runs API returned ${response.status}${detail ? `: ${detail}` : ""}`;
    if (response.status === 429 || response.status >= 500) {
      const retryHeader = response.headers.get("retry-after");
      const retrySeconds = retryHeader !== null && retryHeader.trim() !== "" ? Number(retryHeader) : Number.NaN;
      throw new TransientGitHubApiError(message, Number.isFinite(retrySeconds) && retrySeconds >= 0 ? retrySeconds * 1000 : undefined);
    }
    throw new Error(message);
  }
  return await response.json() as WorkflowRunPage;
}

export async function waitForMainCi(opts: {
  sha: string;
  fetchRuns: (signal: AbortSignal) => Promise<WorkflowRunPage>;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}): Promise<WorkflowRun> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const log = opts.log ?? console.log;
  const deadline = now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

  while (true) {
    const beforeAttempt = deadline - now();
    if (beforeAttempt <= 0) throw new Error(`timed out waiting for successful main CI on ${opts.sha}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), beforeAttempt);
    try {
      const state = classifyRuns(await opts.fetchRuns(controller.signal), opts.sha);
      if (state.kind === "success") return state.run;
      if (state.kind === "failure") {
        const outcomes = state.runs.map((run) => `${run.id}:${run.conclusion ?? "missing-conclusion"}`).join(", ");
        throw new Error(`exact-SHA main CI completed without success (${outcomes})`);
      }
      log(state.kind === "active"
        ? `exact-SHA main CI is still active (${state.runs.map((run) => `${run.id}:${run.status}`).join(", ")})`
        : "waiting for exact-SHA main CI run to appear");
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`timed out waiting for successful main CI on ${opts.sha}`);
      if (!(error instanceof TransientGitHubApiError)) throw error;
      log(`${error.message}; retrying`);
      const remaining = deadline - now();
      if (remaining <= 0) throw new Error("timed out waiting for exact-SHA main CI after transient GitHub API failures");
      await sleep(Math.min(error.retryAfterMs ?? pollMs, remaining));
      continue;
    } finally {
      clearTimeout(timeout);
    }

    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`timed out waiting for successful main CI on ${opts.sha}`);
    await sleep(Math.min(pollMs, remaining));
  }
}

function checkedEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const sha = checkedEnv("GITHUB_SHA");
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`GITHUB_SHA is not a full commit SHA: ${sha}`);
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  if (head.exitCode !== 0) throw new Error(`git rev-parse HEAD failed: ${head.stderr.toString().trim()}`);
  const checkedOutSha = head.stdout.toString().trim();
  if (checkedOutSha !== sha) throw new Error(`checked-out HEAD ${checkedOutSha} != tagged GITHUB_SHA ${sha}`);

  const repository = checkedEnv("GITHUB_REPOSITORY");
  const token = checkedEnv("GITHUB_TOKEN");
  const run = await waitForMainCi({
    sha,
    fetchRuns: (signal) => fetchMainCiRuns({ repository, sha, token, signal }),
  });
  console.log(`exact-SHA main CI passed: ${run.html_url ?? run.id}`);
}

if (import.meta.main) {
  await main();
}
