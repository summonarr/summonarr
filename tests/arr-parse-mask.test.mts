// The credential masks every relayed Radarr/Sonarr/indexer text goes through
// (maskSecrets, src/lib/arr-parse.ts — guardrail 5e): one case table per
// named pass, the pass order, and the deliberately wide matches.
import { test } from "node:test";
import assert from "node:assert/strict";

const { MASK_PASSES, maskSecrets } = await import("../src/lib/arr-parse.ts");

// Each pass, alone, on a text only it masks: [input, what that pass leaves].
const BY_PASS: Record<string, Array<[string, string]>> = {
  "query parameter": [
    ["GET https://idx.example/api?t=search&apikey=abc123def&q=x", "GET https://idx.example/api?t=search&apikey=••••••••&q=x"],
    ["https://x/rss?jackett_apikey%3Dsecret99&y=1", "https://x/rss?jackett_apikey%3D••••••••&y=1"],
    ["https://t.example/download.php/1/x.torrent;tp=passkey55", "https://t.example/download.php/1/x.torrent;tp=••••••••"],
  ],
  "quoted pair": [['{"apiKey": "s3cr3t value; with, punct"}', '{"apiKey": "••••••••"}']],
  "unquoted pair": [
    ["api_key = plainsecret, next", "api_key = ••••••••, next"],
    ["X-Api-Key: hdrsecret", "X-Api-Key: ••••••••"],
  ],
  "Authorization header": [["Authorization: Token abc.def", "Authorization: ••••••••"]],
  "auth scheme": [["used Bearer eyJabc.def", "used Bearer ••••••••"]],
  "URL userinfo": [["http://user:p@ss@host.example/path", "http://••••••••@host.example/path"]],
  "path token": [["at [https://tracker.example/rss/AbCdEfGhIjKlMnOpQrStUvWxYz012345.xml]", "at [https://tracker.example/rss/••••••••.xml]"]],
  "TorrentLeech key": [["torrentleech.org/rss/download/123/abcdefghij12/file.torrent", "torrentleech.org/rss/download/123/••••••••/file.torrent"]],
};

const runPass = (name: string, input: string): string => {
  const pass = MASK_PASSES.find((p) => p.name === name);
  assert.ok(pass, `no pass named ${name}`);
  const { pattern, replace } = pass;
  return typeof replace === "string" ? input.replace(pattern, replace) : input.replace(pattern, replace);
};

test("every named pass masks its own form of credential", () => {
  assert.deepEqual(MASK_PASSES.map((p) => p.name).sort(), Object.keys(BY_PASS).sort(), "a case table for every pass");
  for (const [name, cases] of Object.entries(BY_PASS)) {
    for (const [input, expected] of cases) assert.equal(runPass(name, input), expected, `${name}: ${input}`);
  }
});

test("the passes run in a fixed order: query parameters first, the TorrentLeech key last", () => {
  assert.deepEqual(MASK_PASSES.map((p) => p.name), [
    "query parameter",
    "quoted pair",
    "unquoted pair",
    "Authorization header",
    "auth scheme",
    "URL userinfo",
    "path token",
    "TorrentLeech key",
  ]);
});

test("maskSecrets applies every pass: each table case comes out masked, clean text unchanged", () => {
  for (const cases of Object.values(BY_PASS)) {
    for (const [input, expected] of cases) assert.equal(maskSecrets(input), expected, input);
  }
  assert.equal(maskSecrets("no secrets here"), "no secrets here");
});

test("the wide matches are kept on purpose: any …key= name and a bare tp= are masked", () => {
  assert.equal(maskSecrets("monkey=banana"), "monkey=••••••••");
  assert.equal(maskSecrets("x;tp=abc"), "x;tp=••••••••");
});
