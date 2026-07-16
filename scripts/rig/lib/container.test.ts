import { afterEach, describe, expect, test } from "bun:test";
import {
  assessRuntimeResourcePolicy, buildImage, configureRunner, containerExists, containerHasMounts, containerHasSpec, createContainerArgs, createSpecHash, dockerBuilderDiskUsage,
  deleteContainer, ensureImagePresent, exec, imageDelete, imageExists, killContainer,
  ensureRuntimeReady, inspectHasMounts, networkExists, parseAppleInspectMounts,
  parseAppleSpecLabel, parseAppleStats, parseDockerInspectMounts, parseDockerMemoryUsage,
  networkCreate, networkDelete, parseDockerSpecLabel, parseDockerStats, resetRunnerForTests, resolveRunnerName, rigVolumes,
  removeDanglingRigImages, rigDanglingImages, rigLabeledVolumes, runDockerDoctorProbe, runnerBackendForTests, runtimeMarkers, serializeMount, setSpawnCaptureForTests, startContainer, stopContainer, streamContainerLogsArgv, volumeDelete,
  type CreateSpec, type Mount, type RunResult,
} from "./container.js";

afterEach(() => { setSpawnCaptureForTests(); resetRunnerForTests(); });

function select(name: "container" | "docker"): void { configureRunner(name); }
function result(stdout = "", exitCode = 0, stderr = ""): RunResult { return { stdout, stderr, exitCode }; }

test("runner selection is flag > env > platform", () => {
  expect(resolveRunnerName("container", { RBOX_RIG_RUNNER: "docker" }, "linux")).toBe("apple-container");
  expect(resolveRunnerName(undefined, { RBOX_RIG_RUNNER: "container" }, "linux")).toBe("apple-container");
  expect(resolveRunnerName(undefined, {}, "darwin")).toBe("apple-container");
  expect(resolveRunnerName(undefined, {}, "linux")).toBe("docker");
  expect(() => resolveRunnerName("podman", {}, "linux")).toThrow("unsupported runner");
});

test("verb tables pin every lexical backend difference", () => {
  expect(runnerBackendForTests("apple-container").verbs).toEqual({
    imageDelete: ["image", "delete"], networkList: ["network", "list"], networkDelete: ["network", "delete"],
    psAll: ["ls", "--all"], containerDelete: ["delete", "--force"], volumeList: ["volume", "list"],
  });
  expect(runnerBackendForTests("docker").verbs).toEqual({
    imageDelete: ["image", "rm"], networkList: ["network", "ls"], networkDelete: ["network", "rm"],
    psAll: ["ps", "-a"], containerDelete: ["rm", "--force"], volumeList: ["volume", "ls"],
  });
});

test("golden wrapper argv pins compatible and divergent verbs per backend", async () => {
  const exercise = async (runner: "container" | "docker") => {
    select(runner); const seen: string[][] = [];
    setSpawnCaptureForTests(async (argv) => {
      seen.push(argv);
      if (argv.includes("stats")) return result(runner === "docker" ? '{"Name":"rig-dev-a","MemUsage":"1MiB / 2GiB","CPUPerc":"1%"}\n' : '[{"name":"rig-dev-a","memoryUsageBytes":1,"cpuUsageUsec":1}]');
      if (argv.includes("inspect") && !argv.includes("image")) return result(runner === "docker" ? '[{"Mounts":[]}]' : '[{"configuration":{"mounts":[]}}]');
      return result(runner === "docker" ? "" : "[]");
    });
    await imageExists("rbox-rig:dev");
    await buildImage({ tag: "rbox-rig:dev", dockerfile: "/repo/Dockerfile", contextDir: "/repo", buildArgs: { A: "1" }, labels: { L: "v" } });
    await imageDelete("rbox-rig:dev");
    await networkCreate("rig-net"); await networkDelete("rig-net");
    await containerHasMounts("rig-dev-a", []);
    await startContainer("rig-dev-a"); await stopContainer("rig-dev-a"); await killContainer("rig-dev-a"); await deleteContainer("rig-dev-a");
    await exec({ name: "rig-dev-a", stdin: "x", env: { A: "b" }, cwd: "/work", cmd: ["sh", "-c", "true"] });
    await volumeDelete("rig-vol");
    resetRunnerForTests();
    return seen;
  };
  const apple = await exercise("container");
  expect(apple).toEqual([
    ["container", "image", "ls", "--format", "json"],
    ["container", "build", "-t", "rbox-rig:dev", "-f", "/repo/Dockerfile", "--build-arg", "A=1", "--label", "rig=1", "--label", "L=v", "/repo"],
    ["container", "image", "delete", "rbox-rig:dev"], ["container", "network", "create", "rig-net"], ["container", "network", "delete", "rig-net"],
    ["container", "inspect", "rig-dev-a"], ["container", "start", "rig-dev-a"], ["container", "stop", "rig-dev-a"], ["container", "kill", "--signal", "KILL", "rig-dev-a"], ["container", "delete", "--force", "rig-dev-a"],
    ["container", "exec", "-i", "-e", "A=b", "-w", "/work", "rig-dev-a", "sh", "-c", "true"], ["container", "volume", "rm", "rig-vol"],
  ]);
  const docker = await exercise("docker");
  expect(docker).toEqual([
    ["docker", "image", "inspect", "rbox-rig:dev"],
    ["docker", "build", "-t", "rbox-rig:dev", "-f", "/repo/Dockerfile", "--build-arg", "A=1", "--label", "rig=1", "--label", "L=v", "/repo"],
    ["docker", "image", "rm", "rbox-rig:dev"], ["docker", "network", "create", "--label", "rig=1", "rig-net"], ["docker", "network", "rm", "rig-net"],
    ["docker", "inspect", "rig-dev-a"], ["docker", "start", "rig-dev-a"], ["docker", "stop", "rig-dev-a"], ["docker", "kill", "--signal", "KILL", "rig-dev-a"], ["docker", "rm", "--force", "rig-dev-a"],
    ["docker", "exec", "-i", "-e", "A=b", "-w", "/work", "rig-dev-a", "sh", "-c", "true"], ["docker", "volume", "rm", "rig-vol"],
  ]);
});

test("mount serializers preserve Apple argv and inject Docker bind type", () => {
  const bind: Mount = { source: "/repo/src", target: "/app/src", readonly: true };
  expect(serializeMount(bind, "apple-container")).toBe("source=/repo/src,target=/app/src,readonly");
  expect(serializeMount(bind, "docker")).toBe("type=bind,source=/repo/src,target=/app/src,readonly");
  expect(serializeMount({ source: "rig-cache", target: "/cache", type: "volume" }, "docker")).toBe("type=volume,source=rig-cache,target=/cache");
});

const standard: CreateSpec = {
  name: "rig-dev-a", image: "rbox-rig:dev", imageHash: "img-1", network: "rig-net", cpus: 2, memory: "2G",
  mounts: [{ source: "/repo/src", target: "/app/src", readonly: true }, { source: "/repo/scripts", target: "/app/scripts", readonly: true }],
  env: { RBOX_API: "https://dev.example" },
};
const workload: CreateSpec = { ...standard, mounts: [...standard.mounts, { source: "/cache/tree", target: "/workload", readonly: true }] };

test("golden create argv covers standard and workload paths on both backends", () => {
  const apple = createContainerArgs(standard, "apple-container");
  expect(apple).toEqual(["create", "--name", "rig-dev-a", "--network", "rig-net", "--cpus", "2", "--memory", "2G", "--label", "rig=1", "--label", `rig.spec=${createSpecHash(standard, "apple-container")}`, "--mount", "source=/repo/src,target=/app/src,readonly", "--mount", "source=/repo/scripts,target=/app/scripts,readonly", "-e", "RBOX_API=https://dev.example", "rbox-rig:dev", "/usr/bin/tini", "--", "sleep", "infinity"]);
  const docker = createContainerArgs(workload, "docker");
  expect(docker).toEqual(["create", "--name", "rig-dev-a", "--network", "rig-net", "--cpus", "2", "--memory", "2G", "--label", "rig=1", "--label", `rig.spec=${createSpecHash(workload, "docker")}`, "--mount", "type=bind,source=/repo/src,target=/app/src,readonly", "--mount", "type=bind,source=/repo/scripts,target=/app/scripts,readonly", "--mount", "type=bind,source=/cache/tree,target=/workload,readonly", "-e", "RBOX_API=https://dev.example", "rbox-rig:dev"]);
  expect(runnerBackendForTests("apple-container").createCmdOverride()).toEqual(["/usr/bin/tini", "--", "sleep", "infinity"]);
  expect(runnerBackendForTests("docker").createCmdOverride()).toBeUndefined();
  expect(createContainerArgs(workload, "apple-container")).toEqual([
    "create", "--name", "rig-dev-a", "--network", "rig-net", "--cpus", "2", "--memory", "2G", "--label", "rig=1", "--label", `rig.spec=${createSpecHash(workload, "apple-container")}`,
    "--mount", "source=/repo/src,target=/app/src,readonly", "--mount", "source=/repo/scripts,target=/app/scripts,readonly", "--mount", "source=/cache/tree,target=/workload,readonly",
    "-e", "RBOX_API=https://dev.example", "rbox-rig:dev", "/usr/bin/tini", "--", "sleep", "infinity",
  ]);
  expect(createContainerArgs(standard, "docker")).toEqual([
    "create", "--name", "rig-dev-a", "--network", "rig-net", "--cpus", "2", "--memory", "2G", "--label", "rig=1", "--label", `rig.spec=${createSpecHash(standard, "docker")}`,
    "--mount", "type=bind,source=/repo/src,target=/app/src,readonly", "--mount", "type=bind,source=/repo/scripts,target=/app/scripts,readonly",
    "-e", "RBOX_API=https://dev.example", "rbox-rig:dev",
  ]);
});

describe("typed inspect parsing", () => {
  const expected: Mount[] = [{ source: "/repo/src", target: "/app/src", readonly: true }];
  test("Apple nested and Docker flat fixtures preserve source + target", () => {
    const apple = [{ configuration: { mounts: [{ type: "bind", source: "/repo/src", destination: "/app/src", options: ["ro"] }] } }];
    const docker = [{ Mounts: [{ Type: "bind", Source: "/repo/src", Destination: "/app/src", RW: false }] }];
    expect(parseAppleInspectMounts(apple)).toEqual([{ source: "/repo/src", target: "/app/src", type: "bind", readonly: true }]);
    expect(parseDockerInspectMounts(docker)).toEqual([{ source: "/repo/src", target: "/app/src", type: "bind", readonly: true }]);
    select("container"); expect(inspectHasMounts(apple, expected)).toBe(true);
    resetRunnerForTests(); select("docker"); expect(inspectHasMounts(docker, expected)).toBe(true);
  });
  test("wrong target and malformed payload fail closed", () => {
    select("docker");
    expect(inspectHasMounts([{ Mounts: [{ Source: "/repo/src", Destination: "/wrong" }] }], expected)).toBe(false);
    expect(inspectHasMounts([{ Mounts: "unknown" }], expected)).toBe(false);
  });
});

test("typed spec-label parsers and hash detect same-runtime create drift", async () => {
  const hash = createSpecHash(standard, "docker");
  expect(parseAppleSpecLabel([{ configuration: { labels: { "rig.spec": "apple" } } }])).toBe("apple");
  expect(parseDockerSpecLabel([{ Config: { Labels: { "rig.spec": hash } } }])).toBe(hash);
  expect(parseDockerSpecLabel([{ Config: { Labels: { "rig.spec": 42 } } }])).toBeUndefined();
  expect(createSpecHash({ ...standard, cpus: 3 }, "docker")).not.toBe(hash);
  expect(createSpecHash({ ...standard, mounts: [...standard.mounts].reverse() }, "docker")).toBe(hash);
  expect(createSpecHash(standard, "apple-container")).not.toBe(hash);
  expect(createSpecHash({ ...standard, imageHash: "img-2" }, "docker")).not.toBe(hash);
  select("docker");
  setSpawnCaptureForTests(async () => result(JSON.stringify([{ Config: { Labels: { "rig.spec": hash } } }])));
  expect(await containerHasSpec("rig-dev-a", standard)).toBe(true);
  expect(await containerHasSpec("rig-dev-a", { ...standard, memory: "3G" })).toBe(false);
});

test("stats parsers produce the canonical labeled contract", () => {
  const ts = "2026-07-16T12:00:00.000Z";
  expect(parseAppleStats(JSON.stringify([{ name: "rig-dev-a", memoryUsageBytes: 1048576, cpuUsageUsec: 2500 }]), ts)).toEqual([
    { name: "rig-dev-a", ts, memBytes: 1048576, cpu: { kind: "cumulative-usec", usec: 2500 }, runner: "apple-container" },
  ]);
  expect(parseDockerStats('{"Name":"rig-dev-a","MemUsage":"1.5GiB / 31GiB","CPUPerc":"12.34%"}\n', ts)).toEqual([
    { name: "rig-dev-a", ts, memBytes: 1.5 * 1024 ** 3, cpu: { kind: "instant-percent", pct: 12.34 }, runner: "docker" },
  ]);
  expect(parseDockerMemoryUsage("500MB / 2GB")).toBe(500_000_000);
  expect(() => parseDockerStats("not-json", ts)).toThrow();
});

test("Docker exact-name filters still typed-compare returned fields", async () => {
  select("docker"); const argv: string[][] = [];
  setSpawnCaptureForTests(async (a) => { argv.push(a); return result('{"Names":"rig-device-old","Command":"rig-dev-a"}\n'); });
  expect(await containerExists("rig-dev-a")).toBe(false);
  expect(argv[0]).toEqual(["docker", "ps", "-a", "--filter", "name=^/rig-dev-a$", "--format", "json"]);
  setSpawnCaptureForTests(async (a) => { argv.push(a); return result('{"Name":"rig-net-old","Labels":"rig-net"}\n'); });
  expect(await networkExists("rig-net")).toBe(false);
});

test("rigVolumes parses typed Docker NDJSON and fails loudly", async () => {
  select("docker");
  setSpawnCaptureForTests(async () => result('{"Name":"rig-one"}\n{"Name":"other"}\n'));
  expect(await rigVolumes()).toEqual(["rig-one"]);
  setSpawnCaptureForTests(async () => result("not-json"));
  expect(rigVolumes()).rejects.toThrow("cannot parse");
  setSpawnCaptureForTests(async () => result('{"Labels":"rig=1"}\n'));
  expect(rigVolumes()).rejects.toThrow("lacks string Name");
  setSpawnCaptureForTests(async () => result("", 1, "denied"));
  expect(rigVolumes()).rejects.toThrow("listing failed");
});

test("scoped Docker gc discovery uses rig labels and typed rows", async () => {
  select("docker"); const seen: string[][] = [];
  setSpawnCaptureForTests(async (argv) => {
    seen.push(argv);
    if (argv.includes("image")) return result('{"ID":"sha256:old","Size":"2.5GB"}\n');
    return result('{"Name":"rig-cache","Size":"24MB"}\n{"Name":"foreign","Size":"1GB"}\n');
  });
  expect(await rigDanglingImages()).toEqual([{ id: "sha256:old", size: "2.5GB" }]);
  expect(await rigLabeledVolumes()).toEqual([{ name: "rig-cache", size: "24MB" }]);
  expect(seen[0]).toEqual(["docker", "image", "ls", "--filter", "dangling=true", "--filter", "label=rig=1", "--format", "json"]);
  expect(seen[1]).toEqual(["docker", "volume", "ls", "--filter", "label=rig=1", "--format", "json"]);
});

test("doctor reports the typed Docker builder-cache size", async () => {
  select("docker");
  setSpawnCaptureForTests(async () => result('{"Type":"Images","Size":"1GB"}\n{"Type":"Build Cache","Size":"3GB","Reclaimable":"2GB"}\n'));
  expect(await dockerBuilderDiskUsage()).toBe("3GB total · 2GB reclaimable");
});

test("dangling-image cleanup fails loud and is rediscovered for retry", async () => {
  select("docker"); let deleteAttempts = 0;
  setSpawnCaptureForTests(async (argv) => {
    if (argv.includes("ls")) return result('{"ID":"sha256:old","Size":"1GB"}\n');
    deleteAttempts++;
    return result("", deleteAttempts === 1 ? 1 : 0);
  });
  expect(removeDanglingRigImages()).rejects.toThrow("failed to remove");
  expect(await removeDanglingRigImages()).toEqual([{ id: "sha256:old", size: "1GB" }]);
});

test("runtime-ready Docker gate refuses remote contexts before info", async () => {
  select("docker"); const seen: string[][] = [];
  setSpawnCaptureForTests(async (a) => { seen.push(a); return seen.length === 1 ? result("remote\n") : result('"ssh://builder"\n'); });
  expect(ensureRuntimeReady()).rejects.toThrow("refusing remote Docker context");
  expect(seen.some((a) => a.includes("info"))).toBe(false);
});

test("clean-state doctor image helper builds one scoped image without a daemon fixture", async () => {
  select("docker"); const seen: string[][] = [];
  setSpawnCaptureForTests(async (argv) => { seen.push(argv); return argv.includes("inspect") ? result("", 1) : result(); });
  expect(await ensureImagePresent({ tag: "rbox-rig:dev", dockerfile: "/repo/Dockerfile", contextDir: "/repo" })).toBe(true);
  expect(seen).toEqual([
    ["docker", "image", "inspect", "rbox-rig:dev"],
    ["docker", "build", "-t", "rbox-rig:dev", "-f", "/repo/Dockerfile", "--label", "rig=1", "/repo"],
  ]);
});

test("Apple runtime-ready path performs status, start, recheck", async () => {
  select("container"); const seen: string[][] = []; let n = 0;
  setSpawnCaptureForTests(async (a) => { seen.push(a); n++; return n === 1 ? result("", 1) : result(); });
  await ensureRuntimeReady();
  expect(seen).toEqual([["container", "system", "status"], ["container", "system", "start"], ["container", "system", "status"]]);
});

test("doctor sets and stream argv are backend-specific", () => {
  expect(runnerBackendForTests("apple-container").doctorChecks().map((c) => c.id)).toEqual(["macos-version", "arm64", "runtime-version", "runtime-ready", "disk-headroom"]);
  expect(runnerBackendForTests("docker").doctorChecks().map((c) => c.id)).toEqual(["docker-info", "local-context", "docker-disk", "docker-probe", "builder-cache", "rootless-policy"]);
  expect(streamContainerLogsArgv("rig-dev-a", "apple-container")).toEqual(["container", "logs", "--follow", "rig-dev-a"]);
  expect(streamContainerLogsArgv("rig-dev-a", "docker")).toEqual(["docker", "logs", "--follow", "rig-dev-a"]);
});

test("rootless policy uses one deterministic skip-marker outcome", async () => {
  select("docker");
  const info = JSON.stringify({ CgroupVersion: "2", MemoryLimit: true, CPUCfsQuota: true, SecurityOptions: ["name=rootless"] });
  let calls = 0;
  const seen: string[][] = [];
  setSpawnCaptureForTests(async (argv) => { seen.push(argv); calls++; return calls === 1 ? result(info) : result("", 1); });
  await assessRuntimeResourcePolicy("rbox-rig:dev");
  expect(runtimeMarkers()).toEqual(["rootless-unvalidated"]);
  expect(seen[1]?.join(" ")).toContain("memory.max");
  expect(seen[1]?.join(" ")).toContain("cpu.max");
  calls = 0;
  setSpawnCaptureForTests(async () => { calls++; return calls === 1 ? result(info) : result(); });
  await assessRuntimeResourcePolicy("rbox-rig:dev");
  expect(runtimeMarkers()).toEqual([]);
});

test("transient Docker doctor probe always cleans up its namespaced container", async () => {
  select("docker"); const seen: string[][] = [];
  setSpawnCaptureForTests(async (argv) => { seen.push(argv); return argv.includes("--attach") ? result("", 1, "probe failed") : result(); });
  expect((await runDockerDoctorProbe("/repo")).exitCode).toBe(1);
  expect(seen[0]).toContain("type=bind,source=/repo,target=/checkout,readonly");
  expect(seen.at(-1)?.slice(0, 3)).toEqual(["docker", "rm", "--force"]);
});
