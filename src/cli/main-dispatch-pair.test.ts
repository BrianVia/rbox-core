import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main, type MainDispatchDeps } from "./main-dispatch.js";

const oldArgv = process.argv;
const oldRboxHome = process.env.RBOX_HOME;
const oldStderrWrite = process.stderr.write;
let temp: string;
let stderr = "";

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pair-dispatch-"));
  process.env.RBOX_HOME = temp;
  process.exitCode = 0;
  stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
});

afterEach(async () => {
  process.argv = oldArgv;
  process.stderr.write = oldStderrWrite;
  process.exitCode = 0;
  if (oldRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = oldRboxHome;
  await fs.rm(temp, { recursive: true, force: true });
});

function harness(promptedToken = "prompt-token") {
  let imports = 0;
  let creates = 0;
  let reads = 0;
  const redeems: Array<{ remote: string; token: string }> = [];
  const deps: MainDispatchDeps = {
    authCommandImport: async () => {
      imports++;
      return {
        pairCreate: async () => { creates++; },
        readPairingTokenInteractive: async () => { reads++; return promptedToken; },
        redeemPair: async (remote, token) => { redeems.push({ remote, token }); },
      };
    },
  };
  return { deps, state: () => ({ imports, creates, reads, redeems }) };
}

test("pair creates with no argument and rejects arguments before importing or minting", async () => {
  const ok = harness();
  process.argv = [process.execPath, "rbox", "pair"];
  await main(ok.deps);
  expect(ok.state()).toMatchObject({ imports: 1, creates: 1, reads: 0, redeems: [] });

  const bad = harness();
  process.argv = [process.execPath, "rbox", "pair", "unexpected"];
  await main(bad.deps);
  expect(stderr).toContain('unexpected argument "unexpected"');
  expect(stderr).toContain("usage: rbox pair");
  expect(process.exitCode).toBe(1);
  expect(bad.state()).toMatchObject({ imports: 0, creates: 0, reads: 0, redeems: [] });
});

test("connect argument bypasses prompt and redeems exactly once against the selected remote", async () => {
  const h = harness();
  process.argv = [process.execPath, "rbox", "connect", "rbox-pair_token.secret", "--remote", "https://api.test"];
  await main(h.deps);
  expect(h.state()).toMatchObject({
    imports: 1,
    creates: 0,
    reads: 0,
    redeems: [{ remote: "https://api.test", token: "rbox-pair_token.secret" }],
  });
});

test("bare connect retains the prompt-or-stdin reader", async () => {
  const h = harness("token-from-reader");
  process.argv = [process.execPath, "rbox", "connect"];
  await main(h.deps);
  expect(h.state()).toMatchObject({
    imports: 1,
    creates: 0,
    reads: 1,
    redeems: [{ token: "token-from-reader" }],
  });
});

test("connect rejects extra arguments before importing, prompting, or redeeming", async () => {
  const h = harness();
  process.argv = [process.execPath, "rbox", "connect", "token", "extra"];
  await main(h.deps);
  expect(stderr).toContain('unexpected argument "extra"');
  expect(stderr).toContain("usage: rbox connect");
  expect(process.exitCode).toBe(1);
  expect(h.state()).toMatchObject({ imports: 0, creates: 0, reads: 0, redeems: [] });
});
