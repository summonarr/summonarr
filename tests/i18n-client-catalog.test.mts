// The root layout ships a SUBSET of the message catalog to the browser
// (clientCatalog in src/lib/i18n/catalogs.ts). A key a client module reads but
// the subset omits renders as the raw key — silently, in whichever locale — so
// the subset is only safe if it is proven against the client import graph.
//
// What is pinned:
//   - the shape of the subset (server-only areas never sent; admin areas only to
//     admin sessions; nothing else dropped; the lists name real areas);
//   - no client module outside the admin UI can reach a key in an admin area,
//     and no client module at all can reach a key in a server-only area. That is
//     a walk of the import graph from every "use client" file, not a grep: a
//     shared helper imported by a client component counts as client code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const {
  CATALOGS,
  clientCatalog,
  catalogAreas,
  SERVER_ONLY_AREAS,
  ADMIN_ONLY_AREAS,
} = await import("../src/lib/i18n/catalogs.ts");
const { LOCALES } = await import("../src/lib/i18n/locales.ts");

type Locale = (typeof LOCALES)[number];

function areaKeys(locale: Locale, area: string): string[] {
  return Object.keys(JSON.parse(readFileSync(join(ROOT, `src/lib/i18n/messages/${locale}/${area}.json`), "utf8")));
}

test("the area lists name real areas, and server-only and admin do not overlap", () => {
  const areas = new Set(catalogAreas("en"));
  for (const a of [...SERVER_ONLY_AREAS, ...ADMIN_ONLY_AREAS]) {
    assert.ok(areas.has(a), `'${a}' is not a catalog area`);
  }
  assert.deepEqual(SERVER_ONLY_AREAS.filter((a) => ADMIN_ONLY_AREAS.includes(a)), []);
});

test("clientCatalog: server-only never sent, admin only to admins, everything else always", () => {
  for (const locale of LOCALES) {
    const user = clientCatalog(locale, false);
    const admin = clientCatalog(locale, true);
    for (const area of catalogAreas(locale)) {
      const keys = areaKeys(locale, area);
      const serverOnly = SERVER_ONLY_AREAS.includes(area);
      const adminOnly = ADMIN_ONLY_AREAS.includes(area);
      for (const k of keys) {
        assert.equal(k in user, !serverOnly && !adminOnly, `${locale}/${area}: ${k} in the non-admin catalog`);
        assert.equal(k in admin, !serverOnly, `${locale}/${area}: ${k} in the admin catalog`);
      }
    }
    // Nothing is invented: the admin subset is the full catalog minus server-only.
    const serverKeys = new Set(SERVER_ONLY_AREAS.flatMap((a) => areaKeys(locale, a)));
    assert.deepEqual(
      Object.keys(admin).sort(),
      Object.keys(CATALOGS[locale]).filter((k) => !serverKeys.has(k)).sort(),
    );
    assert.equal(clientCatalog(locale, false), user, "memoised — a stable object for the provider's useMemo");
  }
});

test("clientCatalog actually shrinks the document (guards a silent return to the full catalog)", () => {
  const bytes = (m: Record<string, string>) => JSON.stringify(m).length;
  const full = bytes(CATALOGS.en);
  assert.ok(bytes(clientCatalog("en", true)) < full * 0.9, "admin catalog should drop the server-only areas");
  assert.ok(bytes(clientCatalog("en", false)) < full * 0.5, "non-admin catalog should drop server-only + admin areas");
});

// ---- the import-graph proof -------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const SRC = join(ROOT, "src");
const FILES = walk(SRC).filter((f) => !f.includes(`${sep}generated${sep}`));
const TEXT = new Map(FILES.map((f) => [f, readFileSync(f, "utf8")]));
const rel = (f: string) => relative(ROOT, f).split(sep).join("/");

// `import type` / `export type` are erased and carry no runtime reference.
const IMPORT =
  /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = normalize(join(dirname(from), spec));
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (TEXT.has(c)) return c;
  }
  return null;
}

const GRAPH = new Map<string, Set<string>>();
for (const [f, text] of TEXT) {
  const deps = new Set<string>();
  for (const m of text.matchAll(IMPORT)) {
    const r = resolveImport(f, m[1] ?? m[2] ?? m[3]);
    if (r) deps.add(r);
  }
  GRAPH.set(f, deps);
}

// Skip leading whitespace and comments one at a time (a single regex with a
// repeated \s*-led group backtracks polynomially), then look for the directive.
const isClient = (f: string) => {
  let s = TEXT.get(f)!.trimStart();
  for (;;) {
    if (s.startsWith("//")) {
      const nl = s.indexOf("\n");
      s = nl < 0 ? "" : s.slice(nl + 1).trimStart();
    } else if (s.startsWith("/*")) {
      const end = s.indexOf("*/", 2);
      s = end < 0 ? "" : s.slice(end + 2).trimStart();
    } else break;
  }
  return /^['"]use client['"]/.test(s);
};
const CLIENTS = FILES.filter(isClient);

function closure(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const d of GRAPH.get(f) ?? []) if (!seen.has(d)) stack.push(d);
  }
  return seen;
}

function prefixesOf(area: string): string[] {
  return [...new Set(areaKeys("en", area).map((k) => k.split(".")[0]))];
}

function filesReferencing(area: string, within: Set<string>): string[] {
  const re = new RegExp(`['"\`](?:${prefixesOf(area).join("|")})\\.[A-Za-z0-9_]`);
  return [...within].filter((f) => re.test(TEXT.get(f)!)).map(rel).sort();
}

// The admin UI directories. Client code under these renders only for a session
// that passed the admin gate (the (app)/admin layout, the ADMIN-only /settings
// page, ADMIN-gated chips on the detail pages).
const ADMIN_UI = ["src/components/admin/", "src/components/settings/", "src/app/(app)/admin/", "src/app/(app)/settings/"];

// Reached from non-admin client code but rendered only for admins. Each entry
// is a claim — read the call site before adding one.
const ADMIN_AREA_ALLOWED: Record<string, string[]> = {
  // Labels for the admin nav section; the sidebar renders that section only for
  // a session with an admin permission.
  "src/lib/nav-items.ts": ["adminArr", "adminManage"],
};

// Modules the admin UI imports for constants and pure helpers, which also hold a
// validator that takes an optional translator and is called only from routes
// (the route passes the request's server translator). File-level reachability
// can't tell the two apart, so the claim is checked directly below: no client
// module may reference the validator itself.
const SERVER_ONLY_ALLOWED: Record<string, { area: string; validators: string[] }> = {
  "src/lib/library-cleanup.ts": { area: "apiAdmin", validators: ["validateCleanupSettingsPatch"] },
  "src/lib/watch-grade.ts": { area: "apiAdmin", validators: ["watchGradeSettingError", "watchGradeCrossFieldError"] },
};

test("no client module reaches a SERVER-ONLY message area", () => {
  const reach = closure(CLIENTS);
  const offenders = SERVER_ONLY_AREAS.flatMap((a) => filesReferencing(a, reach).map((f) => `${a}: ${f}`)).filter(
    (o) => {
      const [area, file] = o.split(": ");
      return SERVER_ONLY_ALLOWED[file]?.area !== area;
    },
  );
  assert.deepEqual(offenders, [], "a client module reads a key the browser is never sent");
});

test("the server-only allowlist holds: no client module calls the validators that use those keys", () => {
  for (const [file, { validators }] of Object.entries(SERVER_ONLY_ALLOWED)) {
    assert.ok(existsSync(join(ROOT, file)), `allowlisted file ${file} is gone`);
    for (const v of validators) {
      assert.ok(TEXT.get(join(ROOT, file))!.includes(v), `${file} no longer defines ${v} — update the allowlist`);
      const users = CLIENTS.filter((c) => new RegExp(`\\b${v}\\b`).test(TEXT.get(c)!)).map(rel);
      assert.deepEqual(users, [], `a client module references ${v}, which reads keys the browser is never sent`);
    }
  }
});

test("no client module outside the admin UI reaches an ADMIN-ONLY message area", () => {
  const roots = CLIENTS.filter((f) => !ADMIN_UI.some((d) => rel(f).startsWith(d)));
  const reach = closure(roots);
  const offenders: string[] = [];
  for (const a of ADMIN_ONLY_AREAS) {
    for (const f of filesReferencing(a, reach)) {
      if (!(ADMIN_AREA_ALLOWED[f] ?? []).includes(a)) offenders.push(`${a}: ${f}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "non-admin client code reads a key only admin sessions are sent — move the area out of ADMIN_ONLY_AREAS, " +
      "or (if the call site really is admin-gated) allowlist it with a reason",
  );
  for (const f of Object.keys(ADMIN_AREA_ALLOWED)) assert.ok(existsSync(join(ROOT, f)), `allowlisted file ${f} is gone`);
});

test("the graph walk sees what it should (guards a vacuously passing proof)", () => {
  assert.ok(CLIENTS.length > 100, `expected 100+ client files, found ${CLIENTS.length}`);
  const roots = CLIENTS.filter((f) => !ADMIN_UI.some((d) => rel(f).startsWith(d)));
  // my-stats-view imports activity-ui from components/admin, which reads adminActivity keys —
  // proving the walk follows an import out of a non-admin file into an admin directory.
  assert.ok(filesReferencing("adminActivity", closure(roots)).includes("src/components/admin/activity-ui.tsx"));
  assert.ok(filesReferencing("adminQueue", closure(CLIENTS)).length > 0, "admin UI does read adminQueue keys");
});

test("the root layout hands the provider the client subset, never the full catalog", () => {
  const layout = readFileSync(join(ROOT, "src/app/layout.tsx"), "utf8");
  assert.match(layout, /messages=\{clientCatalog\(locale, includeAdminMessages\)\}/);
  assert.doesNotMatch(layout, /CATALOGS/, "the full catalog must not reach the document");
  // The gate is the admin layout's, so an admin-visible surface can't lose its strings.
  for (const p of ["MANAGE_USERS", "MANAGE_REQUESTS", "MANAGE_ISSUES", "ADMIN"]) {
    assert.ok(layout.includes(`Permission.${p}`), `root layout gate lost Permission.${p}`);
  }
});
