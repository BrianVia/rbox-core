/**
 * The rig's single container-runtime seam. Public helpers keep the original
 * Apple-container signatures while dispatching argv and payload parsing through
 * one lazily selected backend (design 131).
 */
import { createHash } from "node:crypto";
import { NAMES } from "./config.js";

export type RunnerName = "apple-container" | "docker";
export type RunnerFlag = "container" | "docker";

export interface RunResult { stdout: string; stderr: string; exitCode: number }
export interface RunOpts {
  stdin?: string;
  allowFail?: boolean;
  redact?: string[];
  timeoutMs?: number;
}

export interface Mount {
  source: string;
  target: string;
  readonly?: boolean;
  type?: "bind" | "volume";
}

export interface StatsSample {
  name: string;
  ts: string;
  memBytes: number;
  /** Apple cumulative usec becomes an interval delta; Docker's instantaneous
   * percentage is integrated over elapsed sample intervals. */
  cpu: { kind: "cumulative-usec"; usec: number } | { kind: "instant-percent"; pct: number };
  runner: RunnerName;
}

export interface RunnerBackend {
  bin: "container" | "docker";
  name: RunnerName;
  verbs: {
    imageDelete: string[];
    networkList: string[];
    networkDelete: string[];
    psAll: string[];
    containerDelete: string[];
    volumeList: string[];
  };
  ensureRuntimeReady(): Promise<void>;
  parseInspectMounts(json: unknown): Array<{ source: string; target: string; type?: string; readonly?: boolean }>;
  parseStats(json: string): StatsSample[];
  createCmdOverride(): string[] | undefined;
  parseSpecLabel(inspectJson: unknown): string | undefined;
  systemStatus(): Promise<{ healthy: boolean; raw: string }>;
  systemStart(): Promise<void>;
  imageExists(tag: string): Promise<boolean>;
  networkExists(name: string): Promise<boolean>;
  networkCreateArgs(name: string): string[];
  containerExists(name: string): Promise<boolean>;
  listRigVolumes(): Promise<RigVolume[]>;
}

function redactArgv(argv: string[], secrets: string[] | undefined): string {
  let s = argv.join(" ");
  for (const sec of secrets ?? []) if (sec) s = s.split(sec).join("***");
  return s;
}

type SpawnCapture = (argv: string[], opts: RunOpts) => Promise<RunResult>;

const realSpawnCapture: SpawnCapture = async (argv, opts) => {
  const proc = Bun.spawn(argv, {
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs !== undefined) timer = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => { if (timer) clearTimeout(timer); });
  if (exitCode !== 0 && !opts.allowFail) {
    const tail = stderr.trim().split("\n").slice(-8).join("\n");
    throw new Error(`\`${redactArgv(argv, opts.redact)}\` exited ${exitCode}\n${tail}`);
  }
  return { stdout, stderr, exitCode };
};

let spawnCapture: SpawnCapture = realSpawnCapture;
/** Unit-test injection; passing undefined restores Bun.spawn. */
export function setSpawnCaptureForTests(fake?: SpawnCapture): void { spawnCapture = fake ?? realSpawnCapture; }

export async function spawnHost(argv: string[], opts: RunOpts = {}): Promise<RunResult> {
  return spawnCapture(argv, opts);
}

interface RuntimeConfigCandidate {
  mounts?: unknown;
  Mounts?: unknown;
  labels?: unknown;
  Labels?: unknown;
}

interface RuntimeRowCandidate extends RuntimeConfigCandidate {
  configuration?: unknown;
  Configuration?: unknown;
  Config?: unknown;
  name?: unknown;
  Name?: unknown;
  container?: unknown;
  Container?: unknown;
  memoryUsageBytes?: unknown;
  memory_usage_bytes?: unknown;
  memoryUsage?: unknown;
  cpuUsageUsec?: unknown;
  cpu_usage_usec?: unknown;
  cpuUsage?: unknown;
  ts?: unknown;
  MemUsage?: unknown;
  memUsage?: unknown;
  CPUPerc?: unknown;
  cpuPerc?: unknown;
  ID?: unknown;
  Names?: unknown;
  Reclaimable?: unknown;
  Size?: unknown;
  Type?: unknown;
}

interface RuntimeMountCandidate {
  source?: unknown;
  Source?: unknown;
  destination?: unknown;
  Destination?: unknown;
  target?: unknown;
  Target?: unknown;
  options?: unknown;
  Options?: unknown;
  type?: unknown;
  Type?: unknown;
  RW?: unknown;
}

type RuntimeLabelCandidate = Partial<Record<"rig.spec", unknown>>;

function parseNumber(o: RuntimeRowCandidate, keys: Array<keyof RuntimeRowCandidate>): number | undefined {
  for (const key of keys) {
    const v = o[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function rows(value: unknown): RuntimeRowCandidate[] {
  return (Array.isArray(value) ? value : [value]).filter((v): v is RuntimeRowCandidate => Boolean(v) && typeof v === "object");
}

function parseNdjson(text: string): RuntimeRowCandidate[] {
  const out: RuntimeRowCandidate[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const value: unknown = JSON.parse(trimmed);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runtime NDJSON row is not an object");
    out.push(value as RuntimeRowCandidate);
  }
  return out;
}

export function parseAppleInspectMounts(value: unknown): ReturnType<RunnerBackend["parseInspectMounts"]> {
  return rows(value).flatMap((row) => {
    const config = row.configuration ?? row.Configuration;
    const c = config && typeof config === "object" ? config as RuntimeConfigCandidate : {};
    const raw = c.mounts ?? c.Mounts ?? row.mounts ?? row.Mounts;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const m = candidate as RuntimeMountCandidate;
      const source = m.source ?? m.Source;
      const target = m.destination ?? m.Destination ?? m.target ?? m.Target;
      if (typeof source !== "string" || typeof target !== "string") return [];
      const options = Array.isArray(m.options) ? m.options : Array.isArray(m.Options) ? m.Options : [];
      return [{ source, target, type: typeof (m.type ?? m.Type) === "string" ? String(m.type ?? m.Type) : undefined, readonly: options.includes("ro") }];
    });
  });
}

export function parseDockerInspectMounts(value: unknown): ReturnType<RunnerBackend["parseInspectMounts"]> {
  return rows(value).flatMap((row) => {
    const raw = row.Mounts;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const m = candidate as RuntimeMountCandidate;
      if (typeof m.Source !== "string" || typeof m.Destination !== "string") return [];
      return [{ source: m.Source, target: m.Destination, type: typeof m.Type === "string" ? m.Type : undefined, readonly: m.RW === false }];
    });
  });
}

function labelMap(value: unknown, apple: boolean): RuntimeLabelCandidate | undefined {
  const row = rows(value)[0];
  if (!row) return undefined;
  if (apple) {
    const config = row.configuration ?? row.Configuration;
    const c = config && typeof config === "object" ? config as RuntimeConfigCandidate : row;
    const labels = c.labels ?? c.Labels ?? row.labels ?? row.Labels;
    return labels && typeof labels === "object" && !Array.isArray(labels) ? labels as RuntimeLabelCandidate : undefined;
  }
  const config = row.Config;
  if (!config || typeof config !== "object") return undefined;
  const labels = (config as RuntimeConfigCandidate).Labels;
  return labels && typeof labels === "object" && !Array.isArray(labels) ? labels as RuntimeLabelCandidate : undefined;
}

export function parseAppleSpecLabel(value: unknown): string | undefined {
  const label = labelMap(value, true)?.["rig.spec"];
  return typeof label === "string" ? label : undefined;
}
export function parseDockerSpecLabel(value: unknown): string | undefined {
  const label = labelMap(value, false)?.["rig.spec"];
  return typeof label === "string" ? label : undefined;
}

export function parseAppleStats(json: string, ts = new Date().toISOString()): StatsSample[] {
  const value: unknown = JSON.parse(json);
  return rows(value).flatMap((row) => {
    const name = row.name ?? row.Name ?? row.container ?? row.Container;
    const mem = parseNumber(row, ["memoryUsageBytes", "memory_usage_bytes", "memoryUsage"]);
    const cpu = parseNumber(row, ["cpuUsageUsec", "cpu_usage_usec", "cpuUsage"]);
    if (typeof name !== "string" || mem === undefined || cpu === undefined) return [];
    const sampleTs = typeof row.ts === "string" ? row.ts : ts;
    return [{ name, ts: sampleTs, memBytes: mem, cpu: { kind: "cumulative-usec" as const, usec: cpu }, runner: "apple-container" as const }];
  });
}

const MEMORY_UNITS: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
export function parseDockerMemoryUsage(value: string): number {
  const used = value.split("/")[0]?.trim() ?? "";
  const match = used.match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?i?B)$/i);
  if (!match) throw new Error(`unrecognized Docker MemUsage ${JSON.stringify(value)}`);
  return Number(match[1]) * MEMORY_UNITS[match[2]!.toUpperCase()]!;
}

export function parseDockerStats(json: string, ts = new Date().toISOString()): StatsSample[] {
  return parseNdjson(json).map((row) => {
    const name = row.Name ?? row.name;
    const mem = row.MemUsage ?? row.memUsage;
    const cpu = row.CPUPerc ?? row.cpuPerc;
    if (typeof name !== "string" || typeof mem !== "string" || typeof cpu !== "string") throw new Error("Docker stats row lacks Name/MemUsage/CPUPerc");
    const pct = Number(cpu.trim().replace(/%$/, ""));
    if (!Number.isFinite(pct)) throw new Error(`unrecognized Docker CPUPerc ${JSON.stringify(cpu)}`);
    return { name, ts, memBytes: parseDockerMemoryUsage(mem), cpu: { kind: "instant-percent" as const, pct }, runner: "docker" as const };
  });
}

const APPLE_VERBS: RunnerBackend["verbs"] = {
  imageDelete: ["image", "delete"], networkList: ["network", "list"], networkDelete: ["network", "delete"],
  psAll: ["ls", "--all"], containerDelete: ["delete", "--force"], volumeList: ["volume", "list"],
};
const DOCKER_VERBS: RunnerBackend["verbs"] = {
  imageDelete: ["image", "rm"], networkList: ["network", "ls"], networkDelete: ["network", "rm"],
  psAll: ["ps", "-a"], containerDelete: ["rm", "--force"], volumeList: ["volume", "ls"],
};

export async function dockerEndpoint(): Promise<string> {
  if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST.trim().replace(/^["']+|["']+$/g, "");
  const shown = await spawnCapture(["docker", "context", "show"], { allowFail: true, timeoutMs: 10_000 });
  if (shown.exitCode !== 0) throw new Error(`docker context show failed: ${(shown.stderr || shown.stdout).trim()}`);
  const name = shown.stdout.trim();
  const inspected = await spawnCapture(["docker", "context", "inspect", name, "--format", "{{json .Endpoints.docker.Host}}"], { allowFail: true, timeoutMs: 10_000 });
  if (inspected.exitCode !== 0) throw new Error(`docker context inspect failed: ${(inspected.stderr || inspected.stdout).trim()}`);
  let endpoint: string;
  try {
    endpoint = String(JSON.parse(inspected.stdout.trim()));
  } catch {
    endpoint = inspected.stdout.trim();
  }
  return endpoint.replace(/^["']+|["']+$/g, "");
}

export function isLocalDockerEndpoint(endpoint: string): boolean { return endpoint.startsWith("unix://"); }

export interface DockerInfo {
  ServerVersion?: unknown;
  OperatingSystem?: unknown;
  CgroupDriver?: unknown;
  CgroupVersion?: unknown;
  MemoryLimit?: unknown;
  CPUCfsQuota?: unknown;
  CpuCfsQuota?: unknown; // tolerate older/alternate API serializers
  DockerRootDir?: unknown;
  SecurityOptions?: unknown;
  ServerErrors?: unknown;
}
export async function dockerInfo(): Promise<DockerInfo> {
  const r = await run(["info", "--format", "{{json .}}"], { allowFail: true, timeoutMs: 15_000 });
  if (r.exitCode !== 0) throw new Error(`Docker daemon is unavailable: ${(r.stderr || r.stdout).trim()}`);
  const parsed: unknown = JSON.parse(r.stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("docker info returned a non-object payload");
  const info = parsed as DockerInfo;
  if (Array.isArray(info.ServerErrors) && info.ServerErrors.length > 0) {
    throw new Error(`Docker daemon is unavailable: ${String(info.ServerErrors[0])}`);
  }
  if (!info.ServerVersion) throw new Error("Docker daemon is unavailable: docker info returned no ServerVersion");
  return info;
}

export function dockerIsRootless(info: DockerInfo): boolean {
  return Array.isArray(info.SecurityOptions) && info.SecurityOptions.some((v) => typeof v === "string" && v.toLowerCase().includes("rootless"));
}
export function dockerHasCpuQuota(info: DockerInfo): boolean { return (info.CPUCfsQuota ?? info.CpuCfsQuota) === true; }

let markers: string[] = [];
export function runtimeMarkers(): readonly string[] { return markers; }
export async function assessRuntimeResourcePolicy(image: string): Promise<void> {
  markers = [];
  if (backend().name !== "docker") return;
  const info = await dockerInfo();
  if (!dockerIsRootless(info)) return;
  const basic = String(info.CgroupVersion) === "2" && info.MemoryLimit === true && dockerHasCpuQuota(info);
  const probe = basic
    ? await run(["run", "--rm", "--label", "rig=1", "--cpus", "0.25", "--memory", "64m", image, "sh", "-c", "test -r /sys/fs/cgroup/cgroup.controllers && grep -qw cpu /sys/fs/cgroup/cgroup.controllers && grep -qw memory /sys/fs/cgroup/cgroup.controllers && test \"$(cat /sys/fs/cgroup/memory.max)\" = 67108864 && test \"$(cut -d' ' -f1 /sys/fs/cgroup/cpu.max)\" != max"], { allowFail: true, timeoutMs: 30_000 })
    : { exitCode: 1 } as RunResult;
  if (!basic || probe.exitCode !== 0) markers = ["rootless-unvalidated"];
}

export async function runDockerDoctorProbe(repoRoot: string): Promise<RunResult> {
  if (backend().name !== "docker") throw new Error("Docker probe requested for Apple backend");
  // Anonymous single-shot `run --rm`: no name to collide with a stale probe container
  // (a named create/start/rm triplet raced the daemon's auto-remove in the field), and
  // the daemon owns cleanup even if we time out.
  return run(["run", "--rm", "--label", "rig=1", "--network", "bridge", "--mount", serializeMount({ source: repoRoot, target: "/checkout", readonly: true }, "docker"), NAMES.image, "sh", "-c", "test -r /checkout/package.json && getent hosts example.com >/dev/null"], { allowFail: true, timeoutMs: 30_000 });
}

const appleBackend: RunnerBackend = {
  bin: "container",
  name: "apple-container",
  verbs: APPLE_VERBS,
  async ensureRuntimeReady() {
    const status = await run(["system", "status"], { allowFail: true });
    if (status.exitCode === 0) return;
    await run(["system", "start"]);
    const recheck = await run(["system", "status"], { allowFail: true });
    if (recheck.exitCode !== 0) throw new Error(`container system unhealthy after start:\n${(recheck.stdout + recheck.stderr).trim()}`);
  },
  parseInspectMounts: parseAppleInspectMounts,
  parseStats: parseAppleStats,
  // Apple ignores the image ENTRYPOINT, so explicitly keep tini as PID 1. Its
  // zombie reaping prevents the production zombie-lock class the rig caught.
  createCmdOverride: () => ["/usr/bin/tini", "--", "sleep", "infinity"],
  parseSpecLabel: parseAppleSpecLabel,
  async systemStatus() {
    const r = await run(["system", "status"], { allowFail: true });
    return { healthy: r.exitCode === 0, raw: (r.stdout + r.stderr).trim() };
  },
  async systemStart() {
    await run(["system", "start"]);
  },
  async imageExists(tag) {
    const r = await run(["image", "ls", "--format", "json"], { allowFail: true });
    if (r.exitCode !== 0) return false;
    try {
      const stdout = JSON.stringify(JSON.parse(r.stdout));
      return stdout.includes(`"${tag}"`) || stdout.includes(`${tag}:latest`);
    } catch {
      return r.stdout.includes(tag);
    }
  },
  async networkExists(name) {
    const r = await run([...APPLE_VERBS.networkList, "--format", "json"], { allowFail: true });
    return r.exitCode === 0 && r.stdout.includes(`"${name}"`);
  },
  networkCreateArgs: (name) => ["network", "create", name],
  async containerExists(name) {
    const r = await run([...APPLE_VERBS.psAll, "--format", "json"], { allowFail: true });
    // Apple JSON is unstable pre-1.0; quoted substring matching defends against
    // command/label substrings impersonating the container name.
    return r.exitCode === 0 && r.stdout.includes(`"${name}"`);
  },
  async listRigVolumes() {
    const r = await run([...APPLE_VERBS.volumeList, "--format", "json"], { allowFail: true });
    if (r.exitCode !== 0) throw volumeListingError("container", r);
    try {
      const volumes: RigVolume[] = [];
      for (const row of rows(JSON.parse(r.stdout))) {
        const entry = Object.entries(row).find(([key, value]) => key.toLowerCase().includes("name") && typeof value === "string");
        if (!entry) throw new Error("Apple volume row lacks a string name field");
        const name = entry[1] as string;
        if (name.startsWith("rig-")) volumes.push({ name, size: "unknown" });
      }
      return uniqueVolumes(volumes);
    } catch (e) {
      throw volumeParseError("container", e);
    }
  },
};
const dockerBackend: RunnerBackend = {
  bin: "docker",
  name: "docker",
  verbs: DOCKER_VERBS,
  async ensureRuntimeReady() {
    const endpoint = await dockerEndpoint();
    if (!isLocalDockerEndpoint(endpoint)) throw new Error(`rig: refusing remote Docker context (${endpoint || "unknown endpoint"}); bind mounts must resolve on this checkout's host`);
    const info = await run(["info"], { allowFail: true, timeoutMs: 15_000 });
    if (info.exitCode !== 0) throw new Error(`Docker daemon is unavailable: ${(info.stderr || info.stdout).trim()}\nfix: start Docker, then check local socket permissions`);
  },
  parseInspectMounts: parseDockerInspectMounts,
  parseStats: parseDockerStats,
  createCmdOverride: () => undefined,
  parseSpecLabel: parseDockerSpecLabel,
  async systemStatus() {
    const r = await run(["info"], { allowFail: true, timeoutMs: 15_000 });
    return { healthy: r.exitCode === 0, raw: (r.stdout + r.stderr).trim() };
  },
  async systemStart() {},
  async imageExists(tag) {
    return (await run(["image", "inspect", tag], { allowFail: true })).exitCode === 0;
  },
  async networkExists(name) {
    const r = await run([...DOCKER_VERBS.networkList, "--filter", `name=^${name}$`, "--format", "json"], { allowFail: true });
    return r.exitCode === 0 && exactDockerRows(r.stdout, "Name", name);
  },
  networkCreateArgs: (name) => ["network", "create", "--label", "rig=1", name],
  async containerExists(name) {
    const r = await run([...DOCKER_VERBS.psAll, "--filter", `name=^/${name}$`, "--format", "json"], { allowFail: true });
    return r.exitCode === 0 && exactDockerRows(r.stdout, "Names", name);
  },
  async listRigVolumes() {
    const r = await run([...DOCKER_VERBS.volumeList, "--filter", "name=rig-", "--format", "json"], { allowFail: true });
    if (r.exitCode !== 0) throw volumeListingError("docker", r);
    try {
      const volumes = parseNdjson(r.stdout).map((row) => {
        if (typeof row.Name !== "string") throw new Error("Docker volume row lacks string Name");
        return { name: row.Name, size: typeof row.Size === "string" ? row.Size : "unknown" };
      }).filter((volume) => volume.name.startsWith("rig-"));
      return uniqueVolumes(volumes);
    } catch (e) {
      throw volumeParseError("docker", e);
    }
  },
};

export function resolveRunnerName(flag: string | undefined, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): RunnerName {
  const raw = flag ?? env.RBOX_RIG_RUNNER ?? (platform === "darwin" ? "container" : platform === "linux" ? "docker" : undefined);
  if (raw === "container" || raw === "apple-container") return "apple-container";
  if (raw === "docker") return "docker";
  throw new Error(`rig: unsupported runner ${JSON.stringify(raw)} (use container or docker)`);
}

let configuredFlag: string | undefined;
let selected: RunnerBackend | undefined;
export function configureRunner(flag?: string): RunnerName {
  const requested = resolveRunnerName(flag, process.env, process.platform);
  // A matching re-configure is benign (harness layers may both pin the same
  // runner; import order can lazily resolve first). Switching mid-flight stays fatal.
  if (selected) {
    if (selected.name !== requested) throw new Error("rig: runner already resolved");
    return requested;
  }
  configuredFlag = flag;
  return requested;
}
function backend(): RunnerBackend {
  if (!selected) selected = resolveRunnerName(configuredFlag, process.env, process.platform) === "docker" ? dockerBackend : appleBackend;
  return selected;
}
export function runnerName(): RunnerName { return backend().name; }
export function backendFor(name: RunnerName): RunnerBackend { return name === "docker" ? dockerBackend : appleBackend; }
export function resetRunnerForTests(): void {
  selected = undefined;
  configuredFlag = undefined;
  markers = [];
}

/** Runtime invocation choke point. */
export async function run(args: string[], opts: RunOpts = {}): Promise<RunResult> {
  return spawnCapture([backend().bin, ...args], opts).then((result) => {
    if (result.exitCode !== 0 && !opts.allowFail) {
      const tail = result.stderr.trim().split("\n").slice(-8).join("\n");
      throw new Error(`\`${redactArgv([backend().bin, ...args], opts.redact)}\` exited ${result.exitCode}\n${tail}`);
    }
    return result;
  });
}

export interface StreamHandle { readonly exited: Promise<number>; kill(signal?: number | string): void }
export interface StreamOpts { cwd?: string; onStdout?: (line: string) => void; onStderr?: (line: string) => void }
export function spawnStream(argv: string[], opts: StreamOpts = {}): StreamHandle {
  const proc = Bun.spawn(argv, { cwd: opts.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (opts.onStdout) void pumpLines(proc.stdout, opts.onStdout);
  if (opts.onStderr) void pumpLines(proc.stderr, opts.onStderr);
  return { exited: proc.exited, kill: (signal) => proc.kill(signal) };
}
async function pumpLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          onLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      if (done) {
        if (buf) onLine(buf);
        break;
      }
    }
  } catch { /* process killed */ }
}
export function streamContainerLogsArgv(name: string, runner: RunnerName = runnerName()): string[] { return [runner === "docker" ? "docker" : "container", "logs", "--follow", name]; }
export function streamContainerLogs(name: string, opts: StreamOpts = {}): StreamHandle { return spawnStream(streamContainerLogsArgv(name), opts); }

export async function ensureRuntimeReady(): Promise<void> { await backend().ensureRuntimeReady(); }
export function createCmdOverride(): string[] | undefined { return backend().createCmdOverride(); }
export async function containerStats(names: string[]): Promise<StatsSample[]> {
  const r = await run(["stats", "--format", "json", "--no-stream", ...names], { allowFail: true });
  if (r.exitCode !== 0) throw new Error(`${backend().bin} stats exited ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  return backend().parseStats(r.stdout);
}
export async function systemStatus(): Promise<{ healthy: boolean; raw: string }> {
  return backend().systemStatus();
}
export async function systemStart(): Promise<void> { await backend().systemStart(); }
export async function version(): Promise<string> {
  const r = await run(["--version"], { allowFail: true });
  return (r.stdout || r.stderr).trim();
}

export async function imageExists(tag: string): Promise<boolean> {
  return backend().imageExists(tag);
}
export interface BuildSpec { tag: string; dockerfile: string; contextDir: string; buildArgs?: Record<string, string>; labels?: Record<string, string> }
export function buildImageArgs(spec: BuildSpec): string[] {
  const args = ["build", "-t", spec.tag, "-f", spec.dockerfile];
  for (const [k, v] of Object.entries(spec.buildArgs ?? {})) args.push("--build-arg", `${k}=${v}`);
  const labels = { rig: "1", ...(spec.labels ?? {}) };
  for (const [k, v] of Object.entries(labels)) args.push("--label", `${k}=${v}`);
  args.push(spec.contextDir);
  return args;
}
export async function buildImage(spec: BuildSpec): Promise<void> { await run(buildImageArgs(spec)); }
export async function ensureImagePresent(spec: BuildSpec): Promise<boolean> {
  if (await imageExists(spec.tag)) return false;
  await buildImage(spec);
  return true;
}
export async function imageDelete(tag: string): Promise<boolean> { return (await run([...backend().verbs.imageDelete, tag], { allowFail: true })).exitCode === 0; }

function exactDockerRows(text: string, field: "Name" | "Names", name: string): boolean { return parseNdjson(text).some((row) => row[field] === name); }
export async function networkExists(name: string): Promise<boolean> {
  return backend().networkExists(name);
}
export async function networkCreate(name: string): Promise<void> {
  await run(backend().networkCreateArgs(name));
}
export async function networkDelete(name: string): Promise<boolean> { return (await run([...backend().verbs.networkDelete, name], { allowFail: true })).exitCode === 0; }

export async function containerExists(name: string): Promise<boolean> {
  return backend().containerExists(name);
}
export function inspectHasMounts(inspect: unknown, expected: readonly Mount[]): boolean {
  const mounts = backend().parseInspectMounts(inspect);
  // Container names are process-global but source mounts are worktree-local;
  // a source or target mismatch requires recreation.
  return expected.every((want) => mounts.some((m) => m.source === want.source && m.target === want.target));
}
export async function containerHasMounts(name: string, expected: readonly Mount[]): Promise<boolean> {
  const r = await run(["inspect", name], { allowFail: true });
  if (r.exitCode !== 0) return false;
  try {
    return inspectHasMounts(JSON.parse(r.stdout), expected);
  } catch {
    return false;
  }
}

export function serializeMount(m: Mount, runner: RunnerName): string {
  const parts: string[] = [];
  if (m.type) parts.push(`type=${m.type}`);
  else if (runner === "docker") parts.push("type=bind");
  parts.push(`source=${m.source}`, `target=${m.target}`);
  if (m.readonly) parts.push("readonly");
  return parts.join(",");
}
export interface CreateSpec { name: string; image: string; network: string; cpus: number; memory: string; mounts: Mount[]; env?: Record<string, string>; cmd?: string[]; imageHash?: string }
function normalizedCreateSpec(spec: CreateSpec, runner: RunnerName): unknown {
  const mounts = spec.mounts.map((m) => ({ type: m.type ?? "bind", source: m.source, target: m.target, readonly: Boolean(m.readonly) }))
    .sort((a, b) => `${a.type}\0${a.source}\0${a.target}`.localeCompare(`${b.type}\0${b.source}\0${b.target}`));
  return { name: spec.name, image: spec.image, network: spec.network, cpus: spec.cpus, memory: spec.memory, mounts, env: Object.fromEntries(Object.entries(spec.env ?? {}).sort(([a], [b]) => a.localeCompare(b))), cmd: spec.cmd ?? backendFor(runner).createCmdOverride() ?? [] };
}
export function createSpecHash(spec: CreateSpec, runner: RunnerName = runnerName()): string {
  return createHash("sha256").update(JSON.stringify({ runner, imageHash: spec.imageHash ?? "", create: normalizedCreateSpec(spec, runner) })).digest("hex");
}
export function createContainerArgs(spec: CreateSpec, runner: RunnerName = runnerName()): string[] {
  const args = ["create", "--name", spec.name, "--network", spec.network, "--cpus", String(spec.cpus), "--memory", spec.memory, "--label", "rig=1", "--label", `rig.spec=${createSpecHash(spec, runner)}`];
  for (const m of spec.mounts) args.push("--mount", serializeMount(m, runner));
  for (const [k, v] of Object.entries(spec.env ?? {})) args.push("-e", `${k}=${v}`);
  args.push(spec.image, ...(spec.cmd ?? backendFor(runner).createCmdOverride() ?? []));
  return args;
}
export async function createContainer(spec: CreateSpec): Promise<void> { await run(createContainerArgs(spec)); }
export async function containerHasSpec(name: string, spec: CreateSpec): Promise<boolean> {
  const r = await run(["inspect", name], { allowFail: true });
  if (r.exitCode !== 0) return false;
  try {
    return backend().parseSpecLabel(JSON.parse(r.stdout)) === createSpecHash(spec);
  } catch {
    return false;
  }
}
export async function startContainer(name: string): Promise<void> { await run(["start", name], { allowFail: true }); }
export async function stopContainer(name: string): Promise<void> { await run(["stop", name], { allowFail: true }); }
/** SIGKILL models a crash; stopContainer is the graceful-stop path. */
export async function killContainer(name: string): Promise<boolean> { return (await run(["kill", "--signal", "KILL", name], { allowFail: true })).exitCode === 0; }
export async function deleteContainer(name: string): Promise<boolean> { return (await run([...backend().verbs.containerDelete, name], { allowFail: true })).exitCode === 0; }
export interface ExecSpec { name: string; cmd: string[]; env?: Record<string, string>; cwd?: string; stdin?: string; allowFail?: boolean; redact?: string[] }
export async function exec(spec: ExecSpec): Promise<RunResult> {
  const args = ["exec"];
  if (spec.stdin !== undefined) args.push("-i");
  for (const [k, v] of Object.entries(spec.env ?? {})) args.push("-e", `${k}=${v}`);
  if (spec.cwd) args.push("-w", spec.cwd);
  args.push(spec.name, ...spec.cmd);
  return run(args, { stdin: spec.stdin, allowFail: spec.allowFail, redact: spec.redact });
}
export interface RigVolume { name: string; size: string }

function uniqueVolumes(volumes: RigVolume[]): RigVolume[] {
  return [...new Map(volumes.map((volume) => [volume.name, volume])).values()];
}

function volumeListingError(bin: RunnerBackend["bin"], result: RunResult): Error {
  return new Error(`${bin} volume listing failed: ${(result.stderr || result.stdout).trim()}`);
}

function volumeParseError(bin: RunnerBackend["bin"], error: unknown): Error {
  return new Error(`rig: cannot parse ${bin} volume listing: ${error instanceof Error ? error.message : String(error)}`);
}

/** Prefix identity is authoritative; labels are only an additional runtime signal. */
export async function listRigVolumes(): Promise<RigVolume[]> {
  return backend().listRigVolumes();
}
export async function volumeDelete(name: string): Promise<boolean> {
  if (!name.startsWith("rig-")) throw new Error(`rig: refusing to delete non-rig volume ${name}`);
  return (await run(["volume", "rm", name], { allowFail: true })).exitCode === 0;
}

export interface RigImage { id: string; size: string }
export async function rigDanglingImages(): Promise<RigImage[]> {
  if (backend().name !== "docker") return [];
  const r = await run(["image", "ls", "--filter", "dangling=true", "--filter", "label=rig=1", "--format", "json"], { allowFail: true });
  if (r.exitCode !== 0) throw new Error(`docker dangling-image listing failed: ${(r.stderr || r.stdout).trim()}`);
  try {
    return parseNdjson(r.stdout).map((row) => {
      if (typeof row.ID !== "string") throw new Error("Docker image row lacks ID");
      return { id: row.ID, size: typeof row.Size === "string" ? row.Size : "unknown" };
    });
  } catch (e) { throw new Error(`rig: cannot parse docker dangling-image listing: ${e instanceof Error ? e.message : String(e)}`); }
}
export async function removeDanglingRigImages(): Promise<RigImage[]> {
  const removed: RigImage[] = [];
  for (const image of await rigDanglingImages()) {
    if (!(await imageDelete(image.id))) throw new Error(`rig: failed to remove dangling rig image ${image.id}`);
    removed.push(image);
  }
  return removed;
}
export async function dockerBuilderDiskUsage(): Promise<string> {
  if (backend().name !== "docker") return "not applicable";
  const r = await run(["system", "df", "--format", "json"], { allowFail: true, timeoutMs: 15_000 });
  if (r.exitCode !== 0) return `unavailable: ${(r.stderr || r.stdout).trim()}`;
  try {
    const build = parseNdjson(r.stdout).find((row) => typeof row.Type === "string" && row.Type.toLowerCase().includes("build"));
    if (!build) return "0 B (no build-cache row)";
    return `${String(build.Size ?? "unknown")} total · ${String(build.Reclaimable ?? "unknown")} reclaimable`;
  } catch (e) { return `unavailable: ${e instanceof Error ? e.message : String(e)}`; }
}
export { NAMES };
