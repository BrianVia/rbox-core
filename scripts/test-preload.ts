// Test preload (bunfig.toml). Design 108's files-first defaults ON in production;
// the broad suite predates that and pins the legacy path — which stays supported
// as the RBOX_FILES_FIRST=0 kill switch. files-first.test.ts sets the flag itself.
import { afterAll } from "bun:test";

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
// Same reasoning for design 211's binding registry (~/.rbox/workspaces.json): it
// is host-global, and suites that never set RBOX_HOME would otherwise record
// their throwaway tmp roots in the developer's real registry. Honored ONLY when
// RBOX_HOME is unset, so fixtures that redirect ~/.rbox still control it.
process.env.RBOX_TEST_BINDING_REGISTRY_DIR = `/tmp/rbox-test-binding-registry-${process.pid}`;
// Design 231's catalog is also host-global. Runtime admission makes many more
// suites read it, so keep those tests away from the developer's real HOME too.
// An explicit RBOX_HOME still wins for fixtures that exercise the real layout.
process.env.RBOX_TEST_FOLDER_CATALOG_DIR = `/tmp/rbox-test-folder-catalog-${process.pid}`;
// Flake registry: product-created repos appear mid-test, so repo config cannot
// cover them; cleanGitEnv's process.env spread carries this to every git spawn.
process.env.GIT_CONFIG_COUNT = "2";
process.env.GIT_CONFIG_KEY_0 = "maintenance.auto";
process.env.GIT_CONFIG_VALUE_0 = "false";
process.env.GIT_CONFIG_KEY_1 = "gc.auto";
process.env.GIT_CONFIG_VALUE_1 = "0";

// Shard-leak guard (#660/#678). `bun test` runs every file of a shard in ONE
// process, so a file that sets HOME/RBOX_* and never restores it silently
// reconfigures every file scheduled after it. The victim rotates with shard
// composition, which is why those failures never reproduce locally from the
// failing file alone. Bun gives preload no per-file hook, so the check runs
// once at process exit: the drift is attributed to the shard, and CI names it
// deterministically instead of surfacing it as somebody else's flake.
type Env = Record<string, string | undefined>;

/** Every key whose value differs, plus cwd, rendered one per line. Empty means no leak. */
export function stateDrift(before: Env, after: Env, cwdBefore: string, cwdAfter: string): string[] {
  const drift = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => before[key] !== after[key])
    .sort()
    .map((key) => `  ${key}: ${JSON.stringify(before[key])} -> ${JSON.stringify(after[key])}`);
  if (cwdBefore !== cwdAfter) drift.push(`  process.cwd(): ${cwdBefore} -> ${cwdAfter}`);
  return drift;
}

const ENV_AT_PRELOAD = { ...process.env };
const CWD_AT_PRELOAD = process.cwd();

afterAll(() => {
  const drift = stateDrift(ENV_AT_PRELOAD, process.env, CWD_AT_PRELOAD, process.cwd());
  if (drift.length === 0) return;
  throw new Error(
    `test process leaked state past its file — later files in this shard ran against it:\n${drift.join("\n")}\n` +
    "Restore what you set (afterEach/afterAll), or set it on the child process you spawn instead of this one.",
  );
});
