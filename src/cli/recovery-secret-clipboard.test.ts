import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  clearRecoverySecretClipboard,
  copyRecoverySecretToClipboard,
  type RecoveryClipboardChild,
  type RecoveryClipboardSpawner,
  type RecoveryClipboardStdin,
} from "./recovery-secret-clipboard.js";

class FakeStdin extends EventEmitter implements RecoveryClipboardStdin {
  retainedChunk?: Uint8Array;
  copiedBytes?: Buffer;
  throwOnEnd = false;
  callback = () => {};

  end(chunk: Uint8Array, callback: () => void): void {
    if (this.throwOnEnd) throw new Error("secret-bearing write failure");
    this.retainedChunk = chunk;
    this.copiedBytes = Buffer.from(chunk);
    this.callback = callback;
  }
}

class FakeChild extends EventEmitter implements RecoveryClipboardChild {
  stdin: FakeStdin | null = new FakeStdin();
  kills: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    return true;
  }
}

function oneChildSpawner(
  child: FakeChild,
  calls: Array<{ command: string; args: readonly string[]; options: unknown }>
): RecoveryClipboardSpawner {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
}

describe("recovery secret clipboard", () => {
  test("waits for both the complete stdin write and a zero child exit, then wipes its payload", async () => {
    const child = new FakeChild();
    const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
    let settled = false;
    const pending = copyRecoverySecretToClipboard("alpha beta gamma", {
      platform: "darwin",
      spawn: oneChildSpawner(child, calls),
    }).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    child.stdin!.callback();
    child.emit("close", 0, null);

    expect(await pending).toEqual({ ok: true, command: "pbcopy" });
    expect(calls).toEqual([{
      command: "pbcopy",
      args: [],
      options: { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
    }]);
    expect(child.stdin!.copiedBytes!.toString("utf8")).toBe("alpha beta gamma");
    expect([...child.stdin!.retainedChunk!].every((byte) => byte === 0)).toBe(true);
  });

  test("reports a synchronous or asynchronous spawn failure without child error text", async () => {
    const sync = await copyRecoverySecretToClipboard("never log me", {
      platform: "darwin",
      spawn: () => { throw new Error("contains never log me") },
    });
    expect(sync).toEqual({ ok: false, reason: "spawn-failed" });

    const child = new FakeChild();
    const pending = copyRecoverySecretToClipboard("still secret", {
      platform: "darwin",
      spawn: oneChildSpawner(child, []),
    });
    child.emit("error", new Error("still secret"));
    expect(await pending).toEqual({ ok: false, reason: "spawn-failed" });
  });

  test("classifies synchronous and asynchronous stdin failures", async () => {
    const syncChild = new FakeChild();
    syncChild.stdin!.throwOnEnd = true;
    expect(await copyRecoverySecretToClipboard("phrase", {
      platform: "darwin",
      spawn: oneChildSpawner(syncChild, []),
    })).toEqual({ ok: false, reason: "write-failed" });
    expect(syncChild.kills).toEqual(["SIGKILL"]);

    const asyncChild = new FakeChild();
    const pending = copyRecoverySecretToClipboard("phrase", {
      platform: "darwin",
      spawn: oneChildSpawner(asyncChild, []),
    });
    asyncChild.stdin!.emit("error", new Error("write failed"));
    expect(await pending).toEqual({ ok: false, reason: "write-failed" });
    expect(asyncChild.kills).toEqual(["SIGKILL"]);
  });

  test("kills and reports a bounded timeout", async () => {
    const child = new FakeChild();
    let timeoutCallback = () => {};
    let cleared = false;
    const timer = { fake: true } as unknown as ReturnType<typeof setTimeout>;
    const pending = copyRecoverySecretToClipboard("phrase", {
      platform: "darwin",
      spawn: oneChildSpawner(child, []),
      timeoutMs: 25,
      setTimer: (callback, delay) => {
        expect(delay).toBe(25);
        timeoutCallback = callback;
        return timer;
      },
      clearTimer: (value) => {
        expect(value).toBe(timer);
        cleared = true;
      },
    });

    timeoutCallback();
    expect(await pending).toEqual({ ok: false, reason: "timeout" });
    expect(child.kills).toEqual(["SIGKILL"]);
    expect(cleared).toBe(true);
  });

  test("reports nonzero exit only after the write callback", async () => {
    const child = new FakeChild();
    const pending = copyRecoverySecretToClipboard("phrase", {
      platform: "darwin",
      spawn: oneChildSpawner(child, []),
    });
    child.emit("close", 7, null);
    child.stdin!.callback();
    expect(await pending).toEqual({ ok: false, reason: "nonzero-exit" });
  });

  test("uses the platform command, falls back on Linux, and clears with an empty payload", async () => {
    const commands: string[] = [];
    const chunks: Buffer[] = [];
    const spawn: RecoveryClipboardSpawner = (command) => {
      commands.push(command);
      if (command === "xclip") throw new Error("missing");
      const child = new FakeChild();
      const originalEnd = child.stdin!.end.bind(child.stdin);
      child.stdin!.end = (chunk, callback) => {
        chunks.push(Buffer.from(chunk));
        originalEnd(chunk, callback);
        callback();
        queueMicrotask(() => child.emit("close", 0, null));
      };
      return child;
    };

    expect(await copyRecoverySecretToClipboard("words", { platform: "linux", spawn }))
      .toEqual({ ok: true, command: "xsel" });
    expect(commands).toEqual(["xclip", "xsel"]);
    expect(chunks[0]!.toString()).toBe("words");

    commands.length = 0;
    chunks.length = 0;
    expect(await clearRecoverySecretClipboard({ platform: "win32", spawn }))
      .toEqual({ ok: true, command: "clip" });
    expect(commands).toEqual(["clip"]);
    expect(chunks[0]!.byteLength).toBe(0);
  });

  test("rejects unsupported platforms and oversized input before spawning", async () => {
    let spawns = 0;
    const spawn: RecoveryClipboardSpawner = () => {
      spawns++;
      return new FakeChild();
    };
    expect(await copyRecoverySecretToClipboard("phrase", { platform: "aix", spawn }))
      .toEqual({ ok: false, reason: "unsupported-platform" });
    expect(await copyRecoverySecretToClipboard("x".repeat(4_097), { platform: "darwin", spawn }))
      .toEqual({ ok: false, reason: "input-too-large" });
    expect(spawns).toBe(0);
  });
});
