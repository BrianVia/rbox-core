/**
 * PURE Markdown render of a run: the scenario verdict + steps/assertions plus the
 * P1 capture summary (device resource budgets, server tail, AE aggregate, artifact
 * index). No timestamps are invented — everything comes from `report.json` and the
 * {@link CaptureSummary}. Unit-tested against a full fixture AND a capture-all-
 * skipped fixture (must never throw). Keeping it pure means the report can be
 * re-rendered from artifacts without a container.
 */
import type { RigSourceCommit } from "./binary.js";
import type { ScenarioReport } from "../scenarios/types.js";
import { isSkipped, type CaptureSummary, type ServerMetricsSummary, type StatSummary, type TailSummary } from "./capture.js";

function n1(x: number): string {
  return (Math.round(x * 10) / 10).toLocaleString("en-US");
}

function commitCell(source: RigSourceCommit | undefined): string {
  if (!source) return "—";
  return `${source.commit.slice(0, 12)}${source.dirty ? " (dirty)" : " (clean)"}`;
}

function statLine(label: string, s: StatSummary | { skipped: string }): string {
  if (isSkipped(s)) return `| ${label} | _skipped: ${s.skipped}_ |`;
  return `| ${label} | peak mem ${n1(s.peakMemMB)} MB · peak CPU ${n1(s.peakCpuPct)}% · ${n1(s.cpuCoreSecondsTotal)} core-s · ${s.samples} samples |`;
}

function tailLine(t: TailSummary | { skipped: string }): string {
  if (isSkipped(t)) return `- **wrangler tail**: _skipped — ${t.skipped}_`;
  return `- **wrangler tail**: ${t.total} events · ${t.errors} errors · ${t.waf403s} × 403 (WAF)`;
}

function aeBlock(ae: ServerMetricsSummary | { skipped: string }): string[] {
  if (isSkipped(ae)) return [`- **Analytics Engine**: _skipped — ${ae.skipped}_`];
  const lines = [`- **Analytics Engine**: ${ae.totalOps} ops · ${ae.errorOps} error-outcome`];
  if (ae.topOps.length > 0) {
    lines.push("", "| op | outcome | n | avg ms |", "| --- | --- | ---: | ---: |");
    for (const o of ae.topOps) lines.push(`| ${o.op} | ${o.outcome} | ${o.n} | ${n1(o.avgMs)} |`);
  }
  return lines;
}

/** Render the full run report as Markdown. PURE. */
export function renderReportMd(report: ScenarioReport, capture: CaptureSummary): string {
  const verdict = report.verdict === "PASS" ? "✅ PASS" : report.verdict === "SKIP" ? "○ SKIP" : "❌ FAIL";
  const out: string[] = [];

  out.push(`# ${report.scenario} — ${verdict}`, "");
  out.push(`- runner: ${capture.runner}`);
  for (const marker of capture.markers ?? []) out.push(`- marker: ${marker}`);
  if (report.skipReason) out.push(`- skipped: ${report.skipReason}`);
  out.push(`- started: ${report.startedAt}`);
  out.push(`- finished: ${report.finishedAt}`);
  out.push(`- duration: ${n1(report.durationMs)} ms`, "");
  if (report.binaries) {
    out.push("## Binaries", "", "| device | mode | version | sha256 | commit | host path |", "| --- | --- | --- | --- | --- | --- |");
    for (const binary of report.binaries) {
      out.push(`| ${binary.device} | ${binary.mode} | ${binary.version} | ${binary.sha256 ?? "—"} | ${commitCell(binary.source)} | ${binary.hostPath ?? "checkout source"} |`);
    }
    out.push("");
  }

  out.push("## Steps", "", "| step | result | ms |", "| --- | --- | ---: |");
  for (const s of report.steps) {
    out.push(`| ${s.name} | ${s.ok ? "PASS" : "FAIL"} | ${s.ms} |${s.detail ? ` <!-- ${s.detail} -->` : ""}`);
  }
  out.push("");

  out.push("## Assertions", "", "| assertion | result | detail |", "| --- | --- | --- |");
  for (const a of report.assertions) {
    out.push(`| ${a.name} | ${a.ok ? "PASS" : "FAIL"} | ${a.detail ?? ""} |`);
  }
  out.push("");

  out.push("## Device resources", "", "| device | summary |", "| --- | --- |");
  out.push(statLine("rig-dev-a", capture.statsA));
  out.push(statLine("rig-dev-b", capture.statsB));
  out.push("");

  out.push("## Server", "");
  out.push(tailLine(capture.tail));
  out.push(...aeBlock(capture.ae));
  out.push("");

  out.push("## Artifacts", "");
  for (const f of capture.artifacts) out.push(`- \`${f}\``);
  out.push("");

  return out.join("\n");
}
