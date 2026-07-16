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
  cpu: { kind: "cumulative-usec"; usec: number } | { kind: "instant-percent"; pct: number };
  runner: RunnerName;
}

export interface DoctorCheck { id: string; label: string }

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
  doctorChecks(): DoctorCheck[];
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

function parseNumber(o: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const v = o[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function rows(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : [value]).filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object");
}

function parseNdjson(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const value: unknown = JSON.parse(trimmed);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runtime NDJSON row is not an object");
    out.push(value as Record<string, unknown>);
  }
  return out;
}

export function parseAppleInspectMounts(value: unknown): ReturnType<RunnerBackend["parseInspectMounts"]> {
  return rows(value).flatMap((row) => {
    const config = row.configuration ?? row.Configuration;
    const c = config && typeof config === "object" ? config as Record<string, unknown> : {};
    const raw = c.mounts ?? c.Mounts ?? row.mounts ?? row.Mounts;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const m = candidate as Record<string, unknown>;
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
      const m = candidate as Record<string, unknown>;
      if (typeof m.Source !== "string" || typeof m.Destination !== "string") return [];
      return [{ source: m.Source, target: m.Destination, type: typeof m.Type === "string" ? m.Type : undefined, readonly: m.RW === false }];
    });
  });
}

function labelMap(value: unknown, apple: boolean): Record<string, unknown> | undefined {
  const row = rows(value)[0];
  if (!row) return undefined;
  if (apple) {
    const config = row.configuration ?? row.Configuration;
    const c = config && typeof config === "object" ? config as Record<string, unknown> : row;
    const labels = c.labels ?? c.Labels ?? row.labels ?? row.Labels;
    return labels && typeof labels === "object" && !Array.isArray(labels) ? labels as Record<string, unknown> : undefined;
  }
  const config = row.Config;
  if (!config || typeof config !== "object") return undefined;
  const labels = (config as Record<string, unknown>).Labels;
  return labels && typeof labels === "object" && !Array.isArray(labels) ? labels as Record<string, unknown> : undefined;
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

const APPLE_DOCTOR: DoctorCheck[] = [
  { id: "macos-version", label: "macOS >= 26" }, { id: "arm64", label: "arch arm64" },
  { id: "runtime-version", label: "container CLI present" }, { id: "runtime-ready", label: "container system running" },
  { id: "disk-headroom", label: "runs/cache disk headroom" },
];
const DOCKER_DOCTOR: DoctorCheck[] = [
  { id: "docker-info", label: "Docker server capabilities" }, { id: "local-context", label: "Docker context is local" },
  { id: "docker-disk", label: "Docker/runs/cache disk space" }, { id: "docker-probe", label: "Docker bind/network probe" },
  { id: "builder-cache", label: "Docker builder cache size" }, { id: "rootless-policy", label: "rootless resource-limit policy" },
];

const APPLE_VERBS: RunnerBackend["verbs"] = {
  imageDelete: ["image", "delete"], networkList: ["network", "list"], networkDelete: ["network", "delete"],
  psAll: ["ls", "--all"], containerDelete: ["delete", "--force"], volumeList: ["volume", "list"],
};
const DOCKER_VERBS: RunnerBackend["verbs"] = {
  imageDelete: ["image", "rm"], networkList: ["network", "ls"], networkDelete: ["network", "rm"],
  psAll: ["ps", "-a"], containerDelete: ["rm", "--force"], volumeList: ["volume", "ls"],
};

export async function dockerEndpoint(): Promise<string> {
  if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST;
  const shown = await spawnCapture(["docker", "context", "show"], { allowFail: true, timeoutMs: 10_000 });
  if (shown.exitCode !== 0) throw new Error(`docker context show failed: ${(shown.stderr || shown.stdout).trim()}`);
  const name = shown.stdout.trim();
  const inspected = await spawnCapture(["docker", "context", "inspect", name, "--format", "{{json .Endpoints.docker.Host}}"], { allowFail: true, timeoutMs: 10_000 });
  if (inspected.exitCode !== 0) throw new Error(`docker context inspect failed: ${(inspected.stderr || inspected.stdout).trim()}`);
  try { return String(JSON.parse(inspected.stdout.trim())); } catch { return inspected.stdout.trim().replace(/^"|"$/g, ""); }
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
}
export async function dockerInfo(): Promise<DockerInfo> {
  const r = await run(["info", "--format", "{{json .}}"], { allowFail: true, timeoutMs: 15_000 });
  if (r.exitCode !== 0) throw new Error(`Docker daemon is unavailable: ${(r.stderr || r.stdout).trim()}`);
  const parsed: unknown = JSON.parse(r.stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("docker info returned a non-object payload");
  return parsed as DockerInfo;
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
  const name = `rig-doctor-${process.pid}`;
  try {
    const created = await run(["create", "--name", name, "--label", "rig=1", "--network", "bridge", "--mount", serializeMount({ source: repoRoot, target: "/checkout", readonly: true }, "docker"), NAMES.image, "sh", "-c", "test -r /checkout/package.json && getent hosts example.com >/dev/null"], { allowFail: true, timeoutMs: 30_000 });
    if (created.exitCode !== 0) return created;
    return run(["start", "--attach", name], { allowFail: true, timeoutMs: 30_000 });
  } finally {
    await run(["rm", "--force", name], { allowFail: true, timeoutMs: 10_000 });
  }
}

const appleBackend: RunnerBackend = {
  bin: "container", name: "apple-container", verbs: APPLE_VERBS,
  async ensureRuntimeReady() {
    const status = await run(["system", "status"], { allowFail: true });
    if (status.exitCode === 0) return;
    await run(["system", "start"]);
    const recheck = await run(["system", "status"], { allowFail: true });
    if (recheck.exitCode !== 0) throw new Error(`container system unhealthy after start:\n${(recheck.stdout + recheck.stderr).trim()}`);
  },
  parseInspectMounts: parseAppleInspectMounts, parseStats: parseAppleStats,
  createCmdOverride: () => ["/usr/bin/tini", "--", "sleep", "infinity"],
  parseSpecLabel: parseAppleSpecLabel, doctorChecks: () => APPLE_DOCTOR.map((c) => ({ ...c })),
};
const dockerBackend: RunnerBackend = {
  bin: "docker", name: "docker", verbs: DOCKER_VERBS,
  async ensureRuntimeReady() {
    const endpoint = await dockerEndpoint();
    if (!isLocalDockerEndpoint(endpoint)) throw new Error(`rig: refusing remote Docker context (${endpoint || "unknown endpoint"}); bind mounts must resolve on this checkout's host`);
    const info = await run(["info"], { allowFail: true, timeoutMs: 15_000 });
    if (info.exitCode !== 0) throw new Error(`Docker daemon is unavailable: ${(info.stderr || info.stdout).trim()}\nfix: start Docker, then check local socket permissions`);
  },
  parseInspectMounts: parseDockerInspectMounts, parseStats: parseDockerStats,
  createCmdOverride: () => undefined, parseSpecLabel: parseDockerSpecLabel,
  doctorChecks: () => DOCKER_DOCTOR.map((c) => ({ ...c })),
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
  if (selected) throw new Error("rig: runner already resolved");
  configuredFlag = flag;
  return resolveRunnerName(flag, process.env, process.platform);
}
function backend(): RunnerBackend {
  if (!selected) selected = resolveRunnerName(configuredFlag, process.env, process.platform) === "docker" ? dockerBackend : appleBackend;
  return selected;
}
export function runnerName(): RunnerName { return backend().name; }
export function runnerBackendForTests(name: RunnerName): RunnerBackend { return name === "docker" ? dockerBackend : appleBackend; }
export function resetRunnerForTests(): void { selected = undefined; configuredFlag = undefined; markers = []; }

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
  const reader = stream.getReader(); const decoder = new TextDecoder(); let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) { buf += decoder.decode(value, { stream: true }); let nl: number; while ((nl = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); } }
      if (done) { if (buf) onLine(buf); break; }
    }
  } catch { /* process killed */ }
}
export function streamContainerLogsArgv(name: string, runner: RunnerName = runnerName()): string[] { return [runner === "docker" ? "docker" : "container", "logs", "--follow", name]; }
export function streamContainerLogs(name: string, opts: StreamOpts = {}): StreamHandle { return spawnStream(streamContainerLogsArgv(name), opts); }

export async function ensureRuntimeReady(): Promise<void> { await backend().ensureRuntimeReady(); }
export function doctorChecks(): DoctorCheck[] { return backend().doctorChecks(); }
export function createCmdOverride(): string[] | undefined { return backend().createCmdOverride(); }
export async function containerStats(names: string[]): Promise<StatsSample[]> {
  const r = await run(["stats", "--format", "json", "--no-stream", ...names], { allowFail: true });
  if (r.exitCode !== 0) throw new Error(`${backend().bin} stats exited ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  return backend().parseStats(r.stdout);
}
export async function systemStatus(): Promise<{ healthy: boolean; raw: string }> {
  if (backend().name === "docker") { const r = await run(["info"], { allowFail: true, timeoutMs: 15_000 }); return { healthy: r.exitCode === 0, raw: (r.stdout + r.stderr).trim() }; }
  const r = await run(["system", "status"], { allowFail: true }); return { healthy: r.exitCode === 0, raw: (r.stdout + r.stderr).trim() };
}
export async function systemStart(): Promise<void> { if (backend().name === "apple-container") await run(["system", "start"]); }
export async function version(): Promise<string> { const r = await run(["--version"], { allowFail: true }); return (r.stdout || r.stderr).trim(); }

export async function imageExists(tag: string): Promise<boolean> {
  if (backend().name === "docker") return (await run(["image", "inspect", tag], { allowFail: true })).exitCode === 0;
  const r = await run(["image", "ls", "--format", "json"], { allowFail: true });
  if (r.exitCode !== 0) return false;
  try { return JSON.stringify(JSON.parse(r.stdout)).includes(`"${tag}"`) || JSON.stringify(JSON.parse(r.stdout)).includes(`${tag}:latest`); } catch { return r.stdout.includes(tag); }
}
export interface BuildSpec { tag: string; dockerfile: string; contextDir: string; buildArgs?: Record<string, string>; labels?: Record<string, string> }
export function buildImageArgs(spec: BuildSpec): string[] {
  const args = ["build", "-t", spec.tag, "-f", spec.dockerfile];
  for (const [k, v] of Object.entries(spec.buildArgs ?? {})) args.push("--build-arg", `${k}=${v}`);
  const labels = { rig: "1", ...(spec.labels ?? {}) };
  for (const [k, v] of Object.entries(labels)) args.push("--label", `${k}=${v}`);
  args.push(spec.contextDir); return args;
}
export async function buildImage(spec: BuildSpec): Promise<void> { await run(buildImageArgs(spec)); }
export async function ensureImagePresent(spec: BuildSpec): Promise<boolean> {
  if (await imageExists(spec.tag)) return false;
  await buildImage(spec);
  return true;
}
export async function imageDelete(tag: string): Promise<boolean> { return (await run([...backend().verbs.imageDelete, tag], { allowFail: true })).exitCode === 0; }

function exactDockerRows(text: string, field: string, name: string): boolean { return parseNdjson(text).some((row) => row[field] === name); }
export async function networkExists(name: string): Promise<boolean> {
  const args = backend().name === "docker" ? [...backend().verbs.networkList, "--filter", `name=^${name}$`, "--format", "json"] : [...backend().verbs.networkList, "--format", "json"];
  const r = await run(args, { allowFail: true }); if (r.exitCode !== 0) return false;
  if (backend().name === "docker") return exactDockerRows(r.stdout, "Name", name);
  return r.stdout.includes(`"${name}"`);
}
export async function networkCreate(name: string): Promise<void> { await run(backend().name === "docker" ? ["network", "create", "--label", "rig=1", name] : ["network", "create", name]); }
export async function networkDelete(name: string): Promise<boolean> { return (await run([...backend().verbs.networkDelete, name], { allowFail: true })).exitCode === 0; }

export async function containerExists(name: string): Promise<boolean> {
  const args = backend().name === "docker" ? [...backend().verbs.psAll, "--filter", `name=^/${name}$`, "--format", "json"] : [...backend().verbs.psAll, "--format", "json"];
  const r = await run(args, { allowFail: true }); if (r.exitCode !== 0) return false;
  return backend().name === "docker" ? exactDockerRows(r.stdout, "Names", name) : r.stdout.includes(`"${name}"`);
}
export function inspectHasMounts(inspect: unknown, expected: readonly Mount[]): boolean {
  const mounts = backend().parseInspectMounts(inspect);
  return expected.every((want) => mounts.some((m) => m.source === want.source && m.target === want.target));
}
export async function containerHasMounts(name: string, expected: readonly Mount[]): Promise<boolean> {
  const r = await run(["inspect", name], { allowFail: true }); if (r.exitCode !== 0) return false;
  try { return inspectHasMounts(JSON.parse(r.stdout), expected); } catch { return false; }
}

export function serializeMount(m: Mount, runner: RunnerName): string {
  const parts: string[] = [];
  if (m.type) parts.push(`type=${m.type}`); else if (runner === "docker") parts.push("type=bind");
  parts.push(`source=${m.source}`, `target=${m.target}`); if (m.readonly) parts.push("readonly"); return parts.join(",");
}
export interface CreateSpec { name: string; image: string; network: string; cpus: number; memory: string; mounts: Mount[]; env?: Record<string, string>; cmd?: string[]; imageHash?: string }
function normalizedCreateSpec(spec: CreateSpec, runner: RunnerName): unknown {
  const mounts = spec.mounts.map((m) => ({ type: m.type ?? "bind", source: m.source, target: m.target, readonly: Boolean(m.readonly) }))
    .sort((a, b) => `${a.type}\0${a.source}\0${a.target}`.localeCompare(`${b.type}\0${b.source}\0${b.target}`));
  return { name: spec.name, image: spec.image, network: spec.network, cpus: spec.cpus, memory: spec.memory, mounts, env: Object.fromEntries(Object.entries(spec.env ?? {}).sort(([a], [b]) => a.localeCompare(b))), cmd: spec.cmd ?? (runner === "apple-container" ? appleBackend.createCmdOverride() : undefined) ?? [] };
}
export function createSpecHash(spec: CreateSpec, runner: RunnerName = runnerName()): string {
  return createHash("sha256").update(JSON.stringify({ runner, imageHash: spec.imageHash ?? "", create: normalizedCreateSpec(spec, runner) })).digest("hex");
}
export function createContainerArgs(spec: CreateSpec, runner: RunnerName = runnerName()): string[] {
  const args = ["create", "--name", spec.name, "--network", spec.network, "--cpus", String(spec.cpus), "--memory", spec.memory, "--label", "rig=1", "--label", `rig.spec=${createSpecHash(spec, runner)}`];
  for (const m of spec.mounts) args.push("--mount", serializeMount(m, runner));
  for (const [k, v] of Object.entries(spec.env ?? {})) args.push("-e", `${k}=${v}`);
  args.push(spec.image, ...(spec.cmd ?? (runner === "apple-container" ? appleBackend.createCmdOverride()! : []))); return args;
}
export async function createContainer(spec: CreateSpec): Promise<void> { await run(createContainerArgs(spec)); }
export async function containerHasSpec(name: string, spec: CreateSpec): Promise<boolean> {
  const r = await run(["inspect", name], { allowFail: true }); if (r.exitCode !== 0) return false;
  try { return backend().parseSpecLabel(JSON.parse(r.stdout)) === createSpecHash(spec); } catch { return false; }
}
export async function startContainer(name: string): Promise<void> { await run(["start", name], { allowFail: true }); }
export async function stopContainer(name: string): Promise<void> { await run(["stop", name], { allowFail: true }); }
export async function killContainer(name: string): Promise<boolean> { return (await run(["kill", "--signal", "KILL", name], { allowFail: true })).exitCode === 0; }
export async function deleteContainer(name: string): Promise<boolean> { return (await run([...backend().verbs.containerDelete, name], { allowFail: true })).exitCode === 0; }
export interface ExecSpec { name: string; cmd: string[]; env?: Record<string, string>; cwd?: string; stdin?: string; allowFail?: boolean; redact?: string[] }
export async function exec(spec: ExecSpec): Promise<RunResult> {
  const args = ["exec"]; if (spec.stdin !== undefined) args.push("-i");
  for (const [k, v] of Object.entries(spec.env ?? {})) args.push("-e", `${k}=${v}`);
  if (spec.cwd) args.push("-w", spec.cwd); args.push(spec.name, ...spec.cmd);
  return run(args, { stdin: spec.stdin, allowFail: spec.allowFail, redact: spec.redact });
}
export async function rigVolumes(): Promise<string[]> {
  const args = backend().name === "docker" ? [...backend().verbs.volumeList, "--filter", "name=rig-", "--format", "json"] : [...backend().verbs.volumeList, "--format", "json"];
  const r = await run(args, { allowFail: true });
  if (r.exitCode !== 0) throw new Error(`${backend().bin} volume listing failed: ${(r.stderr || r.stdout).trim()}`);
  try {
    if (backend().name === "docker") {
      const parsed = parseNdjson(r.stdout);
      const names = parsed.map((row) => { if (typeof row.Name !== "string") throw new Error("Docker volume row lacks string Name"); return row.Name; });
      return [...new Set(names.filter((name) => name.startsWith("rig-")))];
    }
    const names = new Set<string>();
    for (const row of rows(JSON.parse(r.stdout))) {
      const entry = Object.entries(row).find(([key, value]) => key.toLowerCase().includes("name") && typeof value === "string");
      if (!entry) throw new Error("Apple volume row lacks a string name field");
      if ((entry[1] as string).startsWith("rig-")) names.add(entry[1] as string);
    }
    return [...names];
  } catch (e) { throw new Error(`rig: cannot parse ${backend().bin} volume listing: ${e instanceof Error ? e.message : String(e)}`); }
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
export interface RigVolume { name: string; size: string }
export async function rigLabeledVolumes(): Promise<RigVolume[]> {
  if (backend().name !== "docker") return (await rigVolumes()).map((name) => ({ name, size: "unknown" }));
  const r = await run(["volume", "ls", "--filter", "label=rig=1", "--format", "json"], { allowFail: true });
  if (r.exitCode !== 0) throw new Error(`docker labeled-volume listing failed: ${(r.stderr || r.stdout).trim()}`);
  try {
    const volumes = parseNdjson(r.stdout).map((row) => {
      if (typeof row.Name !== "string") throw new Error("Docker volume row lacks string Name");
      return { name: row.Name, size: typeof row.Size === "string" ? row.Size : "unknown" };
    }).filter((volume) => volume.name.startsWith("rig-"));
    return [...new Map(volumes.map((volume) => [volume.name, volume])).values()];
  }
  catch (e) { throw new Error(`rig: cannot parse docker labeled-volume listing: ${e instanceof Error ? e.message : String(e)}`); }
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
