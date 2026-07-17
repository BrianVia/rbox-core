import type { ScenarioReport } from "../scenarios/types.js";

/** PASS/SKIP are successful commands; any failing report exits nonzero. */
export function reportExit(report: ScenarioReport): number {
  return report.verdict === "FAIL" ? 1 : 0;
}

/** Await the CLI main promise before module evaluation completes. */
export async function assignMainExit(main: () => Promise<number>, onError: (error: unknown) => void): Promise<void> {
  try {
    process.exitCode = await main();
  } catch (error) {
    onError(error);
    process.exitCode = 1;
  }
}
