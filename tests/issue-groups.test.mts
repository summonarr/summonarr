// The admin Issues list's duplicate-report grouping (src/lib/issue-groups.ts)
// and the shared blank-name rule (src/lib/display-name.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupIssues } from "@/lib/issue-groups.ts";
import { displayName, nameOrEmail } from "@/lib/display-name.ts";

const issue = (id: string, status: string, day: number, name: string | null = id) => ({
  id,
  tmdbId: 1,
  mediaType: "MOVIE",
  issueType: "VIDEO",
  scope: "FULL",
  seasonNumber: null,
  episodeNumber: null,
  status,
  createdAt: new Date(Date.UTC(2026, 0, day)),
  user: { name, email: `${id}@x.test` },
});

test("a newer RESOLVED report never stands for older OPEN ones: status is part of the group key", () => {
  const groups = groupIssues([issue("old-open", "OPEN", 1), issue("new-resolved", "RESOLVED", 3), issue("mid-open", "OPEN", 2)]);
  assert.equal(groups.length, 2);
  const open = groups.find((g) => g.representative.status === "OPEN");
  assert.ok(open);
  assert.equal(open.representative.id, "mid-open", "the newest open report leads its group");
  assert.deepEqual(open.members.map((m) => m.id), ["mid-open", "old-open"], "every member, newest first");
  assert.equal(groups[0], open, "the larger group first");
});

test("reporter names fall back to the email for a blank display name", () => {
  const [g] = groupIssues([issue("a", "OPEN", 2, "  "), issue("b", "OPEN", 1, "Bea")]);
  assert.deepEqual(g.reporterNames, ["a@x.test", "Bea"]);
  assert.equal(displayName(""), null);
  assert.equal(displayName(" Al "), "Al");
  assert.equal(nameOrEmail({ name: null, email: "e@x.test" }), "e@x.test");
});
