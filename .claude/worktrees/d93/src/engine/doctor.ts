/**
 * Host-vs-project readiness evaluation for hydration (design 08, MF6). PURE:
 * `evaluateReadiness(probes, hostTools)` decides whether THIS machine can
 * hydrate/build each detected project. Tool probing (PATH scan, `--version`
 * from a neutral cwd) is the impure caller's job; this file only judges.
 *
 * Version checks are deliberately PRAGMATIC: hard-fail a missing tool or an
 * incompatible major/minimum; WARN (don't fail) on ranges we can't cheaply
 * decide. Full semver-range satisfaction is a rabbit hole we stay out of.
 */
export interface HostTool {
  /** Tool/runtime name as probed: "node", "pnpm", "go", "rustc", "python", … */
  name: string;
  present: boolean;
  /** Installed version string, raw (e.g. "v20.11.0", "go1.21.5"); undefined if absent. */
  version?: string;
}

export interface VersionRequirement {
  /** Runtime the constraint targets, e.g. "node", "go", "rustc", "python". */
  tool: string;
  /** Raw constraint from the manifest, e.g. ">=18", "1.21", "^1.70", ">=3.11". */
  constraint: string;
}

export interface ProjectProbe {
  dir: string;
  ecosystem: string;
  /** The package-manager tool the project needs (e.g. "pnpm"). */
  tool: string;
  /** Runtime version requirements extracted from the manifest (may be empty). */
  requirements: VersionRequirement[];
}

export type ReadinessStatus = "ready" | "missing-tool" | "version-mismatch" | "warn";

export interface ProjectReadiness {
  dir: string;
  ecosystem: string;
  status: ReadinessStatus;
  detail: string;
  fix?: string;
}

export interface ReadinessReport {
  projects: ProjectReadiness[];
  /** false if any project has a hard gap (missing tool / incompatible major). */
  ok: boolean;
}

/** First run of digits in a version string → major number, or null. */
export function parseMajor(version: string | undefined): number | null {
  if (!version) return null;
  const m = version.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Minimum major a constraint demands, or null when it's not a simple form we
 *  decide. Handles "18", ">=18", ">=18.2", "^18", "~18", "1.21", ">= 3.11". */
export function minMajor(constraint: string): number | null {
  const c = constraint.trim();
  // Reject genuinely complex forms (ranges with multiple comparators, ||, <, x).
  if (/\|\||\s<|<\s|\bx\b|\*/.test(c)) return null;
  const m = c.match(/(?:>=|\^|~)?\s*(\d+)/);
  if (!m) return null;
  // A bare upper bound or exact pin we still treat as "needs at least this major".
  return Number(m[1]);
}

/**
 * `satisfies` is tri-state: true (ok), false (incompatible major), null
 * (can't decide → warn, don't fail).
 */
export function satisfiesMajor(installed: string | undefined, constraint: string): boolean | null {
  const have = parseMajor(installed);
  const need = minMajor(constraint);
  if (have === null || need === null) return null;
  return have >= need;
}

export function evaluateReadiness(probes: ProjectProbe[], hostTools: HostTool[]): ReadinessReport {
  const byName = new Map(hostTools.map((t) => [t.name, t]));
  const projects: ProjectReadiness[] = [];
  let ok = true;

  for (const p of probes) {
    const tool = byName.get(p.tool);
    if (!tool || !tool.present) {
      ok = false;
      projects.push({ dir: p.dir, ecosystem: p.ecosystem, status: "missing-tool", detail: `${p.tool} not found on PATH`, fix: `install ${p.tool}` });
      continue;
    }

    let worst: ReadinessStatus = "ready";
    const notes: string[] = [];
    for (const req of p.requirements) {
      const rt = byName.get(req.tool);
      if (!rt || !rt.present) {
        ok = false;
        worst = "missing-tool";
        notes.push(`${req.tool} (need ${req.constraint}) not found`);
        continue;
      }
      const sat = satisfiesMajor(rt.version, req.constraint);
      if (sat === false) {
        ok = false;
        if (worst !== "missing-tool") worst = "version-mismatch";
        notes.push(`${req.tool} ${rt.version} does not satisfy ${req.constraint}`);
      } else if (sat === null) {
        if (worst === "ready") worst = "warn";
        notes.push(`${req.tool} ${rt.version} vs ${req.constraint} (unverified range)`);
      }
    }

    projects.push({
      dir: p.dir,
      ecosystem: p.ecosystem,
      status: worst,
      detail: worst === "ready" ? (tool.version ?? `${p.tool} present`) : notes.join("; "),
      fix: worst === "version-mismatch" ? "install/select a compatible runtime version" : undefined,
    });
  }

  return { projects, ok };
}
