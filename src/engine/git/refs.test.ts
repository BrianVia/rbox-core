import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git } from "./shared.js";
import { readAllRefsStrict } from "./refs.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function emptyRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-strict-refs-"));
  roots.push(root);
  await git(root, ["init", "-b", "main"]);
  return root;
}

test("strict ref read distinguishes a legitimate empty repository", async () => {
  const root = await emptyRepo();
  expect(await readAllRefsStrict(root)).toEqual({ status: "ok", refs: {} });
});

test("strict ref read never turns a corrupt ref database into empty refs", async () => {
  const root = await emptyRepo();
  await fs.mkdir(path.join(root, ".git", "refs", "heads"), { recursive: true });
  await fs.writeFile(path.join(root, ".git", "refs", "heads", "broken"), "not-an-oid\n");
  const result = await readAllRefsStrict(root);
  expect(result.status).toBe("unreadable");
  if (result.status === "unreadable") expect(result.marker).toMatch(/^exit-/);
});
