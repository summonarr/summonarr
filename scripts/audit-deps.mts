#!/usr/bin/env node
/**
 * Dependency security & freshness auditor.
 *
 * Wraps `npm audit` and `npm outdated`, parses their JSON output, and prints
 * a categorized report. Exit code is non-zero when vulnerabilities at or above
 * the configured threshold are present, so this can be wired into CI.
 *
 * Usage:
 *   node scripts/audit-deps.mts                # default: fail on "high" or above
 *   node scripts/audit-deps.mts --min=moderate # fail on "moderate" or above
 *   node scripts/audit-deps.mts --json         # emit machine-readable JSON
 *   node scripts/audit-deps.mts --no-outdated  # skip the outdated check
 *   node scripts/audit-deps.mts --allowlist    # honour .github/security-exceptions.json
 *   node scripts/audit-deps.mts --allowlist-only  # ONLY validate the exception file
 *
 * The `--allowlist` mode is what makes this safe to run as a BLOCKING release
 * gate. Without an escape hatch, a blocking dependency audit fails the build
 * for an advisory published overnight against a transitive package with no fix
 * yet — which is exactly why this check was previously `continue-on-error` and
 * therefore gated nothing at all. With it, an advisory can be consciously
 * accepted for a bounded time by a named owner, and the gate itself enforces
 * that the acceptance expires.
 *
 * An EXPIRED exception is a hard failure, not a silent pass. Expiry that
 * degrades to "allow" would make every entry permanent by neglect.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
  useAllowlist: boolean;
  allowlistOnly: boolean;
}

/** One accepted advisory from .github/security-exceptions.json. */
interface SecurityException {
  id: string;
  package: string;
  owner: string;
  /** ISO date (YYYY-MM-DD), UTC. */
  expires: string;
  reason: string;
}

const EXCEPTIONS_PATH = ".github/security-exceptions.json";

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
    useAllowlist: false,
    allowlistOnly: false,
  };
  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--no-outdated") opts.includeOutdated = false;
    else if (arg === "--allowlist") opts.useAllowlist = true;
    else if (arg === "--allowlist-only") {
      opts.allowlistOnly = true;
      opts.useAllowlist = true;
    } else if (arg.startsWith("--min=")) {
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
        "Usage: node scripts/audit-deps.mts [--min=low|moderate|high|critical] [--json]\n" +
          "                                   [--no-outdated] [--allowlist] [--allowlist-only]",
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

// When the registry is unreachable npm writes a JSON error envelope to STDOUT
// (not stderr) and exits 1: `{"message": ..., "error": ...}` for audit,
// `{"error": {code, summary, detail}}` for outdated. Both parse cleanly, so a
// failed run is indistinguishable from a clean one unless the shape is checked.
// Neither can be identified by exit code: `npm outdated` exits 1 merely because
// packages are outdated, and exits 0 with `{}` when none are.
export type ReportValidator = (parsed: unknown) => string | null;

function npmErrorDetail(report: Record<string, unknown>): string | null {
  const err = report.error;
  if (err && typeof err === "object") {
    const fields = err as Record<string, unknown>;
    const parts = [fields.code, fields.summary, fields.detail].filter(
      (part): part is string => typeof part === "string" && part.trim().length > 0,
    );
    if (parts.length > 0) return `npm error: ${parts.join(" — ").slice(0, 300)}`;
  }
  if (typeof report.message === "string" && report.message.trim()) {
    return `npm error: ${report.message.trim().slice(0, 300)}`;
  }
  return null;
}

export function validateAuditReport(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return "expected a JSON object";
  const report = parsed as Record<string, unknown>;
  // `vulnerabilities` is the field collectVulnerabilities reads. Absent, there is
  // no report to audit no matter what else npm returned — and treating that as
  // "zero findings" is exactly how a broken scan passes the release gate.
  if (report.vulnerabilities && typeof report.vulnerabilities === "object") return null;
  return npmErrorDetail(report) ?? "no `vulnerabilities` field — not an npm audit report";
}

export function validateOutdatedReport(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return "expected a JSON object";
  const report = parsed as Record<string, unknown>;
  // A clean run is `{}` and every other key is a package name, so only npm's own
  // error envelope may be rejected here. A package genuinely named "error" would
  // carry `wanted`/`latest`, which the envelope never does.
  const err = report.error;
  if (err && typeof err === "object" && !("wanted" in err) && !("latest" in err)) {
    return npmErrorDetail(report) ?? "npm returned an error envelope";
  }
  return null;
}

export function runJson(command: string, args: string[], cwd: string, validate?: ReportValidator): unknown {
  const label = `${command} ${args.join(" ")}`;
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  // spawnSync reports a failure to *start* the process here, leaving status null
  // and stdout/stderr undefined — which every check below would read as "no output".
  if (result.error) {
    throw new Error(`\`${label}\` could not be run: ${result.error.message}`);
  }
  // npm audit / npm outdated exit non-zero when findings exist; that's expected,
  // so the exit code alone never decides success.
  const stdout = result.stdout?.trim();
  if (!stdout) {
    const stderr = result.stderr?.trim();
    throw new Error(
      `\`${label}\` produced no output (exit ${result.status ?? "none"})${stderr ? `: ${stderr}` : ""}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Failed to parse JSON from \`${label}\`: ${(err as Error).message}`);
  }
  const invalid = validate?.(parsed);
  if (invalid) {
    throw new Error(`\`${label}\` did not return a usable report: ${invalid}`);
  }
  return parsed;
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

// ── Exception allowlist ──────────────────────────────────────────────────────

/**
 * Reads and structurally validates `.github/security-exceptions.json`.
 *
 * Every field is mandatory and a malformed entry is a hard error rather than a
 * skipped one: an exception that silently fails to parse would read as "no
 * exceptions" here while a human reading the file believes an advisory is
 * consciously accepted. Those two states must never look the same.
 */
function loadExceptions(cwd: string): { exceptions: SecurityException[]; errors: string[] } {
  const path = join(cwd, EXCEPTIONS_PATH);
  if (!existsSync(path)) return { exceptions: [], errors: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { exceptions: [], errors: [`${EXCEPTIONS_PATH} is not valid JSON: ${String(error)}`] };
  }

  const raw = (parsed as { exceptions?: unknown })?.exceptions;
  if (raw === undefined) return { exceptions: [], errors: [] };
  if (!Array.isArray(raw)) {
    return { exceptions: [], errors: [`${EXCEPTIONS_PATH}: "exceptions" must be an array`] };
  }

  const errors: string[] = [];
  const exceptions: SecurityException[] = [];
  raw.forEach((entry, index) => {
    const where = `${EXCEPTIONS_PATH}[${index}]`;
    if (typeof entry !== "object" || entry === null) {
      errors.push(`${where}: must be an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const missing = (["id", "package", "owner", "expires", "reason"] as const).filter(
      (field) => typeof record[field] !== "string" || (record[field] as string).trim() === "",
    );
    if (missing.length > 0) {
      errors.push(`${where}: missing/empty required field(s): ${missing.join(", ")}`);
      return;
    }
    const expires = record.expires as string;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) {
      errors.push(`${where}: "expires" must be an ISO date (YYYY-MM-DD), got "${expires}"`);
      return;
    }
    exceptions.push(entry as unknown as SecurityException);
  });

  return { exceptions, errors };
}

/** Whether `advisory` is covered by `exception` (GHSA id or advisory URL). */
function exceptionCovers(exception: SecurityException, pkg: string, advisory: AdvisoryFinding): boolean {
  if (exception.package !== pkg) return false;
  const id = exception.id.trim();
  return advisory.url?.includes(id) === true || advisory.title?.includes(id) === true;
}

/** An exception is expired once the day AFTER `expires` has begun (UTC). */
function isExpired(exception: SecurityException, now: Date): boolean {
  return now.getTime() > Date.parse(`${exception.expires}T23:59:59Z`);
}

interface AllowlistOutcome {
  /** Vulnerabilities still counted against the gate. */
  remaining: VulnReport[];
  /** Advisories suppressed by a live exception. */
  suppressed: Array<{ pkg: string; exception: SecurityException }>;
  /** Blocking problems: expired entries and malformed file contents. */
  failures: string[];
  /** Non-blocking hygiene: entries matching no live advisory. */
  stale: SecurityException[];
}

/**
 * Applies the allowlist to a set of vulnerabilities.
 *
 * An advisory is dropped from the gate ONLY when a non-expired exception names
 * both its package and its identifier. A package-level match alone is not
 * enough — accepting one advisory must not blanket-accept the next one filed
 * against the same package.
 */
function applyAllowlist(
  reports: VulnReport[],
  exceptions: SecurityException[],
  now: Date,
): AllowlistOutcome {
  const failures: string[] = [];
  const suppressed: AllowlistOutcome["suppressed"] = [];
  const used = new Set<SecurityException>();

  const live: SecurityException[] = [];
  for (const exception of exceptions) {
    if (isExpired(exception, now)) {
      failures.push(
        `EXPIRED exception for ${exception.package} (${exception.id}) — expired ${exception.expires}, ` +
          `owner ${exception.owner}. Fix the advisory or take a fresh, dated decision.`,
      );
    } else {
      live.push(exception);
    }
  }

  const remaining: VulnReport[] = [];
  for (const report of reports) {
    const kept = report.via.filter((advisory) => {
      const match = live.find((exception) => exceptionCovers(exception, report.package, advisory));
      if (!match) return true;
      used.add(match);
      suppressed.push({ pkg: report.package, exception: match });
      return false;
    });
    // A package whose advisories are all excepted drops out of the gate; one
    // with any advisory left stays, carrying only the unexcepted advisories.
    if (kept.length > 0) remaining.push({ ...report, via: kept });
  }

  return {
    remaining,
    suppressed,
    failures,
    stale: live.filter((exception) => !used.has(exception)),
  };
}

/** Re-tallies severities after allowlisting, from the surviving advisories. */
function tallyFromReports(reports: VulnReport[]): Record<Severity, number> {
  const totals: Record<Severity, number> = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  for (const report of reports) {
    // Rank the package by its worst SURVIVING advisory, not the original
    // entry severity — otherwise excepting the only critical advisory would
    // still leave the package counted as critical.
    const worst = report.via.reduce<Severity>(
      (acc, advisory) => (SEVERITY_RANK[advisory.severity] > SEVERITY_RANK[acc] ? advisory.severity : acc),
      "info",
    );
    totals[worst] += 1;
  }
  return totals;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  // The exception file is parsed FIRST and its structural errors are fatal on
  // their own, so a malformed file can never be mistaken for "no exceptions".
  const { exceptions, errors: exceptionErrors } = opts.useAllowlist
    ? loadExceptions(cwd)
    : { exceptions: [] as SecurityException[], errors: [] as string[] };

  if (opts.allowlistOnly) {
    // Validation-only mode: deterministic, needs no network, and safe to run
    // as a blocking PR check — it cannot be tripped by a new upstream
    // advisory, only by a malformed or expired entry in this repo's own file.
    const expired = exceptions.filter((exception) => isExpired(exception, new Date()));
    const problems = [
      ...exceptionErrors,
      ...expired.map(
        (exception) =>
          `EXPIRED exception for ${exception.package} (${exception.id}) — expired ${exception.expires}, owner ${exception.owner}.`,
      ),
    ];
    console.log(color("\n  Security Exception Validation", COLORS.bold + COLORS.cyan));
    console.log(color("  ─────────────────────────────", COLORS.dim));
    if (problems.length > 0) {
      for (const problem of problems) console.log(`  ${color("✗", COLORS.red)} ${problem}`);
      console.log();
      process.exit(1);
    }
    console.log(
      `\n  ${color("✓", COLORS.green)} ${exceptions.length} exception(s); none expired or malformed.\n`,
    );
    process.exit(0);
  }

  const directDependencies = loadDirectDependencies(cwd);

  if (!opts.json) {
    process.stdout.write(color("Running npm audit…\n", COLORS.dim));
  }
  const auditJson = runJson("npm", ["audit", "--json"], cwd, validateAuditReport) as NpmAuditJson;
  let vulnerabilities = collectVulnerabilities(auditJson);
  let totals = tallySeverities(vulnerabilities);

  let allowlistFailures: string[] = [...exceptionErrors];
  if (opts.useAllowlist) {
    const outcome = applyAllowlist(vulnerabilities, exceptions, new Date());
    vulnerabilities = outcome.remaining;
    totals = tallyFromReports(outcome.remaining);
    allowlistFailures = [...allowlistFailures, ...outcome.failures];

    if (!opts.json) {
      for (const { pkg, exception } of outcome.suppressed) {
        console.log(
          color(
            `  ⚠ accepted: ${pkg} (${exception.id}) until ${exception.expires} — ${exception.owner}`,
            COLORS.yellow,
          ),
        );
      }
      for (const exception of outcome.stale) {
        console.log(
          color(
            `  · stale exception (matches no live advisory, delete it): ${exception.package} (${exception.id})`,
            COLORS.dim,
          ),
        );
      }
    }
  }

  let outdated: AuditResult["outdated"] = [];
  if (opts.includeOutdated) {
    if (!opts.json) process.stdout.write(color("Running npm outdated…\n", COLORS.dim));
    const outdatedJson = runJson(
      "npm",
      ["outdated", "--json", "--long"],
      cwd,
      validateOutdatedReport,
    ) as Record<string, OutdatedEntry | OutdatedEntry[]>;
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

  if (allowlistFailures.length > 0) {
    for (const failure of allowlistFailures) {
      console.error(`  ${color("✗", COLORS.red)} ${failure}`);
    }
    console.error();
    // Expired/malformed exceptions fail even when the advisory set is clean:
    // the file itself is the defect, and leaving it to be "noticed later" is
    // how a bounded acceptance becomes permanent.
    process.exit(1);
  }

  process.exit(determineExitCode(totals, opts.minSeverity));
}

// Only run the CLI when invoked directly. Tests import the validators above, and
// an unguarded main() would run a real npm audit and exit the test runner.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    // A scan that could not run is a gate failure, never a silent pass.
    console.error(`  ${color("✗", COLORS.red)} ${(err as Error).message}`);
    process.exit(1);
  }
}
