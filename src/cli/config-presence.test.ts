import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfigIfPresent, WorkspaceConfigNotFoundError } from "./config.js";

test("loadConfigIfPresent maps only typed workspace-config absence to undefined", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-config-presence-"));
  try {
    await expect(loadConfigIfPresent(root)).resolves.toBeUndefined();
    const fileRoot = path.join(root, "not-a-directory");
    await fs.writeFile(fileRoot, "x");
    await expect(loadConfigIfPresent(fileRoot)).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(new WorkspaceConfigNotFoundError(root)).toMatchObject({ code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
