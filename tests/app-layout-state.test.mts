// The (app) layout's render state, derived from its per-request reads. The
// layout itself imports .tsx and can't be loaded here; its read wiring is
// pinned in tests/app-layout-db-shape.test.mts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appLayoutStateFrom } from "../src/lib/app-layout-state.ts";

const rows = (cfg: Record<string, string>) => Object.entries(cfg).map(([key, value]) => ({ key, value }));

test("every value defaults when every read failed", () => {
  const s = appLayoutStateFrom({ rows: [], flags: undefined, user: undefined, userReadOk: false });
  assert.deepEqual(s, {
    hiddenRatingSources: [], motdBody: "", motdTitle: "", siteTitle: "", discordInviteUrl: "",
    maintenanceEnabled: false, maintenanceMessage: "", featureFlags: undefined,
    userDiscordId: null, storedLocale: null, localeKnown: false,
  });
});

test("the MOTD body shows only while the MOTD is enabled", () => {
  const on = appLayoutStateFrom({ rows: rows({ motdEnabled: "true", motdBody: "hi", motdTitle: "T" }), flags: {}, user: null, userReadOk: true });
  assert.equal(on.motdBody, "hi");
  assert.equal(on.motdTitle, "T");
  const off = appLayoutStateFrom({ rows: rows({ motdEnabled: "false", motdBody: "hi" }), flags: {}, user: null, userReadOk: true });
  assert.equal(off.motdBody, "");
});

test("maintenance mode is read from its settings", () => {
  const s = appLayoutStateFrom({ rows: rows({ maintenanceEnabled: "true", maintenanceMessage: "back soon" }), flags: {}, user: null, userReadOk: true });
  assert.equal(s.maintenanceEnabled, true);
  assert.equal(s.maintenanceMessage, "back soon");
});

test("a failed user read skips the Discord join prompt and does not look like 'no stored locale'", () => {
  const failed = appLayoutStateFrom({ rows: rows({ discordInviteUrl: "https://discord.gg/x" }), flags: {}, user: undefined, userReadOk: false });
  assert.equal(failed.discordInviteUrl, "");
  assert.equal(failed.localeKnown, false);
  const ok = appLayoutStateFrom({
    rows: rows({ discordInviteUrl: "https://discord.gg/x" }), flags: {},
    user: { discordId: "123", locale: "fr" }, userReadOk: true,
  });
  assert.equal(ok.discordInviteUrl, "https://discord.gg/x");
  assert.equal(ok.userDiscordId, "123");
  assert.equal(ok.storedLocale, "fr");
  assert.equal(ok.localeKnown, true);
  // A successful read with no row: the invite still shows, the locale is unknown.
  const missing = appLayoutStateFrom({ rows: rows({ discordInviteUrl: "https://discord.gg/x" }), flags: {}, user: null, userReadOk: true });
  assert.equal(missing.discordInviteUrl, "https://discord.gg/x");
  assert.equal(missing.localeKnown, false);
});

test("the Donate nav link is hidden while no donation link is configured", () => {
  const s = appLayoutStateFrom({ rows: [], flags: { "feature.page.donate": true, other: true }, user: null, userReadOk: true });
  assert.deepEqual(s.featureFlags, { "feature.page.donate": false, other: true });
});
