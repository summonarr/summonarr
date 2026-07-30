// Drift pins for src/lib/status-labels.ts — the single source of truth for the
// request/issue status chips and issue-type display labels.
//
// The module exists because these maps were copy-pasted across the requests
// page, admin-request-list, both issues pages and the mobile issue drawer, and
// the copies drifted ("Bad video" vs "Bad video quality"). Consolidating them
// fixed that class of bug but created a NEW one that nothing else catches: the
// maps are `Record<string, …>`, so adding a value to the `RequestStatus` /
// `IssueStatus` / `IssueType` enum in schema.prisma and forgetting the label
// entry is not a type error — it renders as `undefined` in a chip, and the
// missing tone silently falls back to the neutral style. Types don't catch it,
// eslint doesn't catch it, and no behavioural test covers a status that doesn't
// exist yet.
//
// So these tests read schema.prisma (the enum's actual source of truth) and
// chip.tsx (the ChipTone union) and assert the maps agree with BOTH directions:
// no enum member without an entry, and no entry for a member that no longer
// exists. Same idiom as tests/backup-schema.test.mts and
// tests/audit-actions.test.mts: read the source, assert the manifest.
// No DB, no network, no module graph beyond the pure map module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const {
  REQUEST_STATUS_TONE,
  REQUEST_STATUS_LABEL,
  ISSUE_STATUS_TONE,
  ISSUE_STATUS_LABEL,
  ISSUE_TYPE_LABELS,
} = await import("../src/lib/status-labels.ts");

const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf-8");
const chipSrc = readFileSync(
  join(process.cwd(), "src", "components", "ui", "design", "chip.tsx"),
  "utf-8",
);

// Pull the members of `enum <Name> { … }` out of schema.prisma. Prisma enum
// bodies are one bare identifier per line, so this stays a simple scan rather
// than a parser.
function prismaEnumMembers(name: string): string[] {
  const m = new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`).exec(schema);
  assert.ok(m, `enum ${name} not found in prisma/schema.prisma`);
  return m[1]
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").trim())
    .filter((l) => /^[A-Z][A-Z0-9_]*$/.test(l));
}

// The `ChipTone` union members from chip.tsx — the tones a chip can actually
// render. A tone string outside this set type-checks inside a Record<string,…>
// but hits `toneClass[tone] === undefined` at runtime.
function chipTones(): string[] {
  const m = /export type ChipTone =([\s\S]*?);/.exec(chipSrc);
  assert.ok(m, "ChipTone union not found in src/components/ui/design/chip.tsx");
  return [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
}

const REQUEST_STATUSES = prismaEnumMembers("RequestStatus");
const ISSUE_STATUSES = prismaEnumMembers("IssueStatus");
const ISSUE_TYPES = prismaEnumMembers("IssueType");
const TONES = chipTones();

// ── the extractors themselves must not pass vacuously ────────────────────────

test("schema/chip extraction found real enum members and tones — a broken regex must not pass vacuously", () => {
  assert.ok(REQUEST_STATUSES.length >= 4, `RequestStatus members: ${REQUEST_STATUSES.join(",")}`);
  assert.ok(ISSUE_STATUSES.length >= 3, `IssueStatus members: ${ISSUE_STATUSES.join(",")}`);
  assert.ok(ISSUE_TYPES.length >= 5, `IssueType members: ${ISSUE_TYPES.join(",")}`);
  assert.ok(TONES.length >= 7, `ChipTone members: ${TONES.join(",")}`);
  assert.ok(TONES.includes("neutral") && TONES.includes("accent"));
});

// ── RequestStatus ────────────────────────────────────────────────────────────

for (const status of ["PENDING", "APPROVED", "DECLINED", "AVAILABLE"]) {
  test(`RequestStatus ${status} has both a tone and a label`, () => {
    assert.ok(REQUEST_STATUS_TONE[status], `${status} missing from REQUEST_STATUS_TONE`);
    assert.ok(REQUEST_STATUS_LABEL[status], `${status} missing from REQUEST_STATUS_LABEL`);
  });
}

test("every RequestStatus enum member has a tone — a new status can't render an unstyled chip", () => {
  const missing = REQUEST_STATUSES.filter((s) => REQUEST_STATUS_TONE[s] === undefined);
  assert.deepEqual(missing, [], `add these to REQUEST_STATUS_TONE: ${missing.join(", ")}`);
});

test("every RequestStatus enum member has a label — a new status can't render as `undefined`", () => {
  const missing = REQUEST_STATUSES.filter((s) => REQUEST_STATUS_LABEL[s] === undefined);
  assert.deepEqual(missing, [], `add these to REQUEST_STATUS_LABEL: ${missing.join(", ")}`);
});

test("REQUEST_STATUS_TONE has no entry for a status the schema dropped", () => {
  const stale = Object.keys(REQUEST_STATUS_TONE).filter((k) => !REQUEST_STATUSES.includes(k));
  assert.deepEqual(stale, [], `remove these from REQUEST_STATUS_TONE: ${stale.join(", ")}`);
});

test("REQUEST_STATUS_LABEL has no entry for a status the schema dropped", () => {
  const stale = Object.keys(REQUEST_STATUS_LABEL).filter((k) => !REQUEST_STATUSES.includes(k));
  assert.deepEqual(stale, [], `remove these from REQUEST_STATUS_LABEL: ${stale.join(", ")}`);
});

test("the tone and label maps cover exactly the same RequestStatus key set", () => {
  assert.deepEqual(
    Object.keys(REQUEST_STATUS_TONE).sort(),
    Object.keys(REQUEST_STATUS_LABEL).sort(),
  );
});

test("every RequestStatus tone is a real ChipTone — not a string that renders unstyled", () => {
  for (const [status, tone] of Object.entries(REQUEST_STATUS_TONE)) {
    assert.ok(TONES.includes(tone), `REQUEST_STATUS_TONE.${status} = "${tone}" is not a ChipTone`);
  }
});

test("AVAILABLE reuses the approved tone — it is a terminal success state, not its own colour", () => {
  assert.equal(REQUEST_STATUS_TONE.AVAILABLE, "approved");
  assert.equal(REQUEST_STATUS_TONE.APPROVED, "approved");
  // …but the two are still distinguishable by their labels.
  assert.notEqual(REQUEST_STATUS_LABEL.AVAILABLE, REQUEST_STATUS_LABEL.APPROVED);
});

test("DECLINED and PENDING carry distinct, non-success tones", () => {
  assert.equal(REQUEST_STATUS_TONE.DECLINED, "declined");
  assert.equal(REQUEST_STATUS_TONE.PENDING, "pending");
  assert.notEqual(REQUEST_STATUS_TONE.DECLINED, REQUEST_STATUS_TONE.APPROVED);
});

// ── IssueStatus ──────────────────────────────────────────────────────────────

for (const status of ["OPEN", "IN_PROGRESS", "RESOLVED"]) {
  test(`IssueStatus ${status} has both a tone and a label`, () => {
    assert.ok(ISSUE_STATUS_TONE[status], `${status} missing from ISSUE_STATUS_TONE`);
    assert.ok(ISSUE_STATUS_LABEL[status], `${status} missing from ISSUE_STATUS_LABEL`);
  });
}

test("every IssueStatus enum member has a tone", () => {
  const missing = ISSUE_STATUSES.filter((s) => ISSUE_STATUS_TONE[s] === undefined);
  assert.deepEqual(missing, [], `add these to ISSUE_STATUS_TONE: ${missing.join(", ")}`);
});

test("every IssueStatus enum member has a label", () => {
  const missing = ISSUE_STATUSES.filter((s) => ISSUE_STATUS_LABEL[s] === undefined);
  assert.deepEqual(missing, [], `add these to ISSUE_STATUS_LABEL: ${missing.join(", ")}`);
});

test("ISSUE_STATUS_TONE / ISSUE_STATUS_LABEL carry no key the schema dropped", () => {
  const staleTone = Object.keys(ISSUE_STATUS_TONE).filter((k) => !ISSUE_STATUSES.includes(k));
  const staleLabel = Object.keys(ISSUE_STATUS_LABEL).filter((k) => !ISSUE_STATUSES.includes(k));
  assert.deepEqual(staleTone, []);
  assert.deepEqual(staleLabel, []);
});

test("every IssueStatus tone is a real ChipTone", () => {
  for (const [status, tone] of Object.entries(ISSUE_STATUS_TONE)) {
    assert.ok(TONES.includes(tone), `ISSUE_STATUS_TONE.${status} = "${tone}" is not a ChipTone`);
  }
});

test("an OPEN issue reads as attention-needed and a RESOLVED one as success", () => {
  // OPEN deliberately borrows the `declined` (red) tone: an unaddressed issue is
  // the state an admin must act on, so it must not read as neutral or pending.
  assert.equal(ISSUE_STATUS_TONE.OPEN, "declined");
  assert.equal(ISSUE_STATUS_TONE.IN_PROGRESS, "pending");
  assert.equal(ISSUE_STATUS_TONE.RESOLVED, "approved");
});

test("IN_PROGRESS renders with a space, not the raw SCREAMING_SNAKE enum value", () => {
  assert.equal(ISSUE_STATUS_LABEL.IN_PROGRESS, "In Progress");
  for (const label of Object.values(ISSUE_STATUS_LABEL)) {
    assert.ok(!label.includes("_"), `label "${label}" leaks the raw enum spelling`);
  }
});

// ── IssueType ────────────────────────────────────────────────────────────────

test("every IssueType enum member has a display label", () => {
  const missing = ISSUE_TYPES.filter((t) => ISSUE_TYPE_LABELS[t] === undefined);
  assert.deepEqual(missing, [], `add these to ISSUE_TYPE_LABELS: ${missing.join(", ")}`);
});

test("ISSUE_TYPE_LABELS carries no key the schema dropped", () => {
  const stale = Object.keys(ISSUE_TYPE_LABELS).filter((k) => !ISSUE_TYPES.includes(k));
  assert.deepEqual(stale, [], `remove these from ISSUE_TYPE_LABELS: ${stale.join(", ")}`);
});

test("BAD_VIDEO keeps the fuller wording that the drifted copies disagreed on", () => {
  // The drift this module was created to end: one copy said "Bad video", the
  // canonical one says "Bad video quality".
  assert.equal(ISSUE_TYPE_LABELS.BAD_VIDEO, "Bad video quality");
});

test("issue-type labels are human-readable — no underscores, no raw enum spellings", () => {
  for (const [type, label] of Object.entries(ISSUE_TYPE_LABELS)) {
    assert.ok(!label.includes("_"), `ISSUE_TYPE_LABELS.${type} = "${label}" leaks the enum spelling`);
    assert.notEqual(label, type);
    assert.ok(label.length > 0);
  }
});

test("issue-type labels are distinct — two types must never render identically", () => {
  const labels = Object.values(ISSUE_TYPE_LABELS);
  assert.equal(new Set(labels).size, labels.length, `duplicate labels: ${labels.join(" | ")}`);
});

test("request and issue status labels are each internally distinct", () => {
  const reqLabels = Object.values(REQUEST_STATUS_LABEL);
  assert.equal(new Set(reqLabels).size, reqLabels.length);
  const issueLabels = Object.values(ISSUE_STATUS_LABEL);
  assert.equal(new Set(issueLabels).size, issueLabels.length);
});

// ── lookup safety ────────────────────────────────────────────────────────────

test("an unknown status key reads back undefined rather than throwing", () => {
  // The maps are Record<string, …>, so call sites index them with a raw DB
  // string. Missing keys must be a soft undefined the caller can `??` over.
  assert.equal(REQUEST_STATUS_TONE.NOT_A_STATUS, undefined);
  assert.equal(REQUEST_STATUS_LABEL.NOT_A_STATUS, undefined);
  assert.equal(ISSUE_STATUS_TONE.NOT_A_STATUS, undefined);
  assert.equal(ISSUE_TYPE_LABELS.NOT_A_TYPE, undefined);
});

test("the maps are plain objects with no prototype-chain surprises on lookup", () => {
  // `REQUEST_STATUS_LABEL["toString"]` must not resolve to Object.prototype's
  // method and render a function into a chip.
  for (const map of [
    REQUEST_STATUS_TONE,
    REQUEST_STATUS_LABEL,
    ISSUE_STATUS_TONE,
    ISSUE_STATUS_LABEL,
    ISSUE_TYPE_LABELS,
  ]) {
    assert.equal(typeof map.toString, "function"); // inherited, as expected for a literal
    assert.ok(!Object.prototype.hasOwnProperty.call(map, "toString"));
    for (const v of Object.values(map)) assert.equal(typeof v, "string");
  }
});
