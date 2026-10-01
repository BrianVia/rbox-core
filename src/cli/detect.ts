/**
 * Project detection for hydration (design 08). PURE: `detectProjects(fileList)`
 * maps a tree's paths to the ecosystems present, driven by lockfile presence.
 * No disk I/O, no execution — the executor (cli/hydrate-cmd) acts on the result.
 *
 * Security note (rule 7): the rule table is a FIXED in-binary allowlist. We
 * never derive a command from synced content. Each rule also carries a safety
 * profile so the executor can decide what may auto-run vs what executes
 * repo-controlled code (lifecycle scripts / native builds) and needs consent.
 */
export type Ecosystem = "node" | "rust" | "go" | "python" | "ruby";

export interface EcosystemRule {
  /** Stable id, e.g. "node/pnpm". */
  id: string;
  ecosystem: Ecosystem;
  /** The package-manager binary (resolved from PATH, never from the repo). */
  tool: string;
  /** Lockfiles that trigger this rule (any one present). */
  lockfiles: string[];
  /** The ecosystem manifest (for version-compat checks); optional. */
  manifestFile?: string;
  /** Base argv after the tool, e.g. ["ci"] / ["install","--frozen-lockfile"]. */
  baseArgs: string[];
  /**
   * Args that disable lifecycle scripts, or null if the tool can't (or doesn't
   * need to — bun/go/cargo-fetch don't run repo code during dep resolution).
   */
  ignoreScriptsArgs: string[] | null;
  /**
   * Does the default dep-resolution step execute repo-controlled code that
   * CANNOT be disabled? (pip/poetry/bundle compile sdists/native ext; true.)
   * Rules where this is true never auto-run without --allow-build.
   */
  fetchRunsCode: boolean;
  /** Where deps land (relative), or null for a global/module cache. */
  installDir: string | null;
  /** Tie-breaker when multiple node lockfiles coexist (higher wins). */
  precedence: number;
  /**
   * Project-local config files that can make the manager execute repo-controlled
   * code OUTSIDE lifecycle scripts (Yarn `.yarnrc.yml` → yarnPath/plugins). If any
   * is present the executor refuses to auto-run without `--allow-build`. Empty for
   * managers with no such vector (npm `.npmrc` can't run code; pnpm's `.pnpmfile.cjs`
   * is neutralized by `--ignore-pnpmfile` in ignoreScriptsArgs instead).
   */
  untrustedConfigFiles: string[];
}

/** The fixed allowlist. Order within node is resolved by `precedence`. */
export const ECOSYSTEM_RULES: EcosystemRule[] = [
  // pnpm: --ignore-scripts blocks lifecycle hooks; --ignore-pnpmfile blocks
  // `.pnpmfile.cjs` (repo code that runs OUTSIDE lifecycle).
  { id: "node/pnpm", ecosystem: "node", tool: "pnpm", lockfiles: ["pnpm-lock.yaml"], manifestFile: "package.json", baseArgs: ["install", "--frozen-lockfile"], ignoreScriptsArgs: ["--ignore-scripts", "--ignore-pnpmfile"], fetchRunsCode: false, installDir: "node_modules", precedence: 40, untrustedConfigFiles: [] },
  // yarn: `.yarnrc.yml` can set yarnPath (a repo-shipped yarn binary) or load
  // repo-local plugins → repo code at startup, which no flag fully prevents. So
  // its presence gates auto-run behind --allow-build (and we set YARN_IGNORE_PATH
  // when running). Berry's --mode=skip-build avoids the dependency build step.
  { id: "node/yarn", ecosystem: "node", tool: "yarn", lockfiles: ["yarn.lock"], manifestFile: "package.json", baseArgs: ["install", "--immutable"], ignoreScriptsArgs: ["--mode=skip-build"], fetchRunsCode: false, installDir: "node_modules", precedence: 30, untrustedConfigFiles: [".yarnrc.yml", ".yarnrc"] },
  { id: "node/bun", ecosystem: "node", tool: "bun", lockfiles: ["bun.lock", "bun.lockb"], manifestFile: "package.json", baseArgs: ["install", "--frozen-lockfile"], ignoreScriptsArgs: null /* bun gates lifecycle on trustedDependencies by default */, fetchRunsCode: false, installDir: "node_modules", precedence: 20, untrustedConfigFiles: [] },
  { id: "node/npm", ecosystem: "node", tool: "npm", lockfiles: ["package-lock.json", "npm-shrinkwrap.json"], manifestFile: "package.json", baseArgs: ["ci"], ignoreScriptsArgs: ["--ignore-scripts"], fetchRunsCode: false, installDir: "node_modules", precedence: 10, untrustedConfigFiles: [] },
  // cargo fetch / go mod download only DOWNLOAD into a GLOBAL cache (no build.rs,
  // no code execution; they do NOT reconstruct target/ or a workspace dir —
  // installDir:null marks them as dependency PREFETCH, not dir reconstruction).
  { id: "rust/cargo", ecosystem: "rust", tool: "cargo", lockfiles: ["Cargo.lock"], manifestFile: "Cargo.toml", baseArgs: ["fetch", "--locked"], ignoreScriptsArgs: null, fetchRunsCode: false, installDir: null, precedence: 0, untrustedConfigFiles: [] },
  { id: "go/modules", ecosystem: "go", tool: "go", lockfiles: ["go.sum"], manifestFile: "go.mod", baseArgs: ["mod", "download"], ignoreScriptsArgs: null, fetchRunsCode: false, installDir: null, precedence: 0, untrustedConfigFiles: [] },
  // python/ruby: dep resolution compiles sdists / native extensions = runs repo
  // (and transitive-dep) code that can't be cleanly disabled → needs consent.
  { id: "python/uv", ecosystem: "python", tool: "uv", lockfiles: ["uv.lock"], manifestFile: "pyproject.toml", baseArgs: ["sync", "--frozen"], ignoreScriptsArgs: null, fetchRunsCode: true, installDir: ".venv", precedence: 0, untrustedConfigFiles: [] },
  { id: "python/poetry", ecosystem: "python", tool: "poetry", lockfiles: ["poetry.lock"], manifestFile: "pyproject.toml", baseArgs: ["install"], ignoreScriptsArgs: null, fetchRunsCode: true, installDir: ".venv", precedence: 0, untrustedConfigFiles: [] },
  { id: "ruby/bundler", ecosystem: "ruby", tool: "bundle", lockfiles: ["Gemfile.lock"], manifestFile: "Gemfile", baseArgs: ["install"], ignoreScriptsArgs: null, fetchRunsCode: true, installDir: "vendor/bundle", precedence: 0, untrustedConfigFiles: [] },
];

export interface DetectedProject {
  /** Directory (relative, POSIX) containing the lockfile; "" = workspace root. */
  dir: string;
  rule: EcosystemRule;
  /** The relative lockfile path that triggered detection. */
  lockfile: string;
  /**
   * Multiple node lockfiles coexist and nothing disambiguated them. `rule` holds
   * the precedence fallback, but the executor MUST refuse to auto-run — picking
   * one could hydrate a dependency graph the project doesn't use. Resolve with
   * `package.json#packageManager` or `--manager`.
   */
  ambiguous: boolean;
  warnings: string[];
}

/** Disambiguation hints the (impure) caller extracts, e.g. the tool name from a
 *  dir's `package.json#packageManager` field, or a global `--manager` override. */
export interface DetectHints {
  /** dir ("" = root) → manager tool name, e.g. {"": "pnpm"} from "pnpm@8.6.0". */
  managerByDir?: Record<string, string>;
  /** Global `--manager <tool>` override, applied to every ambiguous node dir. */
  manager?: string;
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}
function baseOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * Detect hydratable projects from a flat file list (relative POSIX paths).
 *
 * Lockfile LOCATION is the unit of detection — which naturally handles
 * workspaces: pnpm/yarn/npm workspaces keep a single lockfile at the workspace
 * root, so the root install covers all sub-packages and sub-package
 * package.json files (which carry no lockfile) are not detected separately.
 * Genuinely independent nested projects DO each carry a lockfile and so each
 * hydrate in their own dir.
 *
 * Within one directory, if multiple node lockfiles coexist, the highest-
 * precedence manager wins and a warning records the ambiguity.
 */
export function detectProjects(files: string[], hints: DetectHints = {}): DetectedProject[] {
  const present = new Set(files);
  // Map: dir -> matching rules (via any lockfile in that dir).
  const byDir = new Map<string, { rule: EcosystemRule; lockfile: string }[]>();
  for (const file of files) {
    const dir = dirOf(file);
    const name = baseOf(file);
    for (const rule of ECOSYSTEM_RULES) {
      if (rule.lockfiles.includes(name)) {
        const list = byDir.get(dir) ?? [];
        list.push({ rule, lockfile: file });
        byDir.set(dir, list);
      }
    }
  }

  const out: DetectedProject[] = [];
  for (const [dir, matches] of byDir) {
    // Group by ecosystem; within node, resolve precedence + warn on ambiguity.
    const byEco = new Map<Ecosystem, { rule: EcosystemRule; lockfile: string }[]>();
    for (const m of matches) {
      const list = byEco.get(m.rule.ecosystem) ?? [];
      list.push(m);
      byEco.set(m.rule.ecosystem, list);
    }
    for (const [, ecoMatches] of byEco) {
      const sorted = [...ecoMatches].sort((a, b) => b.rule.precedence - a.rule.precedence);
      const warnings: string[] = [];
      let chosen = sorted[0]!;
      let ambiguous = false;

      if (sorted.length > 1) {
        // Multiple lockfiles (node): disambiguate via packageManager / --manager,
        // else mark ambiguous and let the executor refuse (never silently pick).
        const hinted = hints.managerByDir?.[dir] ?? hints.manager;
        const match = hinted ? sorted.find((s) => s.rule.tool === hinted) : undefined;
        if (match) {
          chosen = match;
          warnings.push(`multiple ${chosen.rule.ecosystem} lockfiles in ${dir || "."}; resolved to ${chosen.rule.tool} via packageManager/--manager`);
        } else {
          ambiguous = true;
          warnings.push(
            `ambiguous: multiple ${chosen.rule.ecosystem} lockfiles in ${dir || "."} (${sorted.map((s) => s.rule.tool).join(", ")}). Set package.json#packageManager or pass --manager <tool>`
          );
        }
      }
      if (chosen.rule.manifestFile) {
        const manifestPath = dir ? `${dir}/${chosen.rule.manifestFile}` : chosen.rule.manifestFile;
        if (!present.has(manifestPath)) warnings.push(`lockfile without ${chosen.rule.manifestFile} in ${dir || "."}`);
      }
      out.push({ dir, rule: chosen.rule, lockfile: chosen.lockfile, ambiguous, warnings });
    }
  }

  // Stable order: by dir, then ecosystem id.
  out.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : a.rule.id < b.rule.id ? -1 : 1));
  return out;
}

/**
 * Resolve the argv for a project given the safety policy.
 *  - allowBuild=false (default): auto-run only when the step does NOT execute
 *    repo code — i.e. `fetchRunsCode` is false. Lifecycle scripts are disabled
 *    via `ignoreScriptsArgs` when the tool supports it.
 *  - allowBuild=true: run the full step (lifecycle scripts / native builds),
 *    the explicit opt-in for trees the user trusts.
 * Returns null when the rule needs a build but allowBuild is false (caller
 * must skip + report "needs --allow-build").
 */
export function hydrateArgv(rule: EcosystemRule, allowBuild: boolean): string[] | null {
  if (rule.fetchRunsCode && !allowBuild) return null;
  if (!allowBuild && rule.ignoreScriptsArgs) return [...rule.baseArgs, ...rule.ignoreScriptsArgs];
  return [...rule.baseArgs];
}
