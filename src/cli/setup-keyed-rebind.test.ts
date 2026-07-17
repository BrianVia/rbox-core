import { expect, test } from "bun:test";

test("keyed setup refuses a mismatched target before key materialization or target writes", async () => {
  const child = Bun.spawn([
    process.execPath,
    new URL("./setup-keyed-rebind.fixture.js", import.meta.url).pathname,
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    refused: true,
    materializeCalls: 0,
    targetUnchanged: true,
    sentinel: "unchanged",
    home: "unchanged-home",
  });
});
