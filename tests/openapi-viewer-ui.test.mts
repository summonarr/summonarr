// The admin API Docs viewer (src/components/admin/openapi-viewer.tsx) and its
// page. Source pins: the viewer is a client component the unit loader can't
// render, so these read the files and pin the wiring that makes a copied curl
// command work.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const viewer = readFileSync(new URL("../src/components/admin/openapi-viewer.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/app/(app)/admin/api-docs/page.tsx", import.meta.url), "utf8");

test("the copied curl uses the server's session cookie name, passed down by the page — never a guess from the browser's protocol", () => {
  // getSessionCookieName() follows AUTH_URL; the browser's protocol only
  // approximates it (a TLS proxy, or http://localhost against an https AUTH_URL).
  assert.match(page, /import \{ getSessionCookieName \} from "@\/lib\/session-cookie";/);
  assert.match(page, /<OpenApiViewer sessionCookieName=\{getSessionCookieName\(\)\} \/>/);
  assert.match(viewer, /export function OpenApiViewer\(\{ sessionCookieName \}: \{ sessionCookieName: string \}\)/);
  assert.match(viewer, /cookieName: sessionCookieName,/);
  assert.match(viewer, /--cookie '\$\{cookieName\}=YOUR_SESSION_TOKEN'/);
  assert.doesNotMatch(viewer, /window\.location\.protocol/);
  assert.doesNotMatch(viewer, /"__Host-summonarr-session"|"summonarr-session"/);
});

test("the curl url uses the spec's server url as-is — the spec already carries BASE_PATH", () => {
  // withBasePath is not idempotent: prefixing the spec's /request/api again
  // would copy /request/request/api/….
  assert.doesNotMatch(viewer, /withBasePath\(serverUrl\)/);
  assert.match(viewer, /const url = `\$\{origin\}\$\{serverUrl\}\$\{resolvedPath\}/);
  const route = readFileSync(new URL("../src/app/api/openapi/route.ts", import.meta.url), "utf8");
  assert.match(route, /servers: \[\{ url: withBasePath\("\/api"\), description: "Application API" \}\],/);
});

test("the Copied! label is reset through one useDelayed slot, and only the label it set is cleared", () => {
  assert.match(viewer, /const clearCopiedLater = useDelayed\(\);/);
  assert.match(viewer, /clearCopiedLater\(\(\) => setCopiedKey\(\(k\) => \(k === key \? null : k\)\), COPY_FEEDBACK_MS\);/);
  assert.match(viewer, /clearCopiedLater\.cancel\(\);/);
  assert.doesNotMatch(viewer, /setTimeout\(/, "an untracked timer is back");
});

test("every security scheme the spec uses has a translated label", () => {
  const route = readFileSync(new URL("../src/app/api/openapi/route.ts", import.meta.url), "utf8");
  const schemes = [...(/securitySchemes: \{([\s\S]*?)\n {4}\},\n {4}schemas:/.exec(route)?.[1] ?? "").matchAll(/^ {6}(\w+): \{/gm)].map((m) => m[1]);
  assert.deepEqual(schemes.sort(), ["cronSecret", "session", "sessionBearer"]);
  const en = JSON.parse(readFileSync(new URL("../src/lib/i18n/messages/en/adminManage.json", import.meta.url), "utf8")) as Record<string, string>;
  for (const scheme of schemes) {
    const key = new RegExp(`${scheme}: "(adminManage\\.apiDocs\\.security\\.${scheme})"`).exec(viewer)?.[1];
    assert.ok(key, `no label key for ${scheme}`);
    assert.ok(en[key], `${key} missing from the catalog`);
  }
});

test("the request-body example and the revealed command share one code-block style", () => {
  assert.match(viewer, /<pre style=\{CODE_BLOCK\}>/);
  assert.match(viewer, /<pre style=\{\{ \.\.\.CODE_BLOCK, userSelect: "text" \}\}>/);
  assert.equal(viewer.match(/<div style=\{SECTION_HEADING\}>/g)?.length, 3);
});
