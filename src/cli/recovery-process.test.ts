import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));
const VALID_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

test("key recover reaches enrollment instead of silently exiting after phrase parsing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-recovery-process-"));
  let accountKeysRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/v1/keys/account") accountKeysRequests++;
      return new Response(null, { status: 404 });
    },
  });

  try {
    const child = Bun.spawn([process.execPath, CLI_ENTRY, "key", "recover"], {
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        RBOX_API: `http://127.0.0.1:${server.port}`,
        RBOX_API_QUIET: "1",
        RBOX_ACCOUNT_ID: "acct_7265636f76657279",
        RBOX_DEVICE_ID: "dev_recovery_process",
        RBOX_HOME: home,
        RBOX_TOKEN: "token_recovery_process",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(`${VALID_PHRASE}\n`);
    child.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(accountKeysRequests, `exit: ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`).toBe(1);
    expect(exitCode, `stdout: ${stdout}\nstderr: ${stderr}`).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("rbox: account has no key material (fatal)");
  } finally {
    server.stop(true);
    await fs.rm(home, { recursive: true, force: true });
  }
});
