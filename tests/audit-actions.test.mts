// Unit tests for the audit-action metadata maps (src/lib/audit-actions.ts).
// /api/admin/audit-log and its /export sibling validate ?action= filters
// against AUDIT_ACTIONS (a bad filter must 400, not silently fall back to the
// unfiltered set), and the admin table renders badges from ACTION_LABELS +
// ACTION_GROUP. The Record<AuditAction, …> typing enforces completeness at
// compile time, but the unit suite runs strip-only — these runtime pins make
// sure a schema-side enum addition (prisma generate) can't drift from the
// maps without failing the suite, and pin the group partition and label
// uniqueness the filter dropdown relies on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditAction } from "@/generated/prisma";
import {
  AUDIT_ACTIONS,
  ACTION_GROUP,
  ACTION_LABELS,
  type AuditGroup,
} from "../src/lib/audit-actions.ts";

const ENUM_VALUES = Object.values(AuditAction).sort();

test("prisma runtime enum is an identity map (key === value)", () => {
  // Comparing enum constants against DB rows as plain strings is only sound
  // because the generated runtime enum maps every key to itself.
  assert.ok(Object.keys(AuditAction).length >= 35); // 35 actions as of this writing
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
  assert.equal(byGroup("admin").length, AUDIT_ACTIONS.length - 4 - 5);
});

test("ACTION_LABELS covers every enum value with a well-formed badge", () => {
  assert.deepEqual(Object.keys(ACTION_LABELS).sort(), ENUM_VALUES);
  for (const action of AUDIT_ACTIONS) {
    const meta = ACTION_LABELS[action];
    assert.ok(meta.label.length > 0, `${action} has an empty label`);
    // The table applies color verbatim as the badge className — it must be a
    // "bg-… text-…" utility pair.
    assert.match(meta.color, /^bg-\S+ text-\S+$/, `${action} color malformed: ${meta.color}`);
    assert.match(meta.icon, /^[a-z_]+$/, `${action} icon malformed: ${meta.icon}`);
  }
});

test("labels are unique — no two actions render the same badge text", () => {
  const labels = AUDIT_ACTIONS.map((a) => ACTION_LABELS[a].label);
  assert.equal(new Set(labels).size, labels.length);
});

test("spot checks: security-salient labels and groups are exact", () => {
  assert.equal(ACTION_LABELS.AUTH_LOGIN_FAILED.label, "Login Failed");
  assert.equal(ACTION_LABELS.USER_DELETE.label, "User Deleted");
  assert.equal(ACTION_LABELS.BATCH_REQUEST_DECLINE.label, "Batch Decline (Permanent)");
  assert.equal(ACTION_GROUP.AUTH_LOGIN, "auth");
  assert.equal(ACTION_GROUP.USER_DELETE, "admin");
  assert.equal(ACTION_GROUP.LIBRARY_SYNC, "system");
});
