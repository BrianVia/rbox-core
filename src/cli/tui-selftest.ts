import { promptCheckbox, promptConfirm, promptInput, promptPassword, promptSelect } from "./prompt.js";

const fail = (message: string): never => {
  throw new Error(`tui selftest failed: ${message}`);
};

/** Hidden, deterministic PTY contract. No network, credentials, or user files. */
export async function runTuiSelftest(mode = process.argv[3] ?? "full"): Promise<void> {
  if (mode === "secret-retry") {
    let attempts = 0;
    const secret = await promptPassword({
      message: "TUI selftest: retry secret",
      validate: () => ++attempts > 1 || "try the same secret again",
    });
    if (!secret) fail("secret retry");
    process.stdout.write("tui-selftest secret-retry ok\n");
    return;
  }
  if (mode === "secret-abort") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    try {
      await promptPassword({ message: "TUI selftest: abort secret", signal: controller.signal });
      fail("secret abort resolved");
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "AbortError") throw error;
    } finally {
      clearTimeout(timer);
    }
    process.stdout.write("tui-selftest secret-abort ok\n");
    return;
  }
  if (mode === "secret-render-error") {
    const { inkSecretRenderFailureSelftest } = await import("./prompt-ink.js");
    try {
      await inkSecretRenderFailureSelftest();
      fail("secret render error resolved");
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "synthetic secret render failure") throw error;
    }
    process.stdout.write("tui-selftest secret-render-error ok\n");
    return;
  }
  if (mode === "secret-cancel") {
    await promptPassword({ message: "TUI selftest: cancel secret" });
    fail("secret cancel resolved");
  }
  if (mode !== "full") fail(`unknown mode ${mode}`);

  const selected = await promptSelect({
    message: "TUI selftest: choose beta",
    choices: [
      { name: "Alpha", value: "alpha" },
      { name: "Beta", value: "beta" },
    ],
  });
  if (selected !== "beta") fail("select");

  const checked = await promptCheckbox({
    message: "TUI selftest: select both",
    choices: [
      { name: "One", value: "one" },
      { name: "Two", value: "two" },
    ],
    validate: (values) => values.length === 2 || "select both",
  });
  if (checked.join(",") !== "one,two") fail("checkbox");

  if (await promptInput({ message: "TUI selftest: type ink" }) !== "ink") fail("input");
  if (await promptPassword({ message: "TUI selftest: enter secret" }) !== "hush") fail("secret");
  if (!(await promptConfirm({ message: "TUI selftest: finish?", default: false }))) fail("confirm");
  process.stdout.write("tui-selftest ok\n");
}
