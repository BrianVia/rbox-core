import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { uninstallCmd } from "./uninstall-cmd.js";

let home: string;
let rboxHome: string;
let lines: string[];

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-uninstall-home-"));
  rboxHome = path.join(home, ".rbox");
  lines = [];
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

test("dry run prints removal steps without acting", async () => {
  const stopped: string[] = [];
  let disabled = false;
  let removed = false;

  await uninstallCmd(
    {},
    {
      home,
      rboxHome,
      log: (line) => lines.push(line),
      keystoreBackupAtRisk: async () => false,
      stopDaemon: async (root) => void stopped.push(root),
      disableAutostart: async () => void (disabled = true),
      rm: async () => void (removed = true),
    }
  );

  const out = lines.join("\n");
  expect(out).toContain("dry run");
  expect(out).toContain("rbox uninstall --yes");
  expect(out).toContain("# >>> rbox PATH >>>");
  expect(stopped).toEqual([]);
  expect(disabled).toBe(false);
  expect(removed).toBe(false);
});

test("--yes stops desired daemons, falls back to raw pidfiles, disables autostart, removes ~/.rbox, and prints PATH note", async () => {
  const stopped: string[] = [];
  const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  let disabled = false;
  let removed = "";

  await fs.mkdir(path.join(rboxHome, "daemons", "legacy"), { recursive: true });
  await fs.writeFile(path.join(rboxHome, "daemons", "legacy", "daemon.pid"), "v2 4242 boot\n");
  await fs.mkdir(path.join(rboxHome, "daemons", "desired-key"), { recursive: true });
  await fs.writeFile(path.join(rboxHome, "daemons", "desired-key", "daemon.pid"), "v2 1111 boot\n");

  await uninstallCmd(
    { yes: "true" },
    {
      home,
      rboxHome,
      log: (line) => lines.push(line),
      keystoreBackupAtRisk: async () => false,
      readDesiredDaemonRows: async () => [
        {
          key: "desired-key",
          path: path.join(rboxHome, "daemons", "desired-key", "desired.json"),
          desired: {
            rootPath: "/work/project",
            state: "running",
            accountId: "acct",
            workspaceId: "ws",
            at: "2026-07-04T12:00:00.000Z",
          },
        },
      ],
      stopDaemon: async (root) => void stopped.push(root),
      kill: (pid, signal) => void killed.push({ pid, signal }),
      disableAutostart: async () => void (disabled = true),
      rm: async (target) => void (removed = String(target)),
    }
  );

  expect(stopped).toEqual(["/work/project"]);
  expect(killed).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  expect(disabled).toBe(true);
  expect(removed).toBe(rboxHome);
  const out = lines.join("\n");
  expect(out).toContain("stopped 1 daemon");
  expect(out).toContain("legacy daemon pidfile");
  expect(out).toContain("removed");
  expect(out).toContain("# >>> rbox PATH >>>");
  expect(out).toContain("# <<< rbox PATH <<<");
});

test("at-risk dry run warns about unrecoverable encrypted data and points to key backup", async () => {
  await uninstallCmd({}, {
    home,
    rboxHome,
    log: (line) => lines.push(line),
    keystoreBackupAtRisk: async () => true,
  });

  const out = lines.join("\n");
  expect(out).toContain("WARNING:");
  expect(out).toContain("UNRECOVERABLE");
  expect(out).toContain("rbox key backup");
});

test("at-risk --yes warns before removing rbox home and still proceeds", async () => {
  const events: string[] = [];
  await uninstallCmd({ yes: "true" }, {
    home,
    rboxHome,
    log: (line) => {
      lines.push(line);
      events.push(`log:${line}`);
    },
    keystoreBackupAtRisk: async () => true,
    readDesiredDaemonRows: async () => [],
    disableAutostart: async () => {},
    rm: async (target) => void events.push(`rm:${target}`),
  });

  expect(lines.join("\n")).toContain("rbox key backup");
  expect(events.findIndex((event) => event.includes("WARNING:"))).toBeLessThan(events.findIndex((event) => event.startsWith("rm:")));
  expect(events).toContain(`rm:${rboxHome}`);
});

test("not-at-risk uninstall prints no keystore warning", async () => {
  await uninstallCmd({}, {
    home,
    rboxHome,
    log: (line) => lines.push(line),
    keystoreBackupAtRisk: async () => false,
  });

  expect(lines.join("\n")).not.toContain("WARNING:");
  expect(lines.join("\n")).not.toContain("rbox key backup");
});
