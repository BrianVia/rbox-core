import { describe, expect, test } from "bun:test";
import { parseDeviceApproval } from "./web-pairing.js";

describe("parseDeviceApproval", () => {
  const fp = "A".repeat(43);

  test("extracts userCode + fingerprint from the printed approval URL", () => {
    const log = `\nTo authorize this device, visit:\n\n    https://app.rbox.to/cli-login?code=ABCD-EFGH#fp=${fp}\n\nWaiting for approval...`;
    expect(parseDeviceApproval(log)).toEqual({ userCode: "ABCD-EFGH", fingerprint: fp });
  });

  test("returns undefined before the URL is printed", () => {
    expect(parseDeviceApproval("Waiting for encryption keys...")).toBeUndefined();
  });

  test("requires the fragment fingerprint (a bare code is not enough to key-approve)", () => {
    expect(parseDeviceApproval("https://app.rbox.to/cli-login?code=ABCD-EFGH")).toBeUndefined();
  });

  test("rejects a malformed userCode alphabet (no 0/O/1/I)", () => {
    expect(parseDeviceApproval(`?code=ABC0-EFGH#fp=${fp}`)).toBeUndefined();
  });
});
