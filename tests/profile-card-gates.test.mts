// Which profile cards and switches an account is shown, pinned on the source:
// each of these controls is the only way on the web to change something the
// server keeps doing regardless.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const PAGE = read("src/app/(app)/profile/page.tsx");
const PREFS = read("src/components/profile/notification-prefs.tsx");
const FEED = read("src/components/profile/calendar-feed.tsx");

test("the issue notification switch shows for every account, worded for what it does for that account", () => {
  // Replies to a reporter's own issues are gated on notifyOnIssue too, so a
  // plain user needs the switch as much as an issue manager does.
  assert.doesNotMatch(PREFS, /\{managesIssues && \(/, "the row is not hidden from non-managers");
  assert.match(PREFS, /\{toggleRows\(issueRows\)\}/);
  assert.match(PREFS, /managesIssues\s*\?\s*\{ key: "notifyOnIssue", label: t\("profile\.notifications\.issues"\)/);
  assert.match(PREFS, /:\s*\{ key: "notifyOnIssue", label: t\("profile\.notifications\.issueReplies"\)/);
});

test("the manager wording follows the MANAGE_ISSUES permission, not only the role label", () => {
  assert.match(PAGE, /managesIssues=\{[^}]*hasPermission\(session\.user\.permissions, Permission\.MANAGE_ISSUES\)/);
});

test("a stored calendar link keeps its card while the feature is off, revoke only", () => {
  assert.match(PAGE, /\{\(calendarEnabled \|\| !!user\.calendarTokenHash\) && \(/);
  assert.match(PAGE, /revokeOnly=\{!calendarEnabled\}/);
  // Revoke only: no create/regenerate button, and the revoke stays.
  assert.match(FEED, /\{!revokeOnly && \(\s*<Button[^>]*onClick=\{\(\) => \(active \? setConfirming\("regenerate"\) : generate\(\)\)\}/);
  assert.match(FEED, /\{active && \(\s*<Button[^>]*onClick=\{\(\) => setConfirming\("revoke"\)\}/);
});

test("every locale carries the strings these controls read", () => {
  const keys: Array<[string, string]> = [
    ["profile", "profile.notifications.issueReplies"],
    ["profile", "profile.notifications.issueRepliesHint"],
    ["profile", "profile.calendar.featureOff"],
    ["profile", "profile.calendar.featureOffRemoved"],
    ["auth", "auth.plexDone.error.noFlow"],
  ];
  for (const locale of ["en", "es", "fr", "de", "pt", "it", "zh"]) {
    for (const [area, key] of keys) {
      const catalog = JSON.parse(read(`src/lib/i18n/messages/${locale}/${area}.json`)) as Record<string, string>;
      assert.ok(catalog[key]?.trim(), `${locale}: ${key}`);
    }
  }
});
