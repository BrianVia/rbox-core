import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "./container.js";
import { resolveBootstrapSecret, resolvePlatformSecret } from "./account.js";
import { assessDiskHeadroom, assessDockerInfo, assessRootlessPolicy, mayRunDockerDoctorProbes } from "./doctor.js";
import { writeImageHashRecord } from "./image-hash-records.js";
import { NAMES } from "./config.js";

interface Check {
  label: string;
  ok: boolean;
  detail: string;
  fix?: string;
  advisory?: boolean;
}

interface DoctorOptions {
  apiUrl: string;
  repoRoot: string;
  rigDir: string;
  runsDir: string;
  hashFile: string;
  currentImageHash(): string;
}

/** Runtime/host preflight command, extracted to keep the rig entrypoint bounded. */
export async function doctor(options: DoctorOptions): Promise<number> {
  const { apiUrl, repoRoot, rigDir, runsDir, hashFile, currentImageHash } = options;
  const checks: Check[] = [];
  const add = (label: string, ok: boolean, detail: string, fix?: string) => checks.push({ label, ok, detail, fix });
  const advise = (label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail, advisory: true });

  if (C.runnerName() === "apple-container") {
    try {
      const ver = (await C.spawnHost(["sw_vers", "-productVersion"], { allowFail: true })).stdout.trim();
      const major = Number(ver.split(".")[0]);
      add("macOS >= 26", Number.isFinite(major) && major >= 26, ver || "unknown", "upgrade macOS (container needs macOS 26+ for container-to-container networking)");
    } catch { add("macOS >= 26", false, "sw_vers failed"); }
    const arch = (await C.spawnHost(["uname", "-m"], { allowFail: true })).stdout.trim();
    add("arch arm64", arch === "arm64", arch || "unknown", "the rig targets arm64 (Apple silicon) guests");
    const ver = await C.version();
    add("container CLI present", ver.length > 0, ver || "not found", "brew install container   # Apple container runtime");
    const sys = await C.systemStatus();
    add("container system running", sys.healthy, sys.healthy ? "healthy" : sys.raw || "not running", "container system start");
    const cacheDir = path.join(os.homedir(), ".cache", "rbox-rig", "workloads");
    fs.mkdirSync(runsDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    const disk = await C.spawnHost(["df", "-Pk", runsDir, cacheDir], { allowFail: true });
    const assessment = assessDiskHeadroom(disk.exitCode === 0 ? disk.stdout : (disk.stderr || disk.stdout), disk.exitCode);
    add("runs/cache disk headroom", assessment.ok, assessment.detail, "run `bun run rig gc`");
  } else {
    let dockerLocal = false;
    try {
      const endpoint = await C.dockerEndpoint();
      dockerLocal = mayRunDockerDoctorProbes(endpoint);
      add("Docker context is local", dockerLocal, endpoint || "unknown", "select a local unix-socket Docker context; remote daemons cannot resolve checkout bind paths");
    } catch (error) { add("Docker context is local", false, error instanceof Error ? error.message : String(error)); }
    let info: C.DockerInfo | undefined;
    let dockerInfoError: string | undefined;
    let dockerDiskOk = false;
    try {
      info = await C.dockerInfo();
      const capability = assessDockerInfo(info);
      add("Docker server capabilities", capability.ok, capability.detail, "enable Docker memory and CPU quota support");
    } catch (error) {
      dockerInfoError = error instanceof Error ? error.message : String(error);
      add("Docker server capabilities", false, dockerInfoError, "start Docker and check local socket permissions");
    }
    if (dockerLocal && info && typeof info.DockerRootDir === "string" && info.DockerRootDir !== "") {
      const cacheDir = path.join(os.homedir(), ".cache", "rbox-rig", "workloads");
      fs.mkdirSync(runsDir, { recursive: true });
      fs.mkdirSync(cacheDir, { recursive: true });
      const disk = await C.spawnHost(["df", "-Pk", info.DockerRootDir, runsDir, cacheDir], { allowFail: true });
      const assessment = assessDiskHeadroom(disk.exitCode === 0 ? disk.stdout : (disk.stderr || disk.stdout), disk.exitCode);
      dockerDiskOk = assessment.ok;
      add("Docker/runs/cache disk headroom", assessment.ok, assessment.detail,
        "run `bun run rig gc`; if Docker build cache dominates, inspect it and choose `docker builder prune` manually");
      advise("Docker builder cache size", true, await C.dockerBuilderDiskUsage());
    } else {
      add("Docker/runs/cache disk space", false, dockerLocal ? dockerInfoError ?? "DockerRootDir unavailable" : "refused for remote Docker context");
    }
    let dockerProbeOk = false;
    try {
      if (!dockerLocal) throw new Error("refused for remote Docker context");
      if (!(await C.imageExists(NAMES.image))) {
        if (!dockerDiskOk) throw new Error("probe image absent and disk-headroom gate failed; refusing to build");
        const hash = currentImageHash();
        console.log(`doctor: building scoped probe image ${NAMES.image} (${hash})…`);
        const built = await C.ensureImagePresent({ tag: NAMES.image, dockerfile: path.join(rigDir, "Dockerfile"), contextDir: repoRoot, labels: { "rig.hash": hash } });
        if (built) writeImageHashRecord(hashFile, C.runnerName(), hash);
      }
      const probe = await C.runDockerDoctorProbe(repoRoot);
      dockerProbeOk = probe.exitCode === 0;
      add("Docker bind/network probe", probe.exitCode === 0, probe.exitCode === 0 ? "read-only checkout bind + outbound DNS passed" : (probe.stderr || probe.stdout).trim(), "check bind policy and daemon networking, then re-run doctor");
    } catch (error) { add("Docker bind/network probe", false, error instanceof Error ? error.message : String(error)); }
    if (dockerLocal && info && C.dockerIsRootless(info)) {
      let limitsProbeOk = false;
      try {
        await C.assessRuntimeResourcePolicy(NAMES.image);
        limitsProbeOk = !C.runtimeMarkers().includes("rootless-unvalidated");
      } catch { /* advisory remains rootless-unvalidated */ }
      const policy = assessRootlessPolicy(info, limitsProbeOk);
      advise("rootless resource-limit policy", policy.ok, policy.detail);
    } else if (dockerLocal && info) {
      const policy = assessRootlessPolicy(info, dockerProbeOk);
      advise("rootless resource-limit policy", policy.ok, policy.detail);
    } else advise("rootless resource-limit policy", false, dockerLocal ? "docker info unavailable" : "refused for remote Docker context");
  }

  const bun = (await C.spawnHost(["bun", "--version"], { allowFail: true })).stdout.trim();
  add("bun present", bun.length > 0, bun || "not found", "curl -fsSL https://bun.sh/install | bash");
  try {
    resolveBootstrapSecret(repoRoot);
    add("bootstrap secret resolvable", true, "found (redacted)");
  } catch (error) {
    add("bootstrap secret resolvable", false, error instanceof Error ? error.message : String(error), "set RBOX_DEV_BOOTSTRAP or add RBOX_DEV_BOOTSTRAP_SECRET= to dev-keys.local.secret");
  }
  try {
    resolvePlatformSecret(repoRoot);
    add("platform secret resolvable", true, "found (redacted)");
  } catch (error) {
    add("platform secret resolvable", false, error instanceof Error ? error.message : String(error), "set RBOX_DEV_PLATFORM_SECRET or add RBOX_DEV_PLATFORM_SECRET= to dev-keys.local.secret");
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${apiUrl}/health`, { signal: controller.signal }).finally(() => clearTimeout(timer));
    add("dev API reachable", response.ok, `${apiUrl}/health → ${response.status}`, "check the dev worker is deployed / your network");
  } catch (error) {
    add("dev API reachable", false, `${apiUrl}/health → ${error instanceof Error ? error.message : String(error)}`);
  }
  advise("CLOUDFLARE_ACCOUNT_ID (optional, AE query)", Boolean(process.env.CLOUDFLARE_ACCOUNT_ID), process.env.CLOUDFLARE_ACCOUNT_ID ? "present" : "absent");
  advise("CLOUDFLARE_API_TOKEN (optional, AE query)", Boolean(process.env.CLOUDFLARE_API_TOKEN), process.env.CLOUDFLARE_API_TOKEN ? "present" : "absent");

  let anyFail = false;
  for (const check of checks) {
    const mark = check.advisory ? (check.ok ? "○" : "·") : check.ok ? "✓" : "✗";
    console.log(`${mark} ${check.label}: ${check.detail}`);
    if (!check.ok && !check.advisory) {
      anyFail = true;
      if (check.fix) console.log(`    fix: ${check.fix}`);
    }
  }
  return anyFail ? 1 : 0;
}
