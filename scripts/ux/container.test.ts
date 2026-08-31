import { describe, expect, test } from "bun:test";
import { DEV_API, executionMode } from "./lib.js";
import {
  assertGuestMachineHome, containerExecPrefix, containerRboxEnv, guestMachineHome,
  uxContainerName, uxContainerPlan, uxCreateArgs, uxDestroyArgs, uxDestroyScope, uxImageHasLabel, uxListArgs, uxOwnership,
} from "./container.js";
import { UX_GUEST_RBOX } from "./binary.js";

test("container execution is the default and --host is the explicit fallback", () => {
  expect(executionMode(false)).toBe("container");
  expect(executionMode(true)).toBe("host");
});

test("run and guest names are scoped and path-safe", () => {
  expect(uxContainerName("walk-1")).toBe("ux-walk-1");
  expect(guestMachineHome("walk-1", "a")).toBe("/tmp/rbox-ux/walk-1/a");
  expect(assertGuestMachineHome("/tmp/rbox-ux/walk-1/a", "walk-1")).toEqual({ runId: "walk-1", name: "a" });
  expect(() => assertGuestMachineHome("/tmp/rbox-ux/other/a", "walk-1")).toThrow("belongs to run");
  expect(() => uxContainerName("../prod")).toThrow();
});

test("create argv uses bridge, local source mounts, and only UX container labels", () => {
  const plan = uxContainerPlan("walk", "image-hash", "/repo", undefined);
  const args = uxCreateArgs(plan);
  expect(args.slice(0, 17)).toEqual([
    "create", "--name", "ux-walk", "--network", "bridge", "--cpus", "2", "--memory", "2G",
    "--label", "ux=1", "--label", "ux.run=walk", "--label", `ux.repo=${plan.repoId}`, "--label", `ux.spec=${plan.specHash}`,
  ]);
  expect(args).toContain("type=bind,source=/repo/src,target=/app/src,readonly");
  expect(args).toContain("type=bind,source=/repo/scripts,target=/app/scripts,readonly");
  expect(args).toContain(`RBOX_API=${DEV_API}`);
  expect(args).not.toContain("rig=1");
  expect(args.at(-1)).toBe("rig-device");
});

test("compiled binary override is mounted read-only over the guest rbox shim", () => {
  const plan = uxContainerPlan("walk", "image-hash", "/repo", "/artifacts/rbox-linux-arm64");
  expect(plan.mounts.at(-1)).toEqual({
    source: "/artifacts/rbox-linux-arm64",
    target: UX_GUEST_RBOX,
    readonly: true,
  });
  expect(uxCreateArgs(plan)).toContain(
    `type=bind,source=/artifacts/rbox-linux-arm64,target=${UX_GUEST_RBOX},readonly`,
  );
});

test("prefix pins the Docker exec cwd and keeps the logical rbox surface", () => {
  const prefix = containerExecPrefix("walk", "/tmp/rbox-ux/walk/a");
  expect(prefix).toStartWith("docker exec --workdir '/tmp/rbox-ux/walk/a' 'ux-walk' env -u RBOX_TOKEN");
  expect(prefix).toContain(`RBOX_API='${DEV_API}'`);
  expect(prefix.endsWith(" rbox")).toBeTrue();
  expect(prefix).not.toContain("/app/src/cli/index.ts");
  expect(containerRboxEnv("/tmp/rbox-ux/walk/a")).toEqual({ HOME: "/tmp/rbox-ux/walk/a", RBOX_HOME: "/tmp/rbox-ux/walk/a", RBOX_API: DEV_API, RBOX_API_QUIET: "1", RBOX_APP: "" });
});

test("destroy is an explicit stop followed by forced anonymous-volume removal", () => {
  expect(uxDestroyArgs("walk")).toEqual({ stop: ["stop", "ux-walk"], remove: ["rm", "--force", "--volumes", "ux-walk"] });
  expect(uxDestroyScope("a")).toBe("machine");
  expect(uxDestroyScope()).toBe("run");
});

test("list selects live UX-labelled containers", () => {
  expect(uxListArgs()).toEqual(["ps", "--filter", "label=ux=1", "--format", "{{.Names}}\t{{.Label \"ux.run\"}}"]);
});

describe("container ownership", () => {
  const plan = uxContainerPlan("walk", "hash", "/repo", undefined);
  const matching = [{
    Config: { Image: plan.image, Env: [`RBOX_API=${DEV_API}`, "PATH=/bin"], Labels: { ux: "1", "ux.run": "walk", "ux.repo": plan.repoId, "ux.spec": plan.specHash } },
    HostConfig: { NetworkMode: "bridge" },
    Mounts: plan.mounts.map((mount) => ({ Source: mount.source, Destination: mount.target, RW: false })),
  }];

  test("accepts an exact owned container", () => expect(uxOwnership(matching, plan)).toBe("match"));
  test("permits scoped recreation only after ownership is proven", () => {
    expect(uxOwnership([{ ...matching[0], Config: { ...matching[0]!.Config, Labels: { ux: "1", "ux.run": "walk", "ux.repo": plan.repoId, "ux.spec": "old" } } }], plan)).toBe("owned-stale");
  });
  test("treats adding, removing, or replacing only the candidate mount as owned-stale", () => {
    const candidatePlan = uxContainerPlan("walk", "hash", "/repo", "/artifacts/new-rbox");
    expect(uxOwnership(matching, candidatePlan)).toBe("owned-stale");
    const oldCandidate = [{
      ...matching[0],
      Mounts: [
        ...matching[0]!.Mounts,
        { Source: "/artifacts/old-rbox", Destination: UX_GUEST_RBOX, RW: false },
      ],
    }];
    expect(uxOwnership(oldCandidate, plan)).toBe("owned-stale");
    expect(uxOwnership(oldCandidate, candidatePlan)).toBe("owned-stale");
  });
  test("owns a container a namespaced daemon reports with rewritten mount sources (#827)", () => {
    // Namespace CI runners run the job inside a container while dockerd lives
    // outside it: Source comes back prefixed with the job's rootfs and the
    // readonly flag is not echoed back.
    const namespaced = [{
      ...matching[0],
      Mounts: plan.mounts.map((mount) => ({ Source: `/namespace/containers/rootfs/dr9bhcvv6sct8/root${mount.source}`, Destination: mount.target, RW: true })),
    }];
    expect(uxOwnership(namespaced, plan)).toBe("match");
  });
  test("rejects an unlabelled same-name collision", () => expect(uxOwnership([{ Config: { Labels: {} } }], plan)).toBe("collision"));
  test("rejects another checkout and any unexpected extra mount", () => {
    expect(uxOwnership([{ ...matching[0], Config: { ...matching[0]!.Config, Labels: { ...matching[0]!.Config.Labels, "ux.repo": "another" } } }], plan)).toBe("collision");
    expect(uxOwnership([{ ...matching[0], Mounts: [...matching[0]!.Mounts, { Source: "/host", Destination: "/host", RW: true }] }], plan)).toBe("collision");
    expect(uxOwnership([{ ...matching[0], Config: { ...matching[0]!.Config, Env: [...matching[0]!.Config.Env, "RBOX_TOKEN=ambient"] } }], plan)).toBe("collision");
  });
});

test("shared image attribution requires the UX label", () => {
  expect(uxImageHasLabel([{ Config: { Labels: { rig: "1", ux: "1" } } }])).toBeTrue();
  expect(uxImageHasLabel([{ Config: { Labels: { rig: "1" } } }])).toBeFalse();
});
