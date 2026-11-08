// What the Users page's media-server table lists and counts
// (src/components/admin/server-user-groups.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { serverUserView } from "../src/components/admin/server-user-groups.ts";

const row = (o: { source: string; username: string; email?: string | null; isServerAdmin?: boolean; downloadsEnabled?: boolean | null }) => ({
  email: null, isServerAdmin: false, downloadsEnabled: null, ...o,
});

test("a row of a source the table doesn't render is neither listed nor counted", () => {
  const users = [row({ source: "plex", username: "a" }), row({ source: "emby", username: "b" }), row({ source: "jellyfin", username: "c" })];
  const view = serverUserView(users, "");
  assert.deepEqual(view.groups.plex.map((u) => u.username), ["a"]);
  assert.deepEqual(view.groups.jellyfin.map((u) => u.username), ["c"]);
  assert.equal(view.shown, 2);
  assert.equal(view.total, 2, "the footer's total is what the table can list");
  assert.equal(serverUserView([row({ source: "emby", username: "b" })], "").total, 0, "only unknown rows: the empty state");
});

test("the search matches username or email, trimmed and case-insensitive, and the counts follow it", () => {
  const users = [
    row({ source: "plex", username: "Alice", email: "a@x.org" }),
    row({ source: "jellyfin", username: "bob", email: null }),
    row({ source: "jellyfin", username: "carol", email: "CAROL@x.org", downloadsEnabled: false }),
  ];
  const view = serverUserView(users, "  CAROL ");
  assert.equal(view.shown, 1);
  assert.equal(view.total, 3);
  assert.equal(serverUserView(users, "x.org").shown, 2, "email matches; a null email never does");
  assert.equal(serverUserView(users, "zzz").shown, 0);
});

test("the disabled count is listed Jellyfin members with downloads off — never a server admin, never an unsynced row", () => {
  const users = [
    row({ source: "jellyfin", username: "a", downloadsEnabled: false }),
    row({ source: "jellyfin", username: "b", downloadsEnabled: false, isServerAdmin: true }),
    row({ source: "jellyfin", username: "c", downloadsEnabled: null }),
    row({ source: "plex", username: "d", downloadsEnabled: false }),
  ];
  assert.equal(serverUserView(users, "").disabledJellyfin, 1);
  assert.equal(serverUserView(users, "b").disabledJellyfin, 0, "it counts the listed rows");
});
