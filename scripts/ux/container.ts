import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import * as C from "../rig/lib/container.js";
import { GUEST, imageHash, NAMES } from "../rig/lib/config.js";
import { imageHashRecordPath, readImageHashRecord, writeImageHashRecord } from "../rig/lib/image-hash-records.js";
import { DEV_API, safeId, SCRUBBED_ENV, shellQuote, UX_ROOT } from "./lib.js";

export const UX_IMAGE = NAMES.image;
export const UX_NETWORK = "bridge";
export const UX_CPUS = 2;
export const UX_MEMORY = "2G";
export const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const RIG_DIR = path.join(REPO_ROOT, "scripts", "rig");
const RIG_DOCKERFILE = path.join(RIG_DIR, "Dockerfile");
const RIG_HASH_FILE = imageHashRecordPath();

export interface UxContainerPlan {
  runId: string;
  name: string;
  image: string;
  network: string;
  imageHash: string;
  repoId: string;
  specHash: string;
  mounts: C.Mount[];
  env: Record<string, string>;
}

export function uxContainerName(runId: string): string {
  return `ux-${safeId("run id", runId)}`;
}

export function guestMachineHome(runId: string, name: string): string {
  return path.posix.join(UX_ROOT, safeId("run id", runId), safeId("machine name", name));
}

export function assertGuestMachineHome(home: string, runId?: string): { runId: string; name: string } {
  const relative = path.posix.relative(UX_ROOT, path.posix.resolve(home));
  const parts = relative.split("/");
  if (parts.length !== 2 || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw new Error(`machine HOME must be ${UX_ROOT}/<run-id>/<name>: ${home}`);
  }
  const parsed = { runId: safeId("run id", parts[0]!), name: safeId("machine name", parts[1]!) };
  if (runId !== undefined && parsed.runId !== safeId("run id", runId)) throw new Error(`machine HOME belongs to run ${parsed.runId}, not ${runId}`);
  return parsed;
}

export function currentRigImageHash(): string {
  return imageHash({
    packageJson: fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    lockfile: fs.readFileSync(path.join(REPO_ROOT, "bun.lock"), "utf8"),
    dockerfile: fs.readFileSync(RIG_DOCKERFILE, "utf8"),
  });
}

function specHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

export function uxContainerPlan(runId: string, hash = currentRigImageHash(), repoRoot = REPO_ROOT): UxContainerPlan {
  const id = safeId("run id", runId);
  const mounts: C.Mount[] = [
    { source: path.join(repoRoot, "src"), target: GUEST.srcMount, readonly: true },
    { source: path.join(repoRoot, "scripts"), target: GUEST.scriptsMount, readonly: true },
  ];
  const repoId = createHash("sha256").update(path.resolve(repoRoot)).digest("hex").slice(0, 16);
  const base = { runId: id, name: uxContainerName(id), image: UX_IMAGE, network: UX_NETWORK, imageHash: hash, repoId, mounts, env: { RBOX_API: DEV_API } };
  return { ...base, specHash: specHash(base) };
}

export function uxCreateArgs(plan: UxContainerPlan): string[] {
  const args = [
    "create", "--name", plan.name, "--network", plan.network,
    "--cpus", String(UX_CPUS), "--memory", UX_MEMORY,
    "--label", "ux=1", "--label", `ux.run=${plan.runId}`, "--label", `ux.repo=${plan.repoId}`, "--label", `ux.spec=${plan.specHash}`,
  ];
  for (const mount of plan.mounts) args.push("--mount", C.serializeMount(mount, "docker"));
  for (const [key, value] of Object.entries(plan.env)) args.push("-e", `${key}=${value}`);
  args.push(plan.image);
  return args;
}

export function uxDestroyArgs(runId: string): { stop: string[]; remove: string[] } {
  const name = uxContainerName(runId);
  return { stop: ["stop", name], remove: ["rm", "--force", "--volumes", name] };
}

export function uxDestroyScope(name?: string): "machine" | "run" { return name ? "machine" : "run"; }

export function uxListArgs(): string[] {
  return ["ps", "--filter", "label=ux=1", "--format", "{{.Names}}\t{{.Label \"ux.run\"}}"]; 
}

export function containerRboxEnv(home: string): Record<string, string> {
  assertGuestMachineHome(home);
  return { HOME: home, RBOX_HOME: home, RBOX_API: DEV_API, RBOX_API_QUIET: "1", RBOX_APP: "" };
}

export function containerExecPrefix(runId: string, home: string): string {
  assertGuestMachineHome(home, runId);
  const unset = SCRUBBED_ENV.map((key) => `-u ${key}`).join(" ");
  return [
    "docker exec --workdir", shellQuote(home), shellQuote(uxContainerName(runId)),
    "env", unset, `HOME=${shellQuote(home)}`, `RBOX_HOME=${shellQuote(home)}`,
    `RBOX_API=${shellQuote(DEV_API)}`, "RBOX_API_QUIET=1", "RBOX_APP=''", "rbox",
  ].join(" ");
}

interface DockerInspect {
  Config?: { Image?: unknown; Env?: unknown; Labels?: unknown };
  HostConfig?: { NetworkMode?: unknown };
  Mounts?: unknown;
}

function inspectRow(value: unknown): DockerInspect | undefined {
  if (!Array.isArray(value) || !value[0] || typeof value[0] !== "object") return undefined;
  return value[0] as DockerInspect;
}

export function uxOwnership(value: unknown, plan: UxContainerPlan): "match" | "owned-stale" | "collision" {
  const row = inspectRow(value);
  const labels = row?.Config?.Labels;
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return "collision";
  const map = labels as Record<string, unknown>;
  if (map.ux !== "1" || map["ux.run"] !== plan.runId || map["ux.repo"] !== plan.repoId) return "collision";
  if (row?.Config?.Image !== plan.image || row.HostConfig?.NetworkMode !== plan.network) return "collision";
  const env = Array.isArray(row.Config.Env) ? row.Config.Env : [];
  const forbidden = ["HOME", "RBOX_HOME", ...SCRUBBED_ENV].filter((key) => key !== "RBOX_API");
  if (!env.includes(`RBOX_API=${DEV_API}`) || env.some((entry) => typeof entry === "string" && forbidden.some((key) => entry.startsWith(`${key}=`)))) return "collision";
  const mounts = Array.isArray(row.Mounts) ? row.Mounts : [];
  const exactMounts = mounts.length === plan.mounts.length && plan.mounts.every((want) => mounts.some((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const mount = candidate as Record<string, unknown>;
    return mount.Source === want.source && mount.Destination === want.target && mount.RW === !want.readonly;
  }));
  if (!exactMounts) return "collision";
  return map["ux.spec"] === plan.specHash ? "match" : "owned-stale";
}

export function configureUxRuntime(): void {
  C.configureRunner("docker");
}

export function uxImageHasLabel(value: unknown): boolean {
  const labels = inspectRow(value)?.Config?.Labels;
  return Boolean(labels && typeof labels === "object" && !Array.isArray(labels) && (labels as Record<string, unknown>).ux === "1");
}

async function ensureImageCurrent(): Promise<string> {
  const want = currentRigImageHash();
  const present = await C.imageExists(UX_IMAGE);
  const inspectedImage = present ? await C.run(["image", "inspect", UX_IMAGE], { allowFail: true }) : undefined;
  let labelled = false;
  if (inspectedImage?.exitCode === 0) try { labelled = uxImageHasLabel(JSON.parse(inspectedImage.stdout)); } catch { /* rebuild */ }
  if (!present || !labelled || readImageHashRecord(RIG_HASH_FILE, "docker") !== want) {
    await C.buildImage({ tag: UX_IMAGE, dockerfile: RIG_DOCKERFILE, contextDir: REPO_ROOT, labels: { ux: "1", "rig.hash": want } });
    writeImageHashRecord(RIG_HASH_FILE, "docker", want);
  }
  return want;
}

async function inspected(name: string): Promise<unknown | undefined> {
  const result = await C.run(["inspect", name], { allowFail: true });
  if (result.exitCode !== 0) return undefined;
  try { return JSON.parse(result.stdout); } catch { throw new Error(`cannot parse Docker inspection for ${name}`); }
}

export async function ensureUxContainer(runId: string): Promise<UxContainerPlan> {
  await C.ensureRuntimeReady();
  const plan = uxContainerPlan(runId, await ensureImageCurrent());
  const inspection = await inspected(plan.name);
  if (inspection !== undefined) {
    const ownership = uxOwnership(inspection, plan);
    if (ownership === "collision") throw new Error(`refusing to reuse unowned container ${plan.name}`);
    if (ownership === "owned-stale") throw new Error(`UX container specification is stale: destroy ${plan.name} with fresh-machine destroy before creating another machine`);
  }
  if (inspection === undefined) await C.run(uxCreateArgs(plan));
  await C.run(["start", plan.name]);
  // An older shared image can remain referenced by live rig containers. Match
  // the rig's scoped GC, but never make UX creation fail because it is in use.
  await C.removeDanglingRigImages().catch(() => []);
  return plan;
}

export async function uxContainerState(runId: string): Promise<{ plan: UxContainerPlan; ownership: "match" | "owned-stale" } | undefined> {
  const plan = uxContainerPlan(runId);
  const inspection = await inspected(plan.name);
  if (inspection === undefined) return undefined;
  const ownership = uxOwnership(inspection, plan);
  if (ownership === "collision") throw new Error(`refusing unowned container ${plan.name}`);
  return { plan, ownership };
}

export async function requireOwnedUxContainer(runId: string): Promise<UxContainerPlan | undefined> {
  return (await uxContainerState(runId))?.plan;
}

export async function startUxContainerForTeardown(runId: string): Promise<{ plan: UxContainerPlan; ownership: "match" | "owned-stale" } | undefined> {
  const state = await uxContainerState(runId);
  if (state) await C.run(["start", state.plan.name], { allowFail: true });
  return state;
}

export async function execUx(runId: string, cmd: string[], options: { home?: string; env?: Record<string, string>; stdin?: string; allowFail?: boolean; allowStale?: boolean; redact?: string[] } = {}): Promise<C.RunResult> {
  const state = await uxContainerState(runId);
  if (!state) throw new Error(`UX container is not running: ${uxContainerName(runId)}`);
  if (state.ownership !== "match" && !options.allowStale) throw new Error(`UX container specification is stale: recreate ${state.plan.name} after fresh-machine destroy`);
  return C.exec({ name: state.plan.name, cmd, cwd: options.home, env: options.env, stdin: options.stdin, allowFail: options.allowFail, redact: options.redact });
}

export async function destroyUxContainer(runId: string): Promise<void> {
  const plan = await requireOwnedUxContainer(runId);
  if (!plan) return;
  const args = uxDestroyArgs(runId);
  await C.run(args.stop, { allowFail: true });
  await C.run(args.remove);
  await C.removeDanglingRigImages().catch(() => []);
}

export async function listUxContainers(): Promise<string> {
  const result = await C.run(uxListArgs());
  return result.stdout.split("\n").filter((line) => line.split("\t")[0]?.startsWith("ux-")).join("\n");
}
