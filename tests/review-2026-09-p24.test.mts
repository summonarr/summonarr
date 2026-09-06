// Review 2026-09 package P24 — src/components/settings/forms/arr-form.tsx.
//
// f99: the /api/settings PATCH answers a FAILED arr connection test with 422 and
//      ONLY the per-variant `<service><v>Error` key — there is NO top-level
//      `error` field. A form reading `data.error` alone therefore showed the
//      generic "Failed to save" and threw the computed diagnostic away. The route
//      half is pinned here against the real handler (the existing
//      tests/settings-route.test.mts pins the 4K variant; this covers the DEFAULT
//      variant, which is the common deployment) with an explicit "no `error`
//      field" assertion — that absence is exactly what the form now relies on.
//      The form half is a client component with no node:test render harness, so
//      it is pinned structurally: the source must read the variant key before
//      the generic one, mirroring email-form's `smtpError ?? error`.
//
// f98: a stored root folder / quality profile / language profile that the arr
//      server no longer lists had no matching <option>, so the controlled select
//      displayed the placeholder while state kept the stale value (and Save
//      Defaults stayed enabled). arr-instances-manager.tsx already surfaces such a
//      value as "(not found on server)"; arr-form.tsx is pinned to do the same
//      for all three selects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "review-p24-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";

console.warn = () => {};
console.error = () => {};

// Every outbound fetch fails ⇒ the arr status probe throws ⇒ the connection
// test fails ⇒ the route rolls back and answers 422.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  throw new Error(`scripted fetch failure for ${String(input)}`);
}) as typeof fetch;

const settings = new Map<string, string>();
type UpsertArgs = { where: { key: string }; update: { value: string }; create: { key: string; value: string } };

function makeTx() {
  return {
    setting: {
      upsert: async (args: UpsertArgs) => {
        settings.set(args.where.key, args.create.value);
        return { key: args.where.key, value: args.create.value };
      },
      deleteMany: async (args: { where: { key: string } }) => {
        settings.delete(args.where.key);
        return { count: 1 };
      },
    },
    auditLog: { create: async (args: { data: Record<string, unknown> }) => args.data },
  };
}

const USER_ID = "p24-admin";
const SESSION_ID = "p24-admin-sess";
const fakePrisma = {
  user: {
    findUnique: async (args: { where: { id: string } }) =>
      args.where.id === USER_ID
        ? {
            id: USER_ID, role: "ADMIN", permissions: 0n, name: "P24 Admin", email: "admin@example.com",
            mediaServer: null, notificationEmail: null,
            sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
          }
        : null,
    update: async () => ({}),
  },
  authSession: {
    findUnique: async (args: { where: { sessionId: string } }) =>
      args.where.sessionId === SESSION_ID ? { id: `row-${SESSION_ID}`, sessionId: SESSION_ID } : null,
    update: async () => ({}),
  },
  setting: {
    findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
      const only = args?.where?.key?.in;
      const rows = [...settings.entries()].map(([key, value]) => ({ key, value }));
      return only ? rows.filter((r) => only.includes(r.key)) : rows;
    },
    findUnique: async (args: { where: { key: string } }) => {
      const value = settings.get(args.where.key);
      return value === undefined ? null : { key: args.where.key, value };
    },
  },
  $transaction: async (arg: unknown) => {
    if (typeof arg === "function") return (arg as (t: ReturnType<typeof makeTx>) => Promise<unknown>)(makeTx());
    return Promise.all(arg as Promise<unknown>[]);
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

const { NextRequest } = await import("next/server");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { PATCH } = await import("../src/app/api/settings/route.ts");

async function adminHeader(): Promise<Record<string, string>> {
  const token = await signSessionJwt(
    { id: USER_ID, role: "ADMIN", permissions: "0", provider: "credentials", sessionId: SESSION_ID, expiresAt: Math.floor(Date.now() / 1000) + 86_400 },
    { expiresInSeconds: 7_200 },
  );
  return { authorization: `Bearer ${token}` };
}

function patchReq(body: unknown, headers: Record<string, string>) {
  return new NextRequest("http://localhost:3000/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("f99 (route contract): a failed DEFAULT-variant Radarr test answers 422 with `radarrError` and NO top-level `error`", async () => {
  const res = await PATCH(patchReq({ radarrUrl: "http://10.0.0.2:7878", radarrApiKey: "k-plaintext" }, await adminHeader()), undefined);
  assert.equal(res.status, 422);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.equal(body.radarrError, "Radarr connection failed", "the diagnostic the route computed");
  assert.equal("error" in body, false, "no generic `error` field — a form reading only data.error sees nothing");
  // Rolled back: nothing persisted.
  assert.equal(settings.has("radarrUrl"), false);
  assert.equal(settings.has("radarrApiKey"), false);
});

// ── structural pins on the client component (no render harness in node:test) ─
const here = path.dirname(fileURLToPath(import.meta.url));
const ARR_FORM = path.join(here, "..", "src", "components", "settings", "forms", "arr-form.tsx");
const src = readFileSync(ARR_FORM, "utf8");

test("f99 (form): handleSave reads the per-variant `<service><v>Error` key BEFORE the generic `error`", () => {
  assert.match(src, /const errorKey\s*=\s*`\$\{service\}\$\{v\}Error`/, "errorKey is derived like versionKey");
  assert.match(
    src,
    /setMessage\(data\[errorKey\] \?\? data\.error \?\? "Failed to save"\)/,
    "variant key first (only key present on a 422), then `error` (400/429), then the fallback",
  );
});

test("f98 (form): all three selects surface a stored value the server no longer lists as '(not found on server)'", () => {
  assert.match(
    src,
    /\{rootFolder && !options\.rootFolders\.some\(\(f\) => f\.path === rootFolder\) && \(\s*<option value=\{rootFolder\}>\{rootFolder\} \(not found on server\)<\/option>/,
    "root folder",
  );
  assert.match(
    src,
    /\{qualityProfileId && !options\.qualityProfiles\.some\(\(p\) => String\(p\.id\) === qualityProfileId\) && \(\s*<option value=\{qualityProfileId\}>Profile #\{qualityProfileId\} \(not found on server\)<\/option>/,
    "quality profile",
  );
  assert.match(
    src,
    /\{languageProfileId && !options\.languageProfiles!\.some\(\(p\) => String\(p\.id\) === languageProfileId\) && \(\s*<option value=\{languageProfileId\}>Profile #\{languageProfileId\} \(not found on server\)<\/option>/,
    "language profile",
  );
  // The stale option must precede the live list so it sits directly under the
  // placeholder, matching arr-instances-manager's layout.
  const stale = src.indexOf("(not found on server)");
  const live = src.indexOf("{options.rootFolders.map(");
  assert.ok(stale > 0 && live > stale, "stale-value option renders before the server list");
});
