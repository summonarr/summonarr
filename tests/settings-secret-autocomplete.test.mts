// Every password-type input in the settings UI holds a credential for ANOTHER
// service (a Radarr API key, a Plex token, an SMTP password, a bot token), never
// the admin's Summonarr login. Without an autocomplete hint a browser or
// password manager treats it as a login field on the same origin and can fill
// the saved Summonarr password in — which Save then stores as the token and, for
// Plex, sends to plex.tv. "off" is ignored on password fields by Chrome;
// "new-password" is the value browsers honour (MDN: it stops the browser
// filling an existing password).
//
// Structural scan: the components are .tsx client modules the unit loader
// can't render.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../src/components/settings", import.meta.url));

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

// The opening tag around each `type="password"`: from the nearest `<` before it
// to the first `/>` or `>` after it.
function passwordTags(src: string): string[] {
  const tags: string[] = [];
  let at = src.indexOf('type="password"');
  while (at >= 0) {
    const open = src.lastIndexOf("<", at);
    const close = src.indexOf(">", at);
    tags.push(src.slice(open, close + 1));
    at = src.indexOf('type="password"', at + 1);
  }
  return tags;
}

test("every password input under src/components/settings is marked autoComplete=\"new-password\"", () => {
  let seen = 0;
  for (const file of tsxFiles(root)) {
    for (const tag of passwordTags(readFileSync(file, "utf8"))) {
      seen++;
      assert.match(tag, /autoComplete="new-password"/, `${file.slice(root.length + 1)}: ${tag.slice(0, 80)}…`);
      assert.doesNotMatch(tag, /autoComplete="(off|on|current-password)"/);
    }
  }
  // The media/arr instance managers, the eight form fields and the
  // notification-channel token at the time of writing; a scan that finds
  // nothing proves nothing.
  assert.ok(seen >= 11, `expected the known password inputs, scanned ${seen}`);
});
