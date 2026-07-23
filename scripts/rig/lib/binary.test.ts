import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { resolveRigBinaryOverride, rigGuestMounts } from "./binary.js";
import { GUEST } from "./config.js";

function fakeFs(options: { file?: boolean; symlink?: boolean; canonical?: string; executable?: boolean } = {}) {
  return {
    lstatSync(file: string) {
      if (options.file === false) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { isFile: () => true, isSymbolicLink: () => options.symlink === true };
    },
    accessSync() {
      if (options.executable === false) throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
    realpathSync(file: string) {
      return options.canonical ?? file;
    },
  };
}

describe("rig --binary", () => {
  test("is optional and validates an exact executable before use", () => {
    expect(resolveRigBinaryOverride({}, fakeFs())).toBeUndefined();
    expect(resolveRigBinaryOverride({ binary: "/tmp/rbox" }, fakeFs())).toBe("/tmp/rbox");
    expect(() => resolveRigBinaryOverride({ binary: "dist/rbox" }, fakeFs())).toThrow("exact absolute");
    expect(() => resolveRigBinaryOverride({ binary: "/tmp/../tmp/rbox" }, fakeFs())).toThrow("exact absolute");
    expect(() => resolveRigBinaryOverride({ binary: "/tmp/rbox" }, fakeFs({ file: false }))).toThrow("does not exist");
    expect(() => resolveRigBinaryOverride({ binary: "/tmp/rbox" }, fakeFs({ symlink: true }))).toThrow("non-symlink");
    expect(() => resolveRigBinaryOverride({ binary: "/tmp/rbox" }, fakeFs({ canonical: "/private/tmp/rbox" }))).toThrow("canonical");
    expect(() => resolveRigBinaryOverride({ binary: "/tmp/rbox" }, fakeFs({ executable: false }))).toThrow("executable");
  });

  test("checks execute access", () => {
    let mode = 0;
    resolveRigBinaryOverride({ binary: "/tmp/rbox" }, {
      ...fakeFs(),
      accessSync(_file, requested) { mode = requested; },
    });
    expect(mode).toBe(fs.constants.X_OK);
  });

  test("mounts the staged single-file candidate directory after checkout mounts", () => {
    expect(rigGuestMounts("/repo")).toEqual([
      { source: "/repo/src", target: GUEST.srcMount, readonly: true },
      { source: "/repo/scripts", target: GUEST.scriptsMount, readonly: true },
    ]);
    expect(rigGuestMounts("/repo", "/artifacts/staged")).toEqual([
      { source: "/repo/src", target: GUEST.srcMount, readonly: true },
      { source: "/repo/scripts", target: GUEST.scriptsMount, readonly: true },
      { source: "/artifacts/staged", target: "/opt/rbox/bin", readonly: true },
    ]);
  });
});
