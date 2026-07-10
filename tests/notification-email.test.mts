// Unit tests for notification-address resolution (src/lib/notification-email.ts).
// This resolver decides which address (if any) outgoing notification email is
// sent to. Getting it wrong either drops mail for real users or — worse —
// hands a synthetic placeholder identity (`jellyfin-<id>@jellyfin.local`,
// `discord_<id>@discord.local`) to SMTP, which hard-bounces and can hurt
// sender reputation. These tests pin the precedence order (notificationEmail
// first, login email second), the empty/whitespace fall-through, and the
// case-insensitive synthetic-suffix block that must return null (= skip send).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveUserNotificationEmail } from "../src/lib/notification-email.ts";

test("notificationEmail wins over the login email when both are set", () => {
  assert.equal(
    resolveUserNotificationEmail({
      email: "login@example.com",
      notificationEmail: "notify@example.com",
    }),
    "notify@example.com",
  );
});

test("null notificationEmail falls back to the login email", () => {
  assert.equal(
    resolveUserNotificationEmail({ email: "alice@example.com", notificationEmail: null }),
    "alice@example.com",
  );
});

test("empty-string notificationEmail falls back to the login email", () => {
  assert.equal(
    resolveUserNotificationEmail({ email: "alice@example.com", notificationEmail: "" }),
    "alice@example.com",
  );
});

test("whitespace-only notificationEmail is treated as unset", () => {
  assert.equal(
    resolveUserNotificationEmail({ email: "alice@example.com", notificationEmail: "   " }),
    "alice@example.com",
  );
  assert.equal(
    resolveUserNotificationEmail({ email: "alice@example.com", notificationEmail: "\t\n" }),
    "alice@example.com",
  );
});

test("synthetic Jellyfin login email is never a delivery address", () => {
  assert.equal(
    resolveUserNotificationEmail({
      email: "jellyfin-abc123@jellyfin.local",
      notificationEmail: null,
    }),
    null,
  );
});

test("synthetic Discord login email is never a delivery address", () => {
  assert.equal(
    resolveUserNotificationEmail({
      email: "discord_987654@discord.local",
      notificationEmail: null,
    }),
    null,
  );
});

test("synthetic-suffix check is case-insensitive", () => {
  assert.equal(
    resolveUserNotificationEmail({
      email: "JELLYFIN-ABC@JELLYFIN.LOCAL",
      notificationEmail: null,
    }),
    null,
  );
  assert.equal(
    resolveUserNotificationEmail({
      email: "Discord_1@Discord.Local",
      notificationEmail: null,
    }),
    null,
  );
});

test("a real notificationEmail overrides a synthetic login email", () => {
  // The whole point of the profile-page field: Jellyfin/Discord users become
  // reachable once they set one, even though their login identity is synthetic.
  assert.equal(
    resolveUserNotificationEmail({
      email: "jellyfin-abc123@jellyfin.local",
      notificationEmail: "real@example.com",
    }),
    "real@example.com",
  );
});

test("whitespace-only notificationEmail on a synthetic user still yields null", () => {
  // Falls through to the login email, which is then blocked as synthetic.
  assert.equal(
    resolveUserNotificationEmail({
      email: "discord_1@discord.local",
      notificationEmail: "  ",
    }),
    null,
  );
});

test("no deliverable address at all → null (skip send), never empty string", () => {
  assert.equal(resolveUserNotificationEmail({ email: "", notificationEmail: null }), null);
  assert.equal(resolveUserNotificationEmail({ email: "", notificationEmail: "" }), null);
});

test("suffix match requires the exact synthetic domain, not a lookalike", () => {
  // Neither is a synthetic identity the app generates; both must pass through.
  assert.equal(
    resolveUserNotificationEmail({ email: "user@notjellyfin.local", notificationEmail: null }),
    "user@notjellyfin.local",
  );
  assert.equal(
    resolveUserNotificationEmail({ email: "user@sub.jellyfin.local", notificationEmail: null }),
    "user@sub.jellyfin.local",
  );
});

test("notificationEmail is returned verbatim — no trimming or normalization", () => {
  // Pins current behavior: trim() is only used for the emptiness check; the
  // stored value (including any padding the profile form let through) is
  // returned untouched.
  assert.equal(
    resolveUserNotificationEmail({
      email: "login@example.com",
      notificationEmail: "  padded@example.com  ",
    }),
    "  padded@example.com  ",
  );
});
