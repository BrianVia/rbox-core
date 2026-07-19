import { describe, expect, test } from "bun:test";
import { assertDevClerkSecret, assertDisposableClerkUser, DEV_API, resolveTargetApi } from "./mint-account.js";

describe("mint-account hard target guard", () => {
  test.each([
    ["unset", undefined],
    ["empty", "  "],
    ["prod public", "https://api.rbox.to"],
    ["prod worker", "https://rbox-prod-api.brian-via.workers.dev"],
    ["prod with path", "https://api.rbox.to/v1"],
    ["localhost", "http://localhost:8787"],
    ["wrong scheme", "http://rbox-dev-api.brian-via.workers.dev"],
    ["non-default port", `${DEV_API}:444`],
    ["prefixed host", "https://prefix-rbox-dev-api.brian-via.workers.dev"],
    ["lookalike suffix", `${DEV_API}.evil.example`],
    ["userinfo lookalike", `https://rbox-dev-api.brian-via.workers.dev@evil.example`],
    ["alternate worker path", `${DEV_API}/v1`],
    ["query", `${DEV_API}?target=prod`],
    ["fragment", `${DEV_API}#prod`],
    ["invalid", "not a url"],
  ])("refuses %s", (_label, value) => {
    expect(() => resolveTargetApi({ RBOX_API: value })).toThrow(/refus|must be set/i);
  });

  test("accepts only the canonical dev worker root", () => {
    expect(resolveTargetApi({ RBOX_API: DEV_API })).toBe(DEV_API);
    expect(resolveTargetApi({ RBOX_API: `${DEV_API}/` })).toBe(DEV_API);
  });
});

describe("mint-account Clerk key guard", () => {
  test("accepts only non-empty development keys", () => {
    expect(() => assertDevClerkSecret("sk_test_dev-only-value")).not.toThrow();
    for (const secret of ["", "sk_test_", "sk_live_prod", "pk_test_public", "test_secret"]) {
      expect(() => assertDevClerkSecret(secret)).toThrow(/development key/i);
    }
  });
});

describe("mint-account disposable identity guard", () => {
  const accountId = "acct_0123456789abcdef";
  const disposable = {
    id: "user_dev",
    external_id: accountId,
    primary_email_address_id: "idn_primary",
    email_addresses: [{ id: "idn_primary", email_address: "e2e+abc-123@rbox.to", verification: { status: "verified" } }],
    private_metadata: { rbox_e2e_disposable: true, rbox_account_id: accountId },
  };

  test("accepts only a verified, tagged e2e primary identity", () => {
    expect(() => assertDisposableClerkUser(disposable, accountId)).not.toThrow();
    for (const user of [
      { ...disposable, external_id: "acct_ffffffffffffffff" },
      { ...disposable, private_metadata: {} },
      { ...disposable, email_addresses: [{ ...disposable.email_addresses[0], email_address: "owner@rbox.to" }] },
      { ...disposable, email_addresses: [{ ...disposable.email_addresses[0], verification: { status: "unverified" } }] },
    ]) expect(() => assertDisposableClerkUser(user, accountId)).toThrow(/refusing burn/i);
  });
});
