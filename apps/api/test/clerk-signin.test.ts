import { describe, expect, test } from "vitest";
import { signinMethodsOf } from "../src/clerk-signin.js";

describe("signinMethodsOf", () => {
  test.each([
    ["verified google", { external_accounts: [{ provider: "oauth_google", verification: { status: "verified" } }] }, "google"],
    ["verified github plus password", { external_accounts: [{ provider: "oauth_github", verification: { status: "verified" } }], password_enabled: true }, "github+password"],
    ["password only", { password_enabled: true }, "password"],
    ["OAuth only with password disabled", { external_accounts: [{ provider: "oauth_google", verification: { status: "verified" } }], password_enabled: false }, "google"],
    ["duplicate providers", { external_accounts: [{ provider: "oauth_google", verification: { status: "verified" } }, { provider: "oauth_google", verification: { status: "verified" } }] }, "google"],
    ["unknown provider", { external_accounts: [{ provider: "oauth_custom_sso", verification: { status: "verified" } }] }, "custom_sso"],
    ["empty set", {}, null],
  ] as const)("parses %s", (_name, input, expected) => {
    expect(signinMethodsOf(input)).toBe(expected);
  });

  test.each(["unverified", "failed", "expired", "transferable"])("excludes %s external accounts", (status) => {
    expect(signinMethodsOf({ external_accounts: [{ provider: "oauth_google", verification: { status } }] })).toBeNull();
  });

  test("sorts the deduplicated composite", () => {
    expect(signinMethodsOf({
      external_accounts: [
        { provider: "oauth_google", verification: { status: "verified" } },
        { provider: "oauth_github", verification: { status: "verified" } },
      ],
      password_enabled: true,
    })).toBe("github+google+password");
  });
});
