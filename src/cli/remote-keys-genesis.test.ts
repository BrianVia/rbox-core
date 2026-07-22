import { describe, expect, test } from "bun:test";
import { bootstrapKeys } from "./remote/keys.js";
import { GenesisBootstrapTerminalError } from "./remote/errors.js";
import type { RemoteContext } from "./remote/context.js";

function context(response: Response): RemoteContext {
  return { postExactJson: async () => response } as unknown as RemoteContext;
}

describe("genesis bootstrap terminal responses", () => {
  test("410 account_erased is terminal and user-facing", async () => {
    const error = await bootstrapKeys(
      context(new Response(JSON.stringify({ error: "account_erased" }), { status: 410 })),
      "{}",
    ).catch((cause) => cause);
    expect(error).toBeInstanceOf(GenesisBootstrapTerminalError);
    expect(error).toMatchObject({ status: 410, code: "account_erased" });
    expect(String(error.message)).toContain("no longer exists");
  });

  test("other non-retryable 4xx responses are typed terminal failures", async () => {
    const error = await bootstrapKeys(
      context(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })),
      "{}",
    ).catch((cause) => cause);
    expect(error).toBeInstanceOf(GenesisBootstrapTerminalError);
    expect(error).toMatchObject({ status: 403, code: "bootstrap_rejected" });
  });
});
