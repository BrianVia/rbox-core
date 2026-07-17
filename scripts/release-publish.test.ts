import { describe, expect, test } from "bun:test";
import type { Manifest } from "../src/cli/release-verify.js";
import { publishReleaseObjects, settleWranglerProcess, type ReleaseObjectStore } from "./release-publish.js";

const manifest: Manifest = {
  version: "1.2.3",
  keyId: "test",
  artifacts: {
    "rbox-darwin-arm64": { path: "v1.2.3/rbox-darwin-arm64", sha256: "a".repeat(64) },
    "rbox-linux-arm64": { path: "v1.2.3/rbox-linux-arm64", sha256: "b".repeat(64) },
    "rbox-linux-x64": { path: "v1.2.3/rbox-linux-x64", sha256: "c".repeat(64) },
  },
};
const immutable = (key: string) => key.includes("/v1.2.3/");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("publishReleaseObjects", () => {
  test("overlaps immutable phases, then mutates the channel sequentially", async () => {
    const events: string[] = [];
    const putResolvers = new Map<string, () => void>();
    const hashResolvers = new Map<string, () => void>();
    const store: ReleaseObjectStore = {
      put: (key) => {
        events.push(`put:${key}`);
        if (!immutable(key)) return Promise.resolve();
        return new Promise<void>((resolve) => putResolvers.set(key, resolve));
      },
      sha256: (key) => {
        events.push(`hash:${key}`);
        const name = key.split("/").at(-1)!;
        return new Promise<string>((resolve) => hashResolvers.set(key, () => resolve(manifest.artifacts[name]!.sha256)));
      },
    };

    const publishing = publishReleaseObjects({ manifest, dist: "/repo/dist", store });
    await tick();
    expect(events.filter((event) => event.startsWith("put:")).length).toBe(3);
    expect(events.some((event) => event.startsWith("hash:"))).toBe(false);
    for (const resolve of putResolvers.values()) resolve();
    await tick();
    expect(events.filter((event) => event.startsWith("hash:")).length).toBe(3);
    expect(events.some((event) => event === "put:releases/version.json")).toBe(false);
    for (const resolve of hashResolvers.values()) resolve();
    await publishing;

    expect(events.slice(-6)).toEqual([
      "put:releases/rbox-darwin-arm64",
      "put:releases/rbox-linux-arm64",
      "put:releases/rbox-linux-x64",
      "put:releases/install.sh",
      "put:releases/version.json",
      "put:releases/version.json.sig",
    ]);
  });

  test("settles every immutable put and prevents all mutable work after failure", async () => {
    const events: string[] = [];
    let settled = 0;
    const store: ReleaseObjectStore = {
      put: async (key) => {
        events.push(`put:${key}`);
        if (!immutable(key)) throw new Error("mutable operation must not run");
        await tick();
        settled++;
        if (key.includes("linux-arm64")) throw new Error("injected upload failure");
      },
      sha256: async (key) => { events.push(`hash:${key}`); return ""; },
    };
    await expect(publishReleaseObjects({ manifest, dist: "/repo/dist", store })).rejects.toThrow("injected upload failure");
    expect(settled).toBe(3);
    expect(events.some((event) => event.startsWith("hash:") || !immutable(event.slice(4)))).toBe(false);
  });

  test("launches every immutable sibling when an adapter throws synchronously", async () => {
    const started: string[] = [];
    const store: ReleaseObjectStore = {
      put: (key) => {
        started.push(key);
        if (key.includes("linux-arm64")) throw new Error("synchronous failure");
        return Promise.resolve();
      },
      sha256: async () => "",
    };
    await expect(publishReleaseObjects({ manifest, dist: "/repo/dist", store })).rejects.toThrow("synchronous failure");
    expect(started).toEqual(Object.values(manifest.artifacts).map((artifact) => `releases/${artifact.path}`));
  });

  test("settles every fetch/hash and prevents mutable work after hash mismatch", async () => {
    const events: string[] = [];
    let hashes = 0;
    const store: ReleaseObjectStore = {
      put: async (key) => { events.push(`put:${key}`); },
      sha256: async (key) => {
        events.push(`hash:${key}`);
        await tick();
        hashes++;
        const name = key.split("/").at(-1)!;
        return name === "rbox-linux-arm64" ? "0".repeat(64) : manifest.artifacts[name]!.sha256;
      },
    };
    await expect(publishReleaseObjects({ manifest, dist: "/repo/dist", store })).rejects.toThrow("sha256");
    expect(hashes).toBe(3);
    expect(events.filter((event) => event.startsWith("put:")).length).toBe(3);
  });

  test("stops after each sequential mutable failure", async () => {
    const mutableKeys = [
      "releases/rbox-darwin-arm64",
      "releases/rbox-linux-arm64",
      "releases/rbox-linux-x64",
      "releases/install.sh",
      "releases/version.json",
      "releases/version.json.sig",
    ];
    for (const failedKey of mutableKeys) {
      const attempted: string[] = [];
      const store: ReleaseObjectStore = {
        put: async (key) => {
          if (!immutable(key)) attempted.push(key);
          if (key === failedKey) throw new Error("injected mutable failure");
        },
        sha256: async (key) => {
          const name = key.split("/").at(-1)!;
          return manifest.artifacts[name]!.sha256;
        },
      };
      await expect(publishReleaseObjects({ manifest, dist: "/repo/dist", store })).rejects.toThrow(failedKey);
      expect(attempted).toEqual(mutableKeys.slice(0, mutableKeys.indexOf(failedKey) + 1));
    }
  });
});

test("settleWranglerProcess waits for child exit after a stream failure", async () => {
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  let settled = false;
  const result = settleWranglerProcess({
    operation: "wrangler get releases/test",
    exited,
    output: Promise.reject(new Error("stream broke")),
    stderr: Promise.resolve("diagnostic"),
  }).finally(() => { settled = true; });
  await tick();
  expect(settled).toBe(false);
  resolveExit(1);
  await expect(result).rejects.toThrow("stream broke");
  expect(settled).toBe(true);
});
