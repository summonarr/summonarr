// Every loading skeleton tells assistive tech the page is loading: its root is
// SkeletonRoot (src/components/loading/skeleton-primitives.tsx) — a busy
// role="status" region named by a translated sr-only "Loading…". A bare
// `<div className="animate-pulse">` root gave screen-reader users nothing.
// The node:test loader can't render .tsx, so this pins the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const KIT = "src/components/loading/skeleton-primitives.tsx";
const kit = readFileSync(KIT, "utf8");
const loadingFiles = walk("src/app/(app)").filter((p) => p.endsWith("loading.tsx"));
const skeletonFiles = walk("src/components/loading").filter((p) => p.endsWith(".tsx"));

// The page-level skeleton components a loading.tsx may return directly.
const ROOT_COMPONENTS = new Set<string>();
for (const f of skeletonFiles) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/export function (\w+)\([^)]*\)[^{]*\{\s*return \(\s*<SkeletonRoot\b/g)) ROOT_COMPONENTS.add(m[1]);
}

test("SkeletonRoot is a busy status region with a translated sr-only label", () => {
  const root = kit.slice(kit.indexOf("export function SkeletonRoot"));
  assert.match(root, /role="status"/);
  assert.match(root, /aria-busy="true"/);
  assert.match(root, /<SkeletonLoadingLabel \/>/);
  const label = readFileSync("src/components/loading/skeleton-label.tsx", "utf8");
  assert.match(label, /className="sr-only"/);
  assert.match(label, /t\("shared\.common\.loading"\)/, "the label comes from the catalog, never hard-coded English");
  for (const locale of readdirSync("src/lib/i18n/messages")) {
    const shared = JSON.parse(readFileSync(`src/lib/i18n/messages/${locale}/shared.json`, "utf8"));
    assert.ok(shared["shared.common.loading"], `${locale} lacks shared.common.loading`);
  }
});

test("the kit's page-level skeletons are rooted in SkeletonRoot", () => {
  for (const name of ["PosterGridSkeleton", "AdminSkeleton", "AdminQueueSkeleton", "TitleDetailSkeleton", "UserDetailSkeleton", "PlayDetailSkeleton"]) {
    assert.ok(ROOT_COMPONENTS.has(name), `${name} must render <SkeletonRoot> as its root`);
  }
});

test("no skeleton root is a bare animate-pulse div", () => {
  for (const f of [...loadingFiles, ...skeletonFiles]) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /<div className="[^"]*\banimate-pulse\b[^"]*">/, `${f} still has a bare pulse root`);
  }
});

test("every (app) loading boundary renders SkeletonRoot or a skeleton rooted in it", () => {
  assert.ok(loadingFiles.length > 20, `only ${loadingFiles.length} loading.tsx files found`);
  for (const f of loadingFiles) {
    const src = readFileSync(f, "utf8");
    const body = src.slice(src.indexOf("export default function"));
    const direct = /return \(\s*<SkeletonRoot\b/.test(body);
    const returned = [...body.matchAll(/<(\w+Skeleton)\b/g)].map((m) => m[1]);
    const viaKit = returned.length > 0 && /return\s+(?:\w+\s*\?\s*)?<\w+Skeleton\b/.test(body) && returned.every((n) => ROOT_COMPONENTS.has(n));
    assert.ok(direct || viaKit, `${f}: root is neither <SkeletonRoot> nor a skeleton rooted in it`);
  }
});
