import { expect, test } from "bun:test";
import { assembleDevBuildArgv, hostTargetFor } from "../../scripts/dev-install.js";

test("host target uses release target strings", () => {
  expect(hostTargetFor("darwin", "arm64")).toBe("darwin-arm64");
  expect(hostTargetFor("linux", "x64")).toBe("linux-x64");
  expect(() => hostTargetFor("darwin", "x64")).toThrow(/unsupported host target/);
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
