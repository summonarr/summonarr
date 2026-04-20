#!/usr/bin/env tsx
/**
 * Dependency security & freshness auditor.
 *
 * Wraps `npm audit` and `npm outdated`, parses their JSON output, and prints
 * a categorized report. Exit code is non-zero when vulnerabilities at or above
 * the configured threshold are present, so this can be wired into CI.
 *
 * Usage:
 *   tsx scripts/audit-deps.ts                # default: fail on "high" or above
 *   tsx scripts/audit-deps.ts --min=moderate # fail on "moderate" or above
 *   tsx scripts/audit-deps.ts --json         # emit machine-readable JSON
 *   tsx scripts/audit-deps.ts --no-outdated  # skip the outdated check
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Severity = "info" | "low" | "moderate" | "high" | "critical";

const SEVERITY_ORDER: Severity[] = [
  "info",
  "low",
  "moderate",
  "high",
  "critical",
];

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

const SEVERITY_COLOR: Record<Severity, string> = {
  info: COLORS.dim,
  low: COLORS.blue,
  moderate: COLORS.yellow,
  high: COLORS.red,
  critical: COLORS.magenta + COLORS.bold,
};

interface CliOptions {
  minSeverity: Severity;
  json: boolean;
  includeOutdated: boolean;
}

interface AdvisoryFinding {
  source: number;
  name: string;
  dependency: string;
  title: string;
  url: string;
  severity: Severity;
  range: string;
  cwe?: string[];
  cvss?: { score: number };
}

interface VulnReport {
  package: string;
  severity: Severity;
  isDirect: boolean;
  via: AdvisoryFinding[];
  fixAvailable: boolean | { name: string; version: string; isSemVerMajor: boolean };
}

interface OutdatedEntry {
  current?: string;
  wanted: string;
  latest: string;
  type?: string;
  location?: string;
}

interface AuditResult {
  vulnerabilities: VulnReport[];
  totals: Record<Severity, number>;
  outdated: Array<{ name: string } & OutdatedEntry>;
  directDependencies: Set<string>;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    minSeverity: "high",
    json: false,
    includeOutdated: true,
  };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--no-outdated") opts.includeOutdated = false;
    else if (arg.startsWith("--min=")) {
      const value = arg.slice("--min=".length) as Severity;
      if (!SEVERITY_ORDER.includes(value)) {
        console.error(
          `Invalid --min value: ${value}. Must be one of ${SEVERITY_ORDER.join(", ")}`,
        );
        process.exit(2);
      }
      opts.minSeverity = value;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: tsx scripts/audit-deps.ts [--min=low|moderate|high|critical] [--json] [--no-outdated]",
      );
      process.exit(0);
    }
  }
  return opts;
}

function loadDirectDependencies(cwd: string): Set<string> {
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const direct = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    if (pkg[field]) for (const name of Object.keys(pkg[field])) direct.add(name);
  }
  return direct;
}

function runJson(command: string, args: string[], cwd: string): unknown {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  // npm audit / npm outdated exit non-zero when findings exist; that's expected.
  const stdout = result.stdout?.trim();
  if (!stdout) {
    if (result.status !== 0 && result.stderr) {
      throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
    }
    return {};
  }
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Failed to parse JSON from \`${command} ${args.join(" ")}\`: ${(err as Error).message}`);
  }
}

interface NpmAuditJson {
  vulnerabilities?: Record<
    string,
    {
      name: string;
      severity: Severity;
      isDirect: boolean;
      via: Array<
        | string
        | {
            source: number;
            name: string;
            dependency: string;
            title: string;
            url: string;
            severity: Severity;
            range: string;
            cwe?: string[];
            cvss?: { score: number };
          }
      >;
      fixAvailable: boolean | { name: string; version: string; isSemVerMajor: boolean };
    }
  >;
}

function collectVulnerabilities(audit: NpmAuditJson): VulnReport[] {
  const vulns = audit.vulnerabilities ?? {};
  const reports: VulnReport[] = [];
  for (const [name, entry] of Object.entries(vulns)) {
    const advisories: AdvisoryFinding[] = [];
    for (const via of entry.via) {
      if (typeof via === "string") continue; // string entries are pointers to other packages
      advisories.push({
        source: via.source,
        name: via.name,
        dependency: via.dependency,
        title: via.title,
        url: via.url,
        severity: via.severity,
        range: via.range,
        cwe: via.cwe,
        cvss: via.cvss,
      });
    }
    reports.push({
      package: name,
      severity: entry.severity,
      isDirect: entry.isDirect,
      via: advisories,
      fixAvailable: entry.fixAvailable,
    });
  }
  // Sort: critical first, then direct deps before transitive, then alphabetical.
  reports.sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    if (a.isDirect !== b.isDirect) return a.isDirect ? -1 : 1;
    return a.package.localeCompare(b.package);
  });
  return reports;
}

function tallySeverities(reports: VulnReport[]): Record<Severity, number> {
  const totals: Record<Severity, number> = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  for (const r of reports) totals[r.severity]++;
  return totals;
}

function collectOutdated(
  raw: Record<string, OutdatedEntry | OutdatedEntry[]>,
  direct: Set<string>,
): AuditResult["outdated"] {
  const out: AuditResult["outdated"] = [];
  for (const [name, value] of Object.entries(raw)) {
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (!direct.has(name)) continue; // only surface drift the user can fix directly
      out.push({ name, ...entry });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function color(text: string, c: string): string {
  if (!process.stdout.isTTY) return text;
  return `${c}${text}${COLORS.reset}`;
}

function printHumanReport(result: AuditResult, opts: CliOptions): void {
  const { vulnerabilities, totals, outdated } = result;
  console.log(color("\n  Dependency Security Audit", COLORS.bold + COLORS.cyan));
  console.log(color("  ─────────────────────────", COLORS.dim));

  const totalVulns = vulnerabilities.length;
  if (totalVulns === 0) {
    console.log(color("\n  ✓ No known vulnerabilities reported by npm audit.\n", COLORS.green));
  } else {
    console.log(`\n  ${color("Summary:", COLORS.bold)} ${totalVulns} vulnerable package(s)`);
    for (const sev of [...SEVERITY_ORDER].reverse()) {
      if (totals[sev] === 0) continue;
      console.log(`    ${color(sev.padEnd(9), SEVERITY_COLOR[sev])} ${totals[sev]}`);
    }
    console.log();

    for (const v of vulnerabilities) {
      const sevTag = color(`[${v.severity.toUpperCase()}]`, SEVERITY_COLOR[v.severity]);
      const directTag = v.isDirect
        ? color(" (direct)", COLORS.cyan)
        : color(" (transitive)", COLORS.dim);
      console.log(`  ${sevTag} ${color(v.package, COLORS.bold)}${directTag}`);

      const seenAdvisories = new Set<number>();
      for (const adv of v.via) {
        if (seenAdvisories.has(adv.source)) continue;
        seenAdvisories.add(adv.source);
        const cvss = adv.cvss?.score ? ` cvss:${adv.cvss.score.toFixed(1)}` : "";
        console.log(`      • ${adv.title}${color(cvss, COLORS.dim)}`);
        console.log(`        ${color(adv.url, COLORS.blue)}`);
        if (adv.range) console.log(color(`        affects ${adv.dependency} ${adv.range}`, COLORS.dim));
      }

      if (v.fixAvailable === false) {
        console.log(color("      ! No fix available yet", COLORS.yellow));
      } else if (v.fixAvailable === true) {
        console.log(color("      → Fix available: run `npm audit fix`", COLORS.green));
      } else {
        const breaking = v.fixAvailable.isSemVerMajor ? " (breaking)" : "";
        console.log(
          color(
            `      → Fix: upgrade ${v.fixAvailable.name} to ${v.fixAvailable.version}${breaking}`,
            COLORS.green,
          ),
        );
      }
      console.log();
    }
  }

  if (opts.includeOutdated) {
    console.log(color("  Outdated direct dependencies", COLORS.bold + COLORS.cyan));
    console.log(color("  ────────────────────────────", COLORS.dim));
    if (outdated.length === 0) {
      console.log(color("\n  ✓ All direct dependencies are at their latest version.\n", COLORS.green));
    } else {
      console.log();
      const nameWidth = Math.max(...outdated.map((o) => o.name.length), 8);
      const currentWidth = Math.max(...outdated.map((o) => (o.current ?? "—").length), 7) + 2;
      const wantedWidth = Math.max(...outdated.map((o) => o.wanted.length), 6) + 2;
      console.log(
        `  ${"package".padEnd(nameWidth)}  ${"current".padEnd(currentWidth)}${"wanted".padEnd(wantedWidth)}latest`,
      );
      for (const o of outdated) {
        const current = o.current ?? "—";
        const drift = o.latest !== current;
        const latestColored = drift ? color(o.latest, COLORS.yellow) : o.latest;
        console.log(
          `  ${o.name.padEnd(nameWidth)}  ${current.padEnd(currentWidth)}${o.wanted.padEnd(wantedWidth)}${latestColored}`,
        );
      }
      console.log();
    }
  }
}

function determineExitCode(totals: Record<Severity, number>, min: Severity): number {
  const threshold = SEVERITY_RANK[min];
  for (const sev of SEVERITY_ORDER) {
    if (SEVERITY_RANK[sev] >= threshold && totals[sev] > 0) return 1;
  }
  return 0;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  const directDependencies = loadDirectDependencies(cwd);

  if (!opts.json) {
    process.stdout.write(color("Running npm audit…\n", COLORS.dim));
  }
  const auditJson = runJson("npm", ["audit", "--json"], cwd) as NpmAuditJson;
  const vulnerabilities = collectVulnerabilities(auditJson);
  const totals = tallySeverities(vulnerabilities);

  let outdated: AuditResult["outdated"] = [];
  if (opts.includeOutdated) {
    if (!opts.json) process.stdout.write(color("Running npm outdated…\n", COLORS.dim));
    const outdatedJson = runJson("npm", ["outdated", "--json", "--long"], cwd) as Record<
      string,
      OutdatedEntry | OutdatedEntry[]
    >;
    outdated = collectOutdated(outdatedJson, directDependencies);
  }

  const result: AuditResult = { vulnerabilities, totals, outdated, directDependencies };

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          totals,
          vulnerabilities,
          outdated,
          minSeverity: opts.minSeverity,
        },
        null,
        2,
      ),
    );
  } else {
    printHumanReport(result, opts);
  }

  process.exit(determineExitCode(totals, opts.minSeverity));
}

main();
