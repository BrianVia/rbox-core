import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { resolveUxBinaryOverride } from "./binary.js";

function fakeFs(options: { file?: boolean; symlink?: boolean; canonical?: string; executable?: boolean } = {}) {
  return {
    lstatSync(file: string) {
      if (options.file === false) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return {
        isFile: () => true,
        isSymbolicLink: () => options.symlink === true,
      };
    },
    accessSync() {
      if (options.executable === false) throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
    realpathSync(file: string) {
      return options.canonical ?? file;
    },
  };
}

describe("RBOX_UX_BINARY", () => {
  test("is optional and preserves source-mode defaults", () => {
    expect(resolveUxBinaryOverride({}, fakeFs())).toBeUndefined();
    expect(resolveUxBinaryOverride({ RBOX_UX_BINARY: "" }, fakeFs())).toBeUndefined();
  });

  test("accepts only an exact canonical absolute executable", () => {
    expect(resolveUxBinaryOverride({ RBOX_UX_BINARY: "/tmp/rbox" }, fakeFs())).toBe("/tmp/rbox");
    expect(() => resolveUxBinaryOverride({ RBOX_UX_BINARY: "dist/rbox" }, fakeFs())).toThrow("exact absolute");
    expect(() => resolveUxBinaryOverride({ RBOX_UX_BINARY: "/tmp/../tmp/rbox" }, fakeFs())).toThrow("exact absolute");
    expect(() => resolveUxBinaryOverride({ RBOX_UX_BINARY: "/tmp/rbox" }, fakeFs({ file: false }))).toThrow("does not exist");
    expect(() => resolveUxBinaryOverride({ RBOX_UX_BINARY: "/tmp/rbox" }, fakeFs({ symlink: true }))).toThrow("non-symlink");
    expect(() => resolveUxBinaryOverride({ RBOX_UX_BINARY: "/tmp/rbox" }, fakeFs({ canonical: "/private/tmp/rbox" }))).toThrow("canonical");
    expect(() => resolveUxBinaryOverride({ RBOX_UX_BINARY: "/tmp/rbox" }, fakeFs({ executable: false }))).toThrow("executable");
  });

  test("checks execute access rather than read access", () => {
    let mode = 0;
    resolveUxBinaryOverride({ RBOX_UX_BINARY: "/tmp/rbox" }, {
      ...fakeFs(),
      accessSync(_file, requested) { mode = requested; },
    });
    expect(mode).toBe(fs.constants.X_OK);
  });
});
