import { expect, test } from "bun:test";

test("guided setup requires consequence confirmation for create-new and different-existing choices", async () => {
  const child = Bun.spawn([
    process.execPath,
    new URL("./setup-rebind-confirm.fixture.js", import.meta.url).pathname,
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    confirmations: [
      "Create a brand-new workspace for it anyway? (files on disk are untouched; sync history starts fresh)",
      "Rebind it to workspace ws_new? (files on disk are untouched; sync history starts fresh)",
    ],
    createBinding: "ws_old",
    existingBinding: "ws_old",
  });
});
