// Unit tests for the report validation in scripts/audit-deps.mts — the script
// behind `npm run security:gate`, which docker-publish.yml's build-and-push
// job `needs:` (guardrail 18a).
//
// Why these exist: when the registry is unreachable, npm writes a JSON error
// envelope to STDOUT and exits 1. That parsed cleanly, `vulnerabilities` came
// back undefined, every severity total was 0, and the gate exited 0 — so a
// release could publish having scanned nothing. The pins below fix the shape of
// what counts as a usable report, per command.
//
// Nothing here touches the network: runJson is exercised against `node -e`
// subprocesses that emit controlled stdout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyAllowlist,
  exceptionCovers,
  loadExceptions,
  normalizeExceptionId,
  runJson,
  validateAuditReport,
  validateOutdatedReport,
  type AdvisoryFinding,
  type SecurityException,
  type VulnReport,
} from "../scripts/audit-deps.mts";

const CWD = process.cwd();
const SCRIPT = fileURLToPath(new URL("../scripts/audit-deps.mts", import.meta.url));
const REPO = dirname(dirname(SCRIPT));

/**
 * Run the real gate with a stub `npm` first on PATH.
 *
 * The unit tests below pin the validators; this pins main() actually PASSING
 * one. Dropping the 4th argument at either runJson call site would reopen the
 * exact "registry unreachable reads as zero vulnerabilities" hole with every
 * other test in this file still green.
 */
function gateWithStubNpm(stdout: string, exitCode: number): { status: number | null; output: string } {
  const bin = mkdtempSync(join(tmpdir(), "summonarr-npm-stub-"));
  try {
    const shim = join(bin, "npm");
    writeFileSync(shim, `#!/bin/sh\ncat <<'JSON'\n${stdout}\nJSON\nexit ${exitCode}\n`, { mode: 0o755 });
    const res = spawnSync(process.execPath, [SCRIPT, "--allowlist", "--no-outdated"], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    return { status: res.status, output: `${res.stdout ?? ""}${res.stderr ?? ""}` };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

// ── npm audit ───────────────────────────────────────────────────────────────

test("validateAuditReport accepts a real npm audit report", () => {
  assert.equal(validateAuditReport({ auditReportVersion: 2, vulnerabilities: {}, metadata: {} }), null);
});

test("PIN: validateAuditReport rejects npm's error envelope instead of reading it as zero vulnerabilities", () => {
  // Exactly what `npm audit --json` writes to stdout (exit 1) when the registry
  // is unreachable. Reading this as a clean audit is the bug being fixed.
  const envelope = {
    message: "request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED",
    error: { summary: "", detail: "" },
  };
  const result = validateAuditReport(envelope);
  assert.equal(typeof result, "string");
  assert.match(result as string, /npm error/);
});

test("PIN: validateAuditReport rejects an empty object — absent `vulnerabilities` is not a clean scan", () => {
  const result = validateAuditReport({});
  assert.equal(typeof result, "string");
  assert.match(result as string, /vulnerabilities/);
});

test("validateAuditReport rejects non-objects", () => {
  assert.equal(typeof validateAuditReport(null), "string");
  assert.equal(typeof validateAuditReport("nope"), "string");
});

// ── npm outdated ────────────────────────────────────────────────────────────
// Deliberately laxer than the audit check: `npm outdated --json` exits 1 merely
// because packages are outdated, and exits 0 with `{}` when none are, so only
// npm's own error envelope may be rejected.

test("PIN: validateOutdatedReport accepts `{}` — the clean run, which must not read as a failure", () => {
  assert.equal(validateOutdatedReport({}), null);
});

test("validateOutdatedReport accepts a real outdated report", () => {
  assert.equal(
    validateOutdatedReport({ next: { current: "16.2.9", wanted: "16.2.9", latest: "16.3.0" } }),
    null,
  );
});

test("validateOutdatedReport rejects npm's error envelope", () => {
  const result = validateOutdatedReport({
    error: { code: "ECONNREFUSED", summary: "request to http://127.0.0.1:9 failed", detail: "" },
  });
  assert.equal(typeof result, "string");
  assert.match(result as string, /ECONNREFUSED/);
});

test("validateOutdatedReport accepts a package literally named `error`", () => {
  // Distinguished from the envelope by carrying wanted/latest, which npm's
  // error object never does.
  assert.equal(
    validateOutdatedReport({ error: { current: "1.0.0", wanted: "1.0.1", latest: "1.1.0" } }),
    null,
  );
});

// ── runJson ─────────────────────────────────────────────────────────────────

test("runJson returns parsed JSON when the command succeeds and the shape validates", () => {
  const out = runJson(
    process.execPath,
    ["-e", 'console.log(JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} }))'],
    CWD,
    validateAuditReport,
  );
  assert.deepEqual(out, { auditReportVersion: 2, vulnerabilities: {} });
});

test("PIN: runJson throws when the command cannot be started at all", () => {
  // spawnSync sets `error` and leaves status null with undefined stdout/stderr,
  // which every output check would otherwise read as "no findings".
  assert.throws(
    () => runJson("summonarr-no-such-binary-xyz", ["--json"], CWD, validateAuditReport),
    /could not be run/,
  );
});

test("PIN: runJson throws when the command produces no output", () => {
  // The old code returned `{}` here whenever the exit status was 0 or stderr was
  // empty, which downstream read as zero vulnerabilities.
  assert.throws(() => runJson(process.execPath, ["-e", ""], CWD, validateAuditReport), /produced no output/);
});

test("runJson throws on unparseable stdout", () => {
  assert.throws(
    () => runJson(process.execPath, ["-e", 'console.log("not json")'], CWD, validateAuditReport),
    /Failed to parse JSON/,
  );
});

test("PIN: runJson throws when stdout parses but is not the expected report", () => {
  // The whole defect in one case: exit non-zero, valid JSON on stdout, no
  // vulnerabilities field. Must be fatal, never an empty result.
  assert.throws(
    () =>
      runJson(
        process.execPath,
        ["-e", 'console.log(JSON.stringify({ error: { summary: "registry unreachable" } })); process.exit(1)'],
        CWD,
        validateAuditReport,
      ),
    /did not return a usable report/,
  );
});

test("runJson without a validator accepts any parseable JSON", () => {
  assert.deepEqual(runJson(process.execPath, ["-e", 'console.log("{}")'], CWD), {});
});

// ── End to end: the gate itself, not just its validators ───────────────────

test("PIN: the gate exits non-zero when npm audit fails, instead of reporting a clean scan", { skip: process.platform === "win32" }, () => {
  const { status, output } = gateWithStubNpm(
    '{"message":"request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED","error":{"summary":"","detail":""}}',
    1,
  );
  assert.equal(status, 1, output);
  assert.match(output, /did not return a usable report/);
  assert.doesNotMatch(output, /No known vulnerabilities/, "must not claim a clean audit");
});

test("the gate still exits 0 on a genuinely clean audit", { skip: process.platform === "win32" }, () => {
  // Positive control: proves the assertion above is caused by the failure shape
  // and not by the stub harness itself.
  const { status, output } = gateWithStubNpm('{"auditReportVersion":2,"vulnerabilities":{},"metadata":{}}', 0);
  assert.equal(status, 0, output);
  assert.match(output, /No known vulnerabilities/);
});

// ── Exception matching (guardrail 18a) ─────────────────────────────────────
// The allowlist drops an advisory ONLY when an exception names both its package
// and its exact advisory id. The old matcher was a substring test against the
// advisory URL, and every npm advisory URL is https://github.com/advisories/GHSA-…,
// so a truncated `"id": "GHSA"` passed `--allowlist-only` and then blanket-
// accepted every present and future advisory on the package.

function advisory(id: string, overrides: Partial<AdvisoryFinding> = {}): AdvisoryFinding {
  return {
    source: 1,
    name: "some-package",
    dependency: "some-package",
    title: `Prototype pollution in some-package (${id})`,
    url: `https://github.com/advisories/${id}`,
    severity: "high",
    range: "<1.0.0",
    ...overrides,
  };
}

function exception(id: string, pkg = "some-package"): SecurityException {
  return { id, package: pkg, owner: "@gadgetusaf", expires: "2099-01-01", reason: "test" };
}

const A = "GHSA-7p8r-x3mc-p8w7";
const B = "GHSA-c2qf-rxjj-qqgw";

function loadExceptionsFrom(entries: unknown[]): ReturnType<typeof loadExceptions> {
  const dir = mkdtempSync(join(tmpdir(), "summonarr-exceptions-"));
  try {
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".github", "security-exceptions.json"), JSON.stringify({ exceptions: entries }));
    return loadExceptions(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("normalizeExceptionId accepts a bare GHSA id and the github.com/advisories URL form", () => {
  assert.equal(normalizeExceptionId(A), A.toLowerCase());
  assert.equal(normalizeExceptionId(` ${A} `), A.toLowerCase());
  assert.equal(normalizeExceptionId(`https://github.com/advisories/${A}`), A.toLowerCase());
  assert.equal(normalizeExceptionId(`https://github.com/advisories/${A}/`), A.toLowerCase());
  assert.equal(normalizeExceptionId(`https://github.com/advisories/${A}?foo=1`), A.toLowerCase());
});

test("PIN: normalizeExceptionId rejects truncated / partial / non-GHSA ids", () => {
  for (const bad of ["GHSA", "GHSA-", "GHSA-7p8r", "GHSA-7p8r-x3mc", "github.com", "advisories", "https://github.com/advisories/", "1234", ""]) {
    assert.equal(normalizeExceptionId(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("PIN: loadExceptions rejects `id: \"GHSA\"` so --allowlist-only (the blocking PR check) fails on it", () => {
  const { exceptions, errors } = loadExceptionsFrom([exception("GHSA")]);
  assert.equal(exceptions.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"id" must be a full GHSA id/);
});

test("loadExceptions accepts both documented id forms", () => {
  const { exceptions, errors } = loadExceptionsFrom([
    exception(A),
    exception(`https://github.com/advisories/${B}`),
  ]);
  assert.deepEqual(errors, []);
  assert.equal(exceptions.length, 2);
});

test("exceptionCovers matches exactly one advisory for a bare id and for the URL form", () => {
  assert.equal(exceptionCovers(exception(A), "some-package", advisory(A)), true);
  assert.equal(exceptionCovers(exception(`https://github.com/advisories/${A}`), "some-package", advisory(A)), true);
  assert.equal(exceptionCovers(exception(A), "some-package", advisory(B)), false);
  assert.equal(exceptionCovers(exception(A), "other-package", advisory(A)), false, "package must match too");
});

test("PIN: a truncated id covers NOTHING — never every advisory on the package", () => {
  for (const bad of ["GHSA", "GHSA-", "github.com", "advisories"]) {
    assert.equal(exceptionCovers(exception(bad), "some-package", advisory(A)), false, bad);
    assert.equal(exceptionCovers(exception(bad), "some-package", advisory(B)), false, bad);
  }
});

test("PIN: the advisory title is not consulted — an id appearing in prose does not match", () => {
  // Title mentions A, URL is B. The old `title.includes(id)` fallback matched here.
  const cross = advisory(B, { title: `Follow-up to ${A}` });
  assert.equal(exceptionCovers(exception(A), "some-package", cross), false);
});

test("PIN: applyAllowlist suppresses advisory A but still gates advisory B on the same package (18a)", () => {
  const report: VulnReport = {
    package: "some-package",
    severity: "high",
    isDirect: false,
    via: [advisory(A), advisory(B)],
    fixAvailable: false,
  };
  const outcome = applyAllowlist([report], [exception(A)], new Date("2026-09-03T00:00:00Z"));
  assert.equal(outcome.failures.length, 0);
  assert.equal(outcome.suppressed.length, 1);
  assert.equal(outcome.remaining.length, 1);
  assert.deepEqual(
    outcome.remaining[0].via.map((v) => v.url),
    [`https://github.com/advisories/${B}`],
  );
  assert.deepEqual(outcome.stale, []);
});

test("applyAllowlist: an exception that matches no live advisory is reported stale, not silently kept", () => {
  const report: VulnReport = {
    package: "some-package",
    severity: "high",
    isDirect: false,
    via: [advisory(B)],
    fixAvailable: false,
  };
  const outcome = applyAllowlist([report], [exception(A)], new Date("2026-09-03T00:00:00Z"));
  assert.equal(outcome.remaining.length, 1);
  assert.equal(outcome.stale.length, 1);
});
