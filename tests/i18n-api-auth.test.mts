// Language of the auth / setup / session / profile API messages (catalog area
// apiAuth.*). A sample of DB-free sites, each called three ways:
//   - no hints at all → the exact English literal the route always sent, so
//     every existing wire assertion (and the iOS app, which sends no cookie and
//     is pinned to the instance default) sees no change;
//   - the picker cookie → Spanish;
//   - Accept-Language: es → Spanish.
// The MFA challenge / step-up halves (whose machine fields must NOT change)
// are pinned in tests/mfa-routes.test.mts beside their own harness.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TRUST_PROXY = "true";
delete process.env.SUMMONARR_DEFAULT_LOCALE;
delete process.env.AUTH_URL;
delete process.env.AUTH_TRUSTED_ORIGIN;

const { NextRequest } = await import("next/server");
const credentials = await import("../src/app/api/auth/sign-in/credentials/route.ts");
const register = await import("../src/app/api/auth/register/route.ts");
const quickConnect = await import("../src/app/api/auth/jellyfin/quickconnect/route.ts");
const importChunk = await import("../src/app/api/setup/import-chunk/route.ts");
const confirm = await import("../src/app/api/profile/notification-email/confirm/route.ts");

const HINTS = {
  none: {},
  cookie: { cookie: "summonarr-locale=es" },
  acceptLanguage: { "accept-language": "es-ES,es;q=0.9" },
} as const;

function req(path: string, method: string, headers: Record<string, string>, body?: unknown) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

test("sign-in credentials: missing fields → English with no hints, Spanish with a cookie or Accept-Language", async () => {
  const run = async (h: Record<string, string>) =>
    errorOf(await credentials.POST(req("/api/auth/sign-in/credentials", "POST", h, {})));
  assert.equal(await run(HINTS.none), "Email and password required");
  assert.equal(await run(HINTS.cookie), "Se requieren el correo electrónico y la contraseña");
  assert.equal(await run(HINTS.acceptLanguage), "Se requieren el correo electrónico y la contraseña");
});

test("a native client stays on the instance default even with a Spanish Accept-Language", async () => {
  const res = await credentials.POST(
    req("/api/auth/sign-in/credentials", "POST", { ...HINTS.acceptLanguage, "x-summonarr-client": "ios; build=40" }, {}),
  );
  assert.equal(await errorOf(res), "Email and password required");
});

test("register: the cross-origin refusal is translated, status unchanged", async () => {
  for (const [hint, want] of [[HINTS.none, "Forbidden"], [HINTS.cookie, "Prohibido"]] as const) {
    const res = await register.POST(req("/api/auth/register", "POST", hint, {}));
    assert.equal(res.status, 403);
    assert.equal(await errorOf(res), want);
  }
});

test("QuickConnect: an invalid server slug", async () => {
  const run = (h: Record<string, string>) =>
    quickConnect.POST(req("/api/auth/jellyfin/quickconnect?instance=NOT%20A%20SLUG!", "POST", h));
  const en = await run(HINTS.none);
  assert.equal(en.status, 400);
  assert.equal(await errorOf(en), "Invalid server");
  assert.equal(await errorOf(await run(HINTS.acceptLanguage)), "Servidor no válido");
});

test("setup import: a cancel without X-Upload-Id", async () => {
  const run = (h: Record<string, string>) => importChunk.DELETE(req("/api/setup/import-chunk", "DELETE", h));
  assert.equal(await errorOf(await run(HINTS.none)), "Missing X-Upload-Id.");
  assert.equal(await errorOf(await run(HINTS.cookie)), "Falta X-Upload-Id.");
});

test("notification-email confirm page: English (lang=en) with no hints, Spanish (lang=es) with a cookie", async () => {
  const en = await confirm.GET(new Request("http://localhost:3000/api/profile/notification-email/confirm"));
  assert.equal(en.status, 400);
  const enHtml = await en.text();
  assert.match(enHtml, /<html lang="en">/);
  assert.match(enHtml, /<title>Invalid link<\/title>/);
  assert.match(enHtml, /This verification link is missing its token\./);

  const es = await confirm.GET(
    new Request("http://localhost:3000/api/profile/notification-email/confirm", { headers: HINTS.cookie }),
  );
  const esHtml = await es.text();
  assert.match(esHtml, /<html lang="es">/);
  assert.match(esHtml, /<title>Enlace no válido<\/title>/);
  assert.match(esHtml, /A este enlace de verificación le falta el token\./);
});
