import { expect, test } from "bun:test";

test("daemon startup admits and applies policy before constructing runtime", async () => {
  const child = Bun.spawn([
    process.execPath,
    new URL("./daemon-folder-policy.fixture.js", import.meta.url).pathname,
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit, stderr).toBe(0);
  const result = JSON.parse(stdout);

  expect(result.admittedTrace).toEqual(["authority", "admission", "remote"]);
  expect(result.detachedTrace).toEqual(["authority", "admission"]);
  expect(result.damagedTrace).toEqual(["authority"]);
  expect(result.remoteCalls).toBe(1);
  expect(result.detached).toContain("rbox config add");
  expect(result.damaged).toContain("exact parse failure");
  expect(result.damaged).toContain("rbox config regenerate");
  expect(result.cfg).toEqual({
    syncGit: false,
    incremental: false,
    respectGitignore: true,
    noDrift: true,
    trash: { days: 0, maxBytes: 0 },
    encrypted: true,
    kekByte: 7,
    remoteUrl: "https://credential.invalid",
    token: "runtime-token",
  });
});
