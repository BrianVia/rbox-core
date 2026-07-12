import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assembleDevBuildArgv, hostTargetFor, withBuildScratch } from "../../scripts/dev-install.js";

test("host target uses release target strings", () => {
  expect(hostTargetFor("darwin", "arm64")).toBe("darwin-arm64");
  expect(hostTargetFor("linux", "x64")).toBe("linux-x64");
  expect(() => hostTargetFor("darwin", "x64")).toThrow(/unsupported host target/);
});

test("dev install accepts an absolute compile entry", () => {
  expect(assembleDevBuildArgv({ target: "linux-x64", version: "dev", outfile: "/tmp/rbox-dev", entry: "/abs/entry.ts" })).toContain("/abs/entry.ts");
});

test("build scratch is outside the repo and removed after success", () => {
  let scratch = "";
  const value = withBuildScratch((dir) => {
    scratch = dir;
    expect(dir.startsWith(path.join(os.tmpdir(), "rbox-dev-build-"))).toBe(true);
    expect(path.resolve(dir).startsWith(path.resolve(import.meta.dir, "../..") + path.sep)).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
    return 42;
  });
  expect(value).toBe(42);
  expect(fs.existsSync(scratch)).toBe(false);
});

test("build scratch is removed when the callback throws", () => {
  let scratch = "";
  expect(() => withBuildScratch((dir) => {
    scratch = dir;
    expect(fs.existsSync(dir)).toBe(true);
    throw new Error("compile failed");
  })).toThrow("compile failed");
  expect(fs.existsSync(scratch)).toBe(false);
});

test("dev install assembles host compile argv with dev define and release watcher externals", () => {
  expect(
    assembleDevBuildArgv({
      target: "darwin-arm64",
      version: "0.9.1-dev+03ff993.dirty",
      outfile: "/tmp/rbox-dev",
    })
  ).toEqual([
    "bun",
    "build",
    "--compile",
    "--target=bun-darwin-arm64",
    "--define",
    '__RBOX_DEV_VERSION__="0.9.1-dev+03ff993.dirty"',
    "--external",
    "@parcel/watcher-linux-arm64-glibc",
    "--external",
    "@parcel/watcher-linux-x64-glibc",
    "./src/cli/index.ts",
    "--outfile",
    "/tmp/rbox-dev",
  ]);
});
