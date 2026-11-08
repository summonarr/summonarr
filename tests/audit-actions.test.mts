// Unit tests for the audit-action metadata maps (src/lib/audit-actions.ts).
// /api/admin/audit-log and its /export sibling validate ?action= filters
// against AUDIT_ACTIONS (a bad filter must 400, not silently fall back to the
// unfiltered set), and the admin table renders badges from ACTION_COLORS +
// ACTION_GROUP (the badge text is the adminManage catalog's). The Record<AuditAction, …> type already forces every action
// into the maps at compile time, but the test runner only strips types and
// never checks them. So these runtime checks catch a new enum value (added
// in the schema) that was never added to the maps, and they also pin the
// group split and unique labels that the filter dropdown relies on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AuditAction } from "@/generated/prisma";
import {
  AUDIT_ACTIONS,
  ACTION_GROUP,
  ACTION_COLORS,
  type AuditGroup,
} from "../src/lib/audit-actions.ts";
import { LOCALES } from "../src/lib/i18n/locales.ts";

const ENUM_VALUES = Object.values(AuditAction).sort();

// The badge text the table renders: adminManage.audit.action.<ACTION>.
const readCatalog = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(new URL(`../src/lib/i18n/messages/${locale}/adminManage.json`, import.meta.url), "utf8"));
const EN = readCatalog("en");
const enLabel = (action: string): string | undefined => EN[`adminManage.audit.action.${action}`];

test("prisma runtime enum is an identity map (key === value)", () => {
  // Comparing enum constants against DB rows as plain strings is only sound
  // because the generated runtime enum maps every key to itself.
  assert.ok(Object.keys(AuditAction).length >= 35); // sanity floor: catches an empty or truncated enum
  for (const [key, value] of Object.entries(AuditAction)) {
    assert.equal(value, key);
  }
});

test("AUDIT_ACTIONS lists every enum value exactly once", () => {
  assert.deepEqual([...AUDIT_ACTIONS].sort(), ENUM_VALUES);
  assert.equal(new Set(AUDIT_ACTIONS).size, AUDIT_ACTIONS.length);
});

test("ACTION_GROUP assigns a valid group to every enum value, and nothing extra", () => {
  const validGroups: AuditGroup[] = ["auth", "admin", "system"];
  assert.deepEqual(Object.keys(ACTION_GROUP).sort(), ENUM_VALUES);
  for (const [action, group] of Object.entries(ACTION_GROUP)) {
    assert.ok(validGroups.includes(group), `${action} has unknown group "${group}"`);
  }
});

test("group partition: auth and system sets are exact, the remainder is admin", () => {
  const byGroup = (g: AuditGroup): string[] =>
    AUDIT_ACTIONS.filter((a) => ACTION_GROUP[a] === g).sort();
  assert.deepEqual(byGroup("auth"), [
    "AUTH_LOGIN",
    "AUTH_LOGIN_FAILED",
    "AUTH_LOGOUT",
    "MFA_CHANGE",
    "SESSION_REVOKE",
  ]);
  assert.deepEqual(byGroup("system"), [
    "CACHE_WARM",
    "LIBRARY_SYNC",
    "PLAY_HISTORY_BACKFILL",
    "PLAY_HISTORY_DELETE",
    "RATINGS_CACHE_CLEAR",
  ]);
  // PLAY_HISTORY_EXPORT is deliberately "admin" (a human-initiated export),
  // unlike its BACKFILL/DELETE siblings which are system-side operations.
  assert.equal(ACTION_GROUP.PLAY_HISTORY_EXPORT, "admin");
  // Groups partition the whole enum: everything not auth/system is admin.
  assert.equal(byGroup("admin").length, AUDIT_ACTIONS.length - 5 - 5);
});

test("ACTION_COLORS covers every enum value with a well-formed badge colour", () => {
  assert.deepEqual(Object.keys(ACTION_COLORS).sort(), ENUM_VALUES);
  for (const action of AUDIT_ACTIONS) {
    // The table applies the colour verbatim as the badge className — it must
    // be a "bg-… text-…" utility pair.
    assert.match(ACTION_COLORS[action], /^bg-\S+ text-\S+$/, `${action} color malformed: ${ACTION_COLORS[action]}`);
  }
});

test("labels are unique — no two actions render the same badge text in English", () => {
  const labels = AUDIT_ACTIONS.map((a) => enLabel(a));
  assert.equal(new Set(labels).size, labels.length);
});

test("spot checks: security-salient labels and groups are exact", () => {
  assert.equal(enLabel("AUTH_LOGIN_FAILED"), "Login Failed");
  assert.equal(enLabel("USER_DELETE"), "User Deleted");
  assert.equal(enLabel("BATCH_REQUEST_DECLINE"), "Batch Decline (Permanent)");
  assert.equal(ACTION_GROUP.AUTH_LOGIN, "auth");
  assert.equal(ACTION_GROUP.USER_DELETE, "admin");
  assert.equal(ACTION_GROUP.LIBRARY_SYNC, "system");
});

test("every action has a translated badge label in every catalog", () => {
  // The table renders `adminManage.audit.action.<ACTION>` — a missing key would
  // show the raw dotted id.
  for (const locale of LOCALES) {
    const cat = locale === "en" ? EN : readCatalog(locale);
    for (const action of AUDIT_ACTIONS) {
      const key = `adminManage.audit.action.${action}`;
      assert.ok(typeof cat[key] === "string" && cat[key].trim() !== "", `${locale} ${key}`);
    }
  }
});

test("the cache-clear action's badge names no single source — the one action records TMDB, MDBList, OMDb and \"all\" clears alike", () => {
  // /api/admin/clear-cache writes RATINGS_CACHE_CLEAR for every source and
  // carries the source in the details; the enum name stays (rows in the field).
  const label = enLabel("RATINGS_CACHE_CLEAR") ?? "";
  assert.equal(label, "Cache Cleared");
  assert.doesNotMatch(label, /rating/i);
});
