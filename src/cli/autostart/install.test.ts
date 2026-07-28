import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { enableAutostart } from "../autostart-cmd.js";
import {
  afterEachAutostartTest,
  beforeEachAutostartTest,
  fakeBinary,
  home,
} from "./test-helpers.js";

beforeEach(beforeEachAutostartTest);
afterEach(afterEachAutostartTest);

test("enable autostart writes a login-only LaunchAgent", async () => {
  const binary = await fakeBinary();
  const commands: string[] = [];
  await enableAutostart({
    platform: "darwin",
    home,
    binaryPath: binary,
    exec: async (cmd, args) => void commands.push([cmd, ...args].join(" ")),
  });

  const plistPath = path.join(home, "Library", "LaunchAgents", "to.rbox.daemon.plist");
  const plist = await fs.readFile(plistPath, "utf8");
  const resolvedBinary = await fs.realpath(binary);
  expect(plist).toContain("<key>Label</key>");
  expect(plist).toContain("<string>to.rbox.daemon</string>");
  expect(plist).toContain("<key>ProgramArguments</key>");
  expect(plist).toContain(`<string>${resolvedBinary}</string>`);
  expect(plist).toContain("<string>__boot-resume</string>");
  expect(plist).toContain("<key>RunAtLoad</key>");
  expect(plist).not.toContain("KeepAlive");
  expect(commands).toEqual([`launchctl load -w ${plistPath}`]);
});

test("enable autostart writes a oneshot systemd resume", async () => {
  const binary = await fakeBinary();
  const commands: string[] = [];
  await enableAutostart({
    platform: "linux",
    home,
    binaryPath: binary,
    exec: async (cmd, args) => void commands.push([cmd, ...args].join(" ")),
  });

  const unit = await fs.readFile(path.join(home, ".config", "systemd", "user", "rbox.service"), "utf8");
  expect(unit).toContain("Type=oneshot");
  expect(unit).toContain("RemainAfterExit=yes");
  expect(unit).toContain("load-bearing");
  expect(unit).toContain("KillMode=process");
  expect(unit).toContain(`ExecStart=${await fs.realpath(binary)} __boot-resume`);
  expect(unit).not.toContain("%h/.rbox/bin/rbox");
  expect(unit).not.toContain("Restart=");
  expect(commands).toEqual(["systemctl --user daemon-reload", "systemctl --user enable rbox.service"]);
});

for (const platform of ["darwin", "linux"] as const) {
  test(`enable autostart defaults to the resolved running binary on ${platform}`, async () => {
    const runningBinary = path.join(home, "installed-elsewhere", "rbox");
    await fs.mkdir(path.dirname(runningBinary), { recursive: true });
    await fs.writeFile(runningBinary, "#!/bin/sh\n");
    const oldExecPath = process.execPath;
    process.execPath = runningBinary;
    try {
      await enableAutostart({ platform, home, exec: async () => {} });
    } finally {
      process.execPath = oldExecPath;
    }

    const generated = platform === "darwin"
      ? await fs.readFile(path.join(home, "Library", "LaunchAgents", "to.rbox.daemon.plist"), "utf8")
      : await fs.readFile(path.join(home, ".config", "systemd", "user", "rbox.service"), "utf8");
    expect(generated).toContain(await fs.realpath(runningBinary));
    expect(generated).not.toContain(path.join(home, ".rbox", "bin", "rbox"));
  });
}

test("enable autostart falls back to the canonical binary when execPath does not exist", async () => {
  const canonical = await fakeBinary();
  const oldExecPath = process.execPath;
  process.execPath = path.join(home, "missing", "rbox");
  try {
    await enableAutostart({ platform: "linux", home, exec: async () => {} });
  } finally {
    process.execPath = oldExecPath;
  }

  const unit = await fs.readFile(path.join(home, ".config", "systemd", "user", "rbox.service"), "utf8");
  expect(unit).toContain(`ExecStart=${await fs.realpath(canonical)} __boot-resume`);
});

test("enable autostart keeps an explicit empty binary override authoritative", async () => {
  await expect(enableAutostart({ platform: "linux", home, binaryPath: "", exec: async () => {} }))
    .rejects.toThrow("rbox binary not found at ; install rbox before enabling autostart");
});

