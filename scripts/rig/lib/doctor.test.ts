import { expect, test } from "bun:test";
import { assessDiskHeadroom, assessDockerInfo, assessRootlessPolicy, mayRunDockerDoctorProbes } from "./doctor.js";

const info = { ServerVersion: "24.0.9", OperatingSystem: "Linux", CgroupDriver: "systemd", CgroupVersion: "2", MemoryLimit: true, CPUCfsQuota: true, DockerRootDir: "/var/lib/docker", SecurityOptions: ["name=rootless"] };

test("Docker doctor capability assessment uses actual info field names", () => {
  expect(assessDockerInfo(info).ok).toBe(true);
  expect(assessDockerInfo({ ...info, CPUCfsQuota: false }).ok).toBe(false);
  expect(assessDockerInfo(info).detail).toContain("root=/var/lib/docker");
});

test("disk headroom is a hard 20 GiB gate on every reported filesystem", () => {
  const df = (gib: number) => `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 1 1 ${gib * 1024 * 1024} 1% /x\n`;
  expect(assessDiskHeadroom(df(21), 0).ok).toBe(true);
  expect(assessDiskHeadroom(df(19), 0).ok).toBe(false);
  expect(assessDiskHeadroom("bad", 1).ok).toBe(false);
});

test("rootless policy has only validated or rootless-unvalidated outcomes", () => {
  expect(assessRootlessPolicy(info, true)).toEqual({ ok: true, detail: "delegated cgroup v2 + effective limits validated" });
  expect(assessRootlessPolicy(info, false).detail).toContain("rootless-unvalidated");
  expect(assessRootlessPolicy({ ...info, SecurityOptions: [] }, false)).toEqual({ ok: true, detail: "rootful daemon" });
});

test("remote Docker endpoints refuse all mutating doctor probes", () => {
  expect(mayRunDockerDoctorProbes("unix:///var/run/docker.sock")).toBe(true);
  expect(mayRunDockerDoctorProbes("ssh://builder")).toBe(false);
  expect(mayRunDockerDoctorProbes("tcp://10.0.0.2:2376")).toBe(false);
});
