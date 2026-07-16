import { dockerHasCpuQuota, dockerIsRootless, isLocalDockerEndpoint, type DockerInfo } from "./container.js";
import { formatBytes, MIN_DISK_HEADROOM_BYTES, parseDfAvailableBytes } from "./gc.js";

export interface DoctorAssessment { ok: boolean; detail: string }
export function mayRunDockerDoctorProbes(endpoint: string): boolean { return isLocalDockerEndpoint(endpoint); }

export function assessDockerInfo(info: DockerInfo): DoctorAssessment {
  const ok = Boolean(info.ServerVersion) && Boolean(info.OperatingSystem) && info.MemoryLimit === true && dockerHasCpuQuota(info);
  return {
    ok,
    detail: `server ${String(info.ServerVersion ?? "unknown")} · ${String(info.OperatingSystem ?? "unknown")} · cgroup ${String(info.CgroupDriver ?? "?")}/${String(info.CgroupVersion ?? "?")} · memory=${String(info.MemoryLimit)} cpu-quota=${String(info.CPUCfsQuota ?? info.CpuCfsQuota)} · root=${String(info.DockerRootDir ?? "unknown")}`,
  };
}

export function assessDiskHeadroom(stdout: string, exitCode: number): DoctorAssessment {
  if (exitCode !== 0) return { ok: false, detail: stdout.trim() || "df failed" };
  try {
    const available = parseDfAvailableBytes(stdout);
    return { ok: available.length > 0 && available.every((bytes) => bytes >= MIN_DISK_HEADROOM_BYTES), detail: available.map(formatBytes).join(" · ") };
  } catch (e) { return { ok: false, detail: e instanceof Error ? e.message : String(e) }; }
}

export function assessRootlessPolicy(info: DockerInfo, limitsProbeOk: boolean): DoctorAssessment {
  if (!dockerIsRootless(info)) return { ok: true, detail: "rootful daemon" };
  const ok = String(info.CgroupVersion) === "2" && info.MemoryLimit === true && dockerHasCpuQuota(info) && limitsProbeOk;
  return { ok, detail: ok ? "delegated cgroup v2 + effective limits validated" : "rootless-unvalidated (resource-budget scenarios will SKIP)" };
}
