/** Never: production timing policy, global context fallback, or test expectation changes. */
import { PhaseReport } from "../engine/phase-report.js";
import { PushSpans, type FirstPublishTiming } from "./push-spans.js";

/** Bun isolates hook async contexts from test bodies. Bind the real owner around
 * the callback and its continuations instead of relying on beforeEach.enterWith.
 * The test file supplies Bun's registrar; production typechecking needs no Bun test globals. */
export function pushSpanTests(register: (name: string, body: () => Promise<void>, timeout?: number) => void) {
  return (name: string, body: (timing: FirstPublishTiming) => void | Promise<void>, timeout?: number): void => {
    register(name, () => {
      const spans = new PushSpans(PhaseReport.disabled("push"));
      return spans.run(async () => { await body(spans.firstPublish); });
    }, timeout);
  };
}
