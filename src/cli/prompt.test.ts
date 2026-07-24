import { expect, test } from "bun:test";
import path from "node:path";
import { confirmDestructive, createCheckboxPrompt, expandUserPath, PromptUnavailableError, promptPath } from "./prompt.js";
import { withInteractionPolicy } from "./prompt-policy.js";

test("confirmDestructive preserves each headless policy and the yes bypass", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  try {
    expect(await confirmDestructive({ message: "proceed", headless: "proceed" })).toBe(true);
    expect(await confirmDestructive({ message: "deny", headless: "deny" })).toBe(false);
    await expect(confirmDestructive({
      message: "require yes",
      headless: "require-yes",
      headlessError: "exact require-yes error",
    })).rejects.toThrow("exact require-yes error");
    expect(await confirmDestructive({
      message: "bypassed",
      yes: true,
      headless: "throw",
      headlessError: "must not throw",
    })).toBe(true);
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
    else delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
  }

  await expect(withInteractionPolicy(
    { enabled: false },
    () => confirmDestructive({ message: "unavailable", headless: "throw" }),
  )).rejects.toBeInstanceOf(PromptUnavailableError);
  await expect(withInteractionPolicy(
    { enabled: false },
    () => confirmDestructive({
      message: "custom unavailable",
      headless: "throw",
      headlessError: "exact full-gate error",
    }),
  )).rejects.toThrow("exact full-gate error");

  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  try {
    for (const opts of [
      { message: "proceed needs a prompt surface", headless: "proceed" as const },
      { message: "deny needs a prompt surface", headless: "deny" as const },
      {
        message: "require-yes needs a prompt surface",
        headless: "require-yes" as const,
        headlessError: "must not replace PromptUnavailableError",
      },
    ]) {
      await expect(withInteractionPolicy(
        { enabled: false },
        () => confirmDestructive(opts),
      )).rejects.toBeInstanceOf(PromptUnavailableError);
    }
  } finally {
    if (ttyDescriptor) Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
    else delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
  }
});

test("checkbox factory preserves generic values and routes the widget to the injected output", async () => {
  const output = { write() { return true; } } as unknown as NodeJS.WritableStream;
  const calls: Array<{ config: unknown; output: NodeJS.WritableStream }> = [];
  const prompt = createCheckboxPrompt({
    output,
    invoke: async <V>(config, context) => {
      calls.push({ config, output: context.output });
      return ["clipboard" as V];
    },
  });
  const config = {
    message: "Where should rbox save it?",
    choices: [
      { name: "Clipboard", value: "clipboard" as const },
      { name: "File", value: "file" as const },
    ],
  };

  expect(await prompt(config)).toEqual(["clipboard"]);
  expect(calls).toEqual([{ config, output }]);
});

test("checkbox factory translates Inquirer Ctrl-C to exit 130", async () => {
  let exitCode: number | undefined;
  const exited = new Error("exit seam");
  const cancelled = new Error("inquirer exit");
  const prompt = createCheckboxPrompt({
    invoke: async () => { throw cancelled },
    exit: (code) => {
      exitCode = code;
      throw exited;
    },
    isExitPromptError: (error) => error === cancelled,
  });

  await expect(prompt({ message: "pick", choices: [{ value: "x" }] })).rejects.toBe(exited);
  expect(exitCode).toBe(130);
});

test("expandUserPath implements the complete leading-tilde grammar", () => {
  const home = "/home/tester";
  expect(expandUserPath("~", home)).toBe(home);
  expect(expandUserPath("~/project", home)).toBe(path.join(home, "project"));
  for (const value of ["~user", "~user/project", "~foo"]) {
    expect(() => expandUserPath(value, home)).toThrow("~user paths aren't supported — use an absolute path");
  }
  expect(expandUserPath("project/~cache", home)).toBe("project/~cache");
  expect(expandUserPath("/tmp/~cache", home)).toBe("/tmp/~cache");
});

test("promptPath plain seam is byte-identical: config, retry bytes, trim, and resolution", async () => {
  const answers = ["~somebody/project", "  relative/project  "];
  const errors: string[] = [];
  const configs: unknown[] = [];
  const resolved = await promptPath({
    message: "exact path copy",
    default: "unchanged/default",
    cwd: "/injected/cwd",
    input: (async (config: unknown) => {
      configs.push(config);
      return answers.shift()!;
    }) as never,
    writeStderr: (text) => void errors.push(text),
  });
  expect(resolved).toBe("/injected/cwd/relative/project");
  expect(resolved).not.toBe(path.resolve(process.cwd(), "relative/project"));
  expect(errors).toEqual(["~user paths aren't supported — use an absolute path\n"]);
  expect(configs).toEqual([
    { message: "exact path copy", default: "unchanged/default" },
    { message: "exact path copy", default: "unchanged/default" },
  ]);
  expect(errors.join("")).not.toContain("Tab completes");
});

test("promptPath opts.input forces legacy plain mode even on a TTY and omits an undefined default", async () => {
  const configs: unknown[] = [];
  const errors: string[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  try {
    const result = await promptPath({
      message: "plain",
      cwd: "/injected/cwd",
      input: (async (config: unknown) => {
        configs.push(config);
        return "   ";
      }) as never,
      writeStderr: (text) => void errors.push(text),
    });
    expect(result).toBe("/injected/cwd");
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
    else delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
  }
  expect(configs).toEqual([{ message: "plain" }]);
  expect(errors).toEqual([]);
});
