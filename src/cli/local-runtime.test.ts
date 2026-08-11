import { expect, test } from "bun:test";

test("LocalRuntime owns one lease and exposes only reachable foreground policies", async () => {
  const child = Bun.spawn([
    process.execPath,
    new URL("./local-runtime.fixture.js", import.meta.url).pathname,
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(exit, stderr).toBe(0);
  const result = JSON.parse(stdout) as {
    runs: Array<{
      label: string;
      report: string;
      execute: string;
      allowPull?: boolean;
      allowPush?: boolean;
      hint?: string;
      cfg: ReturnType<typeof expectedCfg>;
      trace: string[];
    }>;
    failedTrace: string[];
    refusalTrace: string[];
    refusal: string;
    authorityCalls: number;
    admissionCalls: number;
  };
  expect(result.runs).toEqual([
    run("pull:guarded", "pull", "pull", false),
    run("pull:allow", "pull", "pull", true),
    run("push:guarded", "push", "push", undefined, false),
    run("push:allow", "push", "push", undefined, true),
    run("sync:pull-only:guard-both", "pull", "pull", false, false, "SYNC_HINT"),
    run("sync:pull-only:allow-push", "pull", "pull", false, true, "SYNC_HINT"),
    run("sync:pull-only:allow-both", "pull", "pull", true, true, "SYNC_HINT"),
    run("sync:pull-push:guard-both", "sync", "sync", false, false, "SYNC_HINT"),
    run("sync:pull-push:allow-push", "sync", "sync", false, true, "SYNC_HINT"),
    run("sync:pull-push:allow-both", "sync", "sync", true, true, "SYNC_HINT"),
  ]);
  expect(result.failedTrace).toEqual([
    "lease:acquired",
    "remote:built",
    "authority:pinned",
    "admission:pinned",
    "report:pull",
    "execute:pull:failed",
    "lease:released",
  ]);
  expect(result.refusalTrace).toEqual([
    "lease:acquired",
    "remote:built",
    "authority:pinned",
    "admission:pinned",
    "lease:released",
  ]);
  expect(result.refusal).toContain("rbox config add");
  expect(result.authorityCalls).toBe(12);
  expect(result.admissionCalls).toBe(12);
});

function run(
  label: string,
  report: string,
  execute: string,
  allowPull?: boolean,
  allowPush?: boolean,
  hint?: string,
) {
  return {
    label,
    report,
    execute,
    ...(allowPull === undefined ? {} : { allowPull }),
    ...(allowPush === undefined ? {} : { allowPush }),
    ...(hint === undefined ? {} : { hint }),
    cfg: expectedCfg(),
    trace: [
      "lease:acquired",
      "remote:built",
      "authority:pinned",
      "admission:pinned",
      `report:${report}`,
      `execute:${execute}`,
      "complete",
      "lease:released",
    ],
  };
}

function expectedCfg() {
  return {
    syncGit: false,
    incremental: false,
    respectGitignore: true,
    noDrift: true,
    trash: { days: 7, maxBytes: 99 },
    encrypted: true,
    kekByte: 7,
    remoteUrl: "https://credential.invalid",
    token: "runtime-token",
  };
}
