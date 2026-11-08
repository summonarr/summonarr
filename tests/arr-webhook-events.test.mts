// The webhooks' shared event pieces (src/lib/arr-webhook-events.ts): the
// post-import "now available" probes reach every configured server EVERY user
// can see — not only the default — and never a restricted one, whose library
// counts only for users granted it (guardrail 35). The routes' own suite
// (tests/webhook-routes.test.mts) drives the rest end to end.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";

// Jellyfin servers as RFC1918 literals, so the SSRF stack needs no DNS.
const asked: string[] = [];
let holdingHosts = new Set<string>();
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  asked.push(url.host);
  const items = holdingHosts.has(url.host) ? [{ Id: "i1", Name: "Show", Type: "Series", ProviderIds: { Tmdb: "1399" } }] : [];
  return new Response(JSON.stringify({ Items: items }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) =>
    settings.has(args.where.key) ? { key: args.where.key, value: settings.get(args.where.key)! } : null,
});

const { visibleAvailabilityChecks, manualInteractionMarkerKey } = await import("../src/lib/arr-webhook-events.ts");

beforeEach(() => {
  settings.clear();
  asked.length = 0;
  holdingHosts = new Set();
});

function jellyfin(slug: string, host: string): void {
  const seg = slug === "" ? "" : slug.charAt(0).toUpperCase() + slug.slice(1);
  settings.set(`jellyfin${seg}Url`, `http://${host}`);
  settings.set(`jellyfin${seg}ApiKey`, "key");
}

test("a title that landed on a named, unrestricted server is found there", async () => {
  settings.set("jellyfinInstances", JSON.stringify([{ slug: "anime", name: "Anime" }]));
  jellyfin("", "10.0.0.1:8096");
  jellyfin("anime", "10.0.0.2:8096");
  holdingHosts = new Set(["10.0.0.2:8096"]);
  const { checkJellyfin, checkPlex } = await visibleAvailabilityChecks(1399, "tv");
  assert.equal(checkPlex, null, "no Plex server configured");
  assert.ok(checkJellyfin);
  assert.equal(await checkJellyfin(), true);
});

test("with only a named server configured, its probe still exists — the poll is not skipped", async () => {
  settings.set("jellyfinInstances", JSON.stringify([{ slug: "anime", name: "Anime" }]));
  jellyfin("anime", "10.0.0.2:8096");
  const { checkJellyfin } = await visibleAvailabilityChecks(1399, "tv");
  assert.ok(checkJellyfin);
  assert.equal(await checkJellyfin(), false);
  assert.deepEqual(asked, ["10.0.0.2:8096"]);
});

test("a RESTRICTED server is never probed, and alone it leaves no probe at all", async () => {
  settings.set("jellyfinInstances", JSON.stringify([{ slug: "remote", name: "Remote", restricted: true }]));
  jellyfin("remote", "10.0.0.3:8096");
  holdingHosts = new Set(["10.0.0.3:8096"]);
  const { checkJellyfin } = await visibleAvailabilityChecks(1399, "tv");
  assert.equal(checkJellyfin, null);
  assert.deepEqual(asked, []);
});

test("the manual-interaction marker names the service, the firing instance and the stable id", () => {
  assert.equal(manualInteractionMarkerKey("radarr", "4k", 603), "manualInteractionNotified:radarr:4k:603");
  assert.equal(manualInteractionMarkerKey("sonarr", "", "tvdb:42"), "manualInteractionNotified:sonarr::tvdb:42");
});
