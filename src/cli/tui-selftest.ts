import { promptCheckbox, promptConfirm, promptInput, promptPassword, promptSelect } from "./prompt.js";

const fail = (message: string): never => {
  throw new Error(`tui selftest failed: ${message}`);
};

/** Hidden, deterministic PTY contract. No network, credentials, or user files. */
export async function runTuiSelftest(): Promise<void> {
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
