// Which of the viewer's requests light up a detail page's MAIN Request button
// (src/lib/main-request-button.ts).
//
// The main button posts with no arrInstance, so it lands on the default
// instance or on the named instance this title AUTO-ROUTES to. The detail pages
// used to count every non-4K request toward it, so an explicit "Request on X"
// on a named instance the title doesn't route to showed the main button as
// Requested and blocked a valid default-instance request. Requests on other
// named instances belong to their own RequestInstanceButton.
//
// Impurity: prisma.setting (the arr registry JSON + per-instance url/apiKey
// presence), shadowed in-memory as in tests/named-instance-targets.test.mts.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.ts";
import { mainButtonRequested, resolveMainButtonRequested, routableMedia } from "../src/lib/main-request-button.ts";
import { shadowPrismaModel } from "./_helpers.mts";

const registryValues = new Map<string, string>();
let configuredKeys = new Set<string>();
let settingReads = 0;

shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    settingReads++;
    const v = registryValues.get(args.where.key);
    return v !== undefined ? { key: args.where.key, value: v } : null;
  },
  findMany: async (args: { where: { key: { in: string[] } } }) => {
    settingReads++;
    return args.where.key.in.filter((k) => configuredKeys.has(k)).map((k) => ({ key: k, value: "set" }));
  },
});

beforeEach(() => {
  registryValues.clear();
  configuredKeys = new Set<string>();
  settingReads = 0;
});

// Sonarr: "anime" auto-routes anime, "kids" is explicit-only; both configured.
function registerSonarr() {
  registryValues.set(
    "arrSonarrInstances",
    JSON.stringify([
      { slug: "anime", name: "Anime", autoRoute: { animeOnly: true } },
      { slug: "kids", name: "Kids" },
    ]),
  );
  configuredKeys = new Set(["sonarrAnimeUrl", "sonarrAnimeApiKey", "sonarrKidsUrl", "sonarrKidsApiKey"]);
}

const ANIME = routableMedia({ genreList: [{ id: 16 }], originalLanguage: "ja", originCountryCodes: ["JP"] });
const DRAMA = routableMedia({ genreList: [{ id: 18 }], originalLanguage: "en", originCountryCodes: ["US"] });

test("mainButtonRequested: the default instance and the auto-route slug count, nothing else", () => {
  assert.equal(mainButtonRequested([""], ""), true);
  assert.equal(mainButtonRequested(["anime"], "anime"), true);
  assert.equal(mainButtonRequested(["kids"], "anime"), false, "an explicit request elsewhere is that button's");
  assert.equal(mainButtonRequested(["kids"], ""), false);
  assert.equal(mainButtonRequested(["4k"], "4k"), false, "4K has its own button");
  assert.equal(mainButtonRequested([], ""), false);
  assert.equal(mainButtonRequested(["kids", ""], "anime"), true);
});

test("routableMedia maps the detail payload the way request-create does", () => {
  assert.deepEqual(ANIME, { genreIds: [16], originalLanguage: "ja", originCountries: ["JP"] });
  assert.deepEqual(routableMedia({}), { genreIds: [], originalLanguage: null, originCountries: [] });
});

test("a request on a named instance the title does NOT route to leaves the main button requestable", async () => {
  registerSonarr();
  assert.equal(await resolveMainButtonRequested("TV", ["kids"], DRAMA), false);
  assert.equal(await resolveMainButtonRequested("TV", ["anime"], DRAMA), false, "a drama doesn't route to anime");
});

test("a request on the slug the title auto-routes to lights the main button", async () => {
  registerSonarr();
  assert.equal(await resolveMainButtonRequested("TV", ["anime"], ANIME), true);
  assert.equal(await resolveMainButtonRequested("TV", ["kids"], ANIME), false);
});

test("an UNCONFIGURED auto-route instance is never the main button's target", async () => {
  // request-create routes over configured instances only, so the request lands on "".
  registerSonarr();
  configuredKeys = new Set(["sonarrKidsUrl", "sonarrKidsApiKey"]);
  assert.equal(await resolveMainButtonRequested("TV", ["anime"], ANIME), false);
});

test("the registry is read only when a named-instance request could change the answer", async () => {
  registerSonarr();
  assert.equal(await resolveMainButtonRequested("TV", ["", "kids"], DRAMA), true);
  assert.equal(await resolveMainButtonRequested("TV", [], DRAMA), false);
  assert.equal(await resolveMainButtonRequested("TV", ["4k"], DRAMA), false);
  assert.equal(settingReads, 0);
});

test("both detail pages decide the main button through the resolver", async () => {
  const { readFileSync } = await import("node:fs");
  // The shared detail loader decides it, from the viewer's non-4K requests.
  const loader = readFileSync("src/lib/detail-page-data.ts", "utf8");
  assert.ok(
    loader.includes("resolveMainButtonRequested(mediaType, userRequests.map((r) => r.arrInstance), routableMedia(media))"),
    "detail-page-data.ts: the main button's `requested` comes from resolveMainButtonRequested",
  );
  assert.match(loader, /rows\.filter\(\(r\) => r\.arrInstance !== FOURK_ARR_INSTANCE\)/, "4K requests are the 4K button's");
  for (const [file, type] of [["src/app/(app)/movie/[id]/page.tsx", "MOVIE"], ["src/app/(app)/tv/[id]/page.tsx", "TV"]] as const) {
    const src = readFileSync(file, "utf8");
    assert.ok(src.includes(`loadDetailPageState(session, media, "${type}")`), `${file}: reads its state through the shared loader`);
    assert.doesNotMatch(src, /const requested\s*= !!userRequest\b/, `${file}: any non-4K request no longer counts`);
  }
});
