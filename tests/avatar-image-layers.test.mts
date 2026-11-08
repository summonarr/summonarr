// AvatarImage (src/components/ui/avatar.tsx): a caller's ref is merged, never
// spread over the internal one the `.complete` hydration check reads, and the
// image overlays the fallback instead of sharing its flex row. The .tsx can't
// be rendered under node:test, so this pins the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("src/components/ui/avatar.tsx", "utf8");
const image = src.slice(src.indexOf("function AvatarImage"), src.indexOf("function AvatarFallback"));
const img = image.slice(image.indexOf("<img"), image.indexOf("/>", image.indexOf("<img")));

test("the caller's ref and alt are taken out of the spread, and the spread comes first", () => {
  assert.match(image, /ref: callerRef,/);
  assert.match(image, /\balt,\n/);
  const spread = img.indexOf("{...props}");
  assert.ok(spread !== -1 && spread < img.indexOf("ref={setRefs}"), "props must not override the merged ref");
  assert.ok(spread < img.indexOf('alt={alt ?? ""}'), "props must not override the alt default");
});

test("the image is layered over the fallback, not beside it", () => {
  assert.match(img, /"absolute inset-0 [^"]*size-full/);
});
