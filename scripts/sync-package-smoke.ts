#!/usr/bin/env bun
// Packs src/engine exactly as npm would, installs the tarball into a fresh project, and runs
// sync-package-example.ts against it, so the published surface is proven from outside the repo.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const engine = path.resolve(import.meta.dir, "../src/engine");
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-sync-consumer-"));
const run = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited ${r.exitCode}`);
};
run(["bun", "pm", "pack", "--destination", dir, "--quiet"], engine);
const [tarball] = (await fs.readdir(dir)).filter((f) => f.endsWith(".tgz"));
await fs.writeFile(
  path.join(dir, "package.json"),
  JSON.stringify({ name: "consumer", type: "module", dependencies: { "@rbox/sync": `file:./${tarball}` } }),
);
run(["bun", "install", "--silent"], dir);
await fs.copyFile(path.join(import.meta.dir, "sync-package-example.ts"), path.join(dir, "example.ts"));
run(["bun", "example.ts"], dir);
await fs.rm(dir, { recursive: true, force: true });
