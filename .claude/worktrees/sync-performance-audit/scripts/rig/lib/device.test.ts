import { test, expect } from "bun:test";
import { scrubSelfPrinted } from "./device.js";

// The CLI prints two secrets a redact-list can't know at call time (it generates
// them mid-run): the 24-word recovery phrase and the pairing token. The transcript
// scrub must catch exactly those line shapes and nothing that looks like normal
// sync output (pull summaries, corpus filenames).

const PHRASE = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual";
const PAIR = "tQx8mZ2kJ9vLpW3nRb4cYd.Fg7hKm1sTq5uVw9xZa3bCe6fHj8kMn2pRt4vWy7z";

test("scrub: a 24-word recovery-phrase line is masked (indentation kept)", () => {
  const out = scrubSelfPrinted(`    ${PHRASE}`);
  expect(out).toContain("[recovery phrase redacted]");
  expect(out).not.toContain("abandon");
  expect(out.startsWith("    ")).toBe(true);
});

test("scrub: a dot-joined pairing-token line is masked", () => {
  const out = scrubSelfPrinted(`    ${PAIR}\n\nOn the new machine: paste it.`);
  expect(out).toContain("[pairing token redacted]");
  expect(out).not.toContain(PAIR);
  expect(out).toContain("On the new machine");
});

test("scrub: pull summaries and corpus filenames pass through untouched", () => {
  const body = [
    "pull applied: 1 write, 0 delete, 0 conflict — +b.txt",
    "  file0007.txt",
    "Pairing token (valid ~10 min, single use — carries your encryption key):",
    "a short sentence with lowercase words but far fewer than twenty",
  ].join("\n");
  expect(scrubSelfPrinted(body)).toBe(body);
});
