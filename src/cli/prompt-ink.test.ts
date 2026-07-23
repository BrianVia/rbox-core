import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  PromptCancelledError,
  editBuffer,
  inkCheckbox,
  inkConfirm,
  inkInput,
  inkKeypress,
  inkPassword,
  inkSearch,
  inkSecretRenderFailureSelftest,
  inkSelect,
  type PromptStreams,
} from "./prompt-ink.js";

interface Harness {
  streams: PromptStreams;
  input: PassThrough;
  output: () => string;
  rawModes: boolean[];
}

function harness(): Harness {
  const input = new PassThrough() as PassThrough & NodeJS.ReadStream & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(mode: boolean): unknown;
    ref(): unknown;
    unref(): unknown;
  };
  const output = new PassThrough() as PassThrough & NodeJS.WriteStream & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  input.isTTY = true;
  input.isRaw = false;
  const rawModes: boolean[] = [];
  input.setRawMode = (mode) => {
    input.isRaw = mode;
    rawModes.push(mode);
    return input;
  };
  input.ref = () => input;
  input.unref = () => input;
  output.isTTY = true;
  output.columns = 100;
  output.rows = 30;
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk.toString(); });
  return { streams: { input, output }, input, output: () => rendered, rawModes };
}

async function send(input: PassThrough, keys: readonly string[]): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (const key of keys) {
    input.write(key);
    await new Promise<void>((resolve) => setTimeout(resolve, key === "\r" ? 40 : 5));
  }
}

async function waitForOutput(h: Harness, needle: string): Promise<void> {
  for (let attempt = 0; attempt < 100 && !h.output().includes(needle); attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  if (!h.output().includes(needle)) throw new Error(`prompt did not render ${needle}`);
}

describe("Ink prompt runtime", () => {
  test("text editing keeps Unicode code points intact", () => {
    expect(editBuffer("a🙂b", 2, "", { backspace: true })).toEqual({ value: "ab", cursor: 1 });
    expect(editBuffer("a🙂b", 1, "é", {})).toEqual({ value: "aé🙂b", cursor: 2 });
  });

  test("select navigates, completes, and restores raw mode", async () => {
    const h = harness();
    const pending = inkSelect({
      message: "Choose",
      choices: [{ name: "Alpha", value: "a" }, { name: "Beta", value: "b" }],
    }, h.streams);
    await send(h.input, ["\x1b[B", "\r"]);
    expect(await pending).toBe("b");
    expect(h.output()).toContain("Beta");
    expect(h.rawModes.at(-1)).toBe(false);
  });

  test("checkbox keeps validation inline and submits multiple values", async () => {
    const h = harness();
    const pending = inkCheckbox({
      message: "Save where?",
      choices: [{ name: "File", value: "file" }, { name: "Clipboard", value: "clipboard" }],
      validate: (values) => values.length > 0 || "Choose at least one",
    }, h.streams);
    await send(h.input, ["\r"]);
    await waitForOutput(h, "Choose at least one");
    await send(h.input, [" ", "\x1b[B", " ", "\r"]);
    expect(await pending).toEqual(["file", "clipboard"]);
  });

  test("visible input edits around the cursor", async () => {
    const h = harness();
    const pending = inkInput({ message: "Name" }, h.streams);
    await send(h.input, ["hello", "\x1b[D", "!", "\r"]);
    expect(await pending).toBe("hell!o");
  });

  test("input accepts an untouched default but first typing or paste replaces it", async () => {
    const entered = harness();
    const enteredPending = inkInput({ message: "Name", default: "suggested" }, entered.streams);
    await send(entered.input, ["\r"]);
    expect(await enteredPending).toBe("suggested");

    const typed = harness();
    const typedPending = inkInput({ message: "Name", default: "suggested" }, typed.streams);
    await send(typed.input, ["a", "\r"]);
    expect(await typedPending).toBe("a");

    const pasted = harness();
    const pastedPending = inkInput({ message: "Name", default: "suggested" }, pasted.streams);
    await send(pasted.input, ["\x1b[200~pasted\x1b[201~", "\r"]);
    expect(await pastedPending).toBe("pasted");
  });

  test("cursor editing materializes the default before changing it", async () => {
    const h = harness();
    const pending = inkInput({ message: "Name", default: "abc" }, h.streams);
    await send(h.input, ["\x1b[D", "!", "\r"]);
    expect(await pending).toBe("ab!c");
  });

  test("bracketed paste is inserted as one input event", async () => {
    const h = harness();
    const pending = inkInput({ message: "Paste" }, h.streams);
    await send(h.input, ["\x1b[200~hello world\x1b[201~", "\r"]);
    expect(await pending).toBe("hello world");
  });

  test("secret input never writes the sentinel or its length", async () => {
    const h = harness();
    const secret = "rbox-pair_SECRET_SENTINEL";
    const pending = inkPassword({ message: "Paste token" }, h.streams);
    await send(h.input, [secret, "\r"]);
    expect(await pending).toBe(secret);
    expect(h.output()).not.toContain(secret);
    const visible = h.output().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    expect(visible).not.toContain(String(secret.length));
    expect(visible).toContain("received");
  });

  test("secret stays absent through validation retry, abort, render failure, and Ctrl-C", async () => {
    const secret = "rbox-secret-UNIQUE_FAILURE_SENTINEL";

    const retry = harness();
    let attempts = 0;
    const retryPending = inkPassword({
      message: "Retry secret",
      validate: () => ++attempts > 1 || "try again",
    }, retry.streams);
    await send(retry.input, [secret, "\r", "\r"]);
    expect(await retryPending).toBe(secret);
    expect(retry.output()).not.toContain(secret);

    const aborted = harness();
    const controller = new AbortController();
    const abortResult = inkPassword(
      { message: "Abort secret", signal: controller.signal },
      aborted.streams,
    ).then(() => undefined, (error: unknown) => error);
    await waitForOutput(aborted, "Abort secret");
    await send(aborted.input, [secret]);
    controller.abort();
    expect(await abortResult).toBeInstanceOf(DOMException);
    expect(aborted.output()).not.toContain(secret);

    const renderFailure = harness();
    const renderResult = inkSecretRenderFailureSelftest(renderFailure.streams)
      .then(() => undefined, (error: unknown) => error);
    await waitForOutput(renderFailure, "secret render failure");
    await send(renderFailure.input, [secret, "\r"]);
    expect(await renderResult).toBeInstanceOf(Error);
    expect(renderFailure.output()).not.toContain(secret);

    const cancelled = harness();
    const cancelResult = inkPassword({ message: "Cancel secret" }, cancelled.streams)
      .then(() => undefined, (error: unknown) => error);
    await waitForOutput(cancelled, "Cancel secret");
    await send(cancelled.input, [secret, "\x03"]);
    expect(await cancelResult).toBeInstanceOf(PromptCancelledError);
    expect(cancelled.output()).not.toContain(secret);

    for (const testHarness of [retry, aborted, renderFailure, cancelled]) {
      expect(testHarness.rawModes.at(-1)).toBe(false);
    }
  });

  test("confirm uses its default on Enter", async () => {
    const h = harness();
    const pending = inkConfirm({ message: "Continue?", default: true }, h.streams);
    await send(h.input, ["\r"]);
    expect(await pending).toBe(true);
  });

  test("confirm requires Enter to submit a typed answer — a bare key must not settle", async () => {
    const h = harness();
    const pending = inkConfirm({ message: "Create it?", default: false }, h.streams);
    await send(h.input, ["n"]);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    await send(h.input, ["\r"]);
    expect(await pending).toBe(false);
  });

  test("an aborted keypress waiter releases stdin for the next prompt", async () => {
    const h = harness();
    const controller = new AbortController();
    const waiting = inkKeypress({ signal: controller.signal }, h.streams);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    expect(await waiting).toBeUndefined();
    const next = inkInput({ message: "Name" }, h.streams);
    await send(h.input, ["ok", "\r"]);
    expect(await next).toBe("ok");
  });

  test("a second prompt on a busy stdin fails fast instead of corrupting the terminal", async () => {
    const h = harness();
    const first = inkInput({ message: "First" }, h.streams);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(inkConfirm({ message: "Second?" }, h.streams)).rejects.toThrow("already active");
    await send(h.input, ["done", "\r"]);
    expect(await first).toBe("done");
  });

  test("search ignores stale async results and selects the latest projection", async () => {
    const h = harness();
    const pending = inkSearch({
      message: "Workspace",
      source: async (term) => {
        if (!term) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return [{ name: "Old", value: "old" }];
        }
        return [{ name: `New ${term}`, value: term }];
      },
    }, h.streams);
    await send(h.input, ["x"]);
    await new Promise((resolve) => setTimeout(resolve, 70));
    await send(h.input, ["\r"]);
    expect(await pending).toBe("x");
    expect(h.output()).toContain("New x");
  });

  test("a synchronous validator failure cleans up terminal state", async () => {
    const inputHarness = harness();
    const inputPending = inkInput({
      message: "Validate",
      validate: () => { throw new Error("validator exploded"); },
    }, inputHarness.streams);
    const inputResult = inputPending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await waitForOutput(inputHarness, "Validate");
    await send(inputHarness.input, ["x", "\r"]);
    expect(await inputResult).toBeInstanceOf(Error);
    expect((await inputResult as Error).message).toBe("validator exploded");
    expect(inputHarness.rawModes.at(-1)).toBe(false);
  });

  test("a synchronous search failure cleans up terminal state", async () => {
    const searchHarness = harness();
    await expect(inkSearch({
      message: "Search",
      source: () => { throw new Error("source exploded"); },
    }, searchHarness.streams)).rejects.toThrow("source exploded");
    expect(searchHarness.rawModes.at(-1)).toBe(false);
  });

  test("Ctrl-C remains active while validation is pending", async () => {
    const h = harness();
    const pending = inkInput({
      message: "Validate forever",
      validate: () => new Promise(() => {}),
    }, h.streams);
    const result = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await waitForOutput(h, "Validate forever");
    await send(h.input, ["x", "\r", "\x03"]);
    expect(await result).toBeInstanceOf(PromptCancelledError);
    expect(h.rawModes.at(-1)).toBe(false);
  });

  test("abortable keypress resolves undefined without leaving raw mode", async () => {
    const h = harness();
    const controller = new AbortController();
    const pending = inkKeypress({ signal: controller.signal }, h.streams);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    expect(await pending).toBeUndefined();
    expect(h.rawModes.at(-1)).toBe(false);
  });
});
