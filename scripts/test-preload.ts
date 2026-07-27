// Test preload (bunfig.toml). Design 108's files-first defaults ON in production;
// the broad suite predates that and pins the legacy path — which stays supported
// as the RBOX_FILES_FIRST=0 kill switch. files-first.test.ts sets the flag itself.
export const API_HARNESS_ERROR = "apps/api tests need the Workers harness — run: bun run test:api";

export function targetsApiTests(argv: string[]): boolean {
  return argv.some((value) => /(^|[\\/])apps[\\/]api[\\/]test(?:[\\/]|$)/.test(value));
}

// Bun cannot provide cloudflare:test or the Miniflare bindings. Stop before it
// partially executes a Workers suite and prints misleading application failures.
if (targetsApiTests(process.argv)) throw new Error(API_HARNESS_ERROR);

process.env.RBOX_FILES_FIRST = "0";
process.env.RBOX_WATCHER_RETRUST = "0";
// Designs 109/111/112 also default ON in production (founder call, single-user fleet);
// the broad suite predates the flips and pins the legacy paths — kill-switch
// coverage. The dedicated default tests assert the unset-env defaults are ON.
process.env.RBOX_BATCH_FILL = "v1";
process.env.RBOX_REDEEM_DRAIN = "off";
process.env.RBOX_AUTH_GRANT = "0";
// Lock identity history is intentionally host-global in production. Keep the
// test runner's ledger writable and process-local without changing HOME (many
// fixtures exercise HOME/RBOX_HOME precedence explicitly).
process.env.RBOX_TEST_HOST_IDENTITY_DIR = `/tmp/rbox-test-host-identity-${process.pid}`;
// Flake registry: product-created repos appear mid-test, so repo config cannot
// cover them; cleanGitEnv's process.env spread carries this to every git spawn.
process.env.GIT_CONFIG_COUNT = "2";
process.env.GIT_CONFIG_KEY_0 = "maintenance.auto";
process.env.GIT_CONFIG_VALUE_0 = "false";
process.env.GIT_CONFIG_KEY_1 = "gc.auto";
process.env.GIT_CONFIG_VALUE_1 = "0";
