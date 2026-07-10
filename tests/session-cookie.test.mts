// Unit tests for session cookie naming/serialization (src/lib/session-cookie.ts).
// The `__Host-` prefix is a browser-enforced security boundary: it requires
// Secure + Path=/ + no Domain, making the session cookie un-spoofable by
// sibling hosts. These tests pin the secure/insecure name derivation off
// AUTH_URL (with the NODE_ENV fallback), the exact Set-Cookie attribute
// strings both prefix invariants depend on, the sign-out clearing set
// (including legacy next-auth names), and the parse path's refusal to honor
// a plain-named cookie in a secure context.
//
// AUTH_URL / NODE_ENV are read per-call (inside isSecureContext), not at
// module load, so tests mutate process.env directly — no cache-busting
// re-import needed. node:test runs these sequentially in one process; each
// test sets the env it depends on via withEnv, which restores afterward.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getSessionCookieName,
  serializeSessionCookie,
  serializeClearedSessionCookies,
  parseSessionCookie,
} from "../src/lib/session-cookie.ts";

const SECURE_NAME = "__Host-summonarr-session";
const INSECURE_NAME = "summonarr-session";

// NODE_ENV is typed read-only in @types/node; the assertion (erasable TS
// syntax, safe under strip-only mode) gives us a mutable view for the test.
const mutableEnv = process.env as Record<string, string | undefined>;

function withEnv<T>(
  env: { AUTH_URL?: string; NODE_ENV?: string },
  fn: () => T,
): T {
  const prevAuthUrl = mutableEnv.AUTH_URL;
  const prevNodeEnv = mutableEnv.NODE_ENV;
  if (env.AUTH_URL === undefined) delete mutableEnv.AUTH_URL;
  else mutableEnv.AUTH_URL = env.AUTH_URL;
  if (env.NODE_ENV === undefined) delete mutableEnv.NODE_ENV;
  else mutableEnv.NODE_ENV = env.NODE_ENV;
  try {
    return fn();
  } finally {
    if (prevAuthUrl === undefined) delete mutableEnv.AUTH_URL;
    else mutableEnv.AUTH_URL = prevAuthUrl;
    if (prevNodeEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = prevNodeEnv;
  }
}

// --- getSessionCookieName: secure-context derivation ---

test("https AUTH_URL → __Host- prefixed name", () => {
  withEnv({ AUTH_URL: "https://requests.example.com" }, () => {
    assert.equal(getSessionCookieName(), SECURE_NAME);
  });
});

test("http AUTH_URL → plain name, even in production NODE_ENV", () => {
  // An explicit http:// AUTH_URL (LAN deployment) must win over the NODE_ENV
  // fallback — __Host- cookies are silently dropped by browsers over http.
  withEnv({ AUTH_URL: "http://192.168.1.10:3001", NODE_ENV: "production" }, () => {
    assert.equal(getSessionCookieName(), INSECURE_NAME);
  });
});

test("no AUTH_URL falls back to NODE_ENV: production secure, otherwise plain", () => {
  withEnv({ AUTH_URL: undefined, NODE_ENV: "production" }, () => {
    assert.equal(getSessionCookieName(), SECURE_NAME);
  });
  withEnv({ AUTH_URL: undefined, NODE_ENV: "development" }, () => {
    assert.equal(getSessionCookieName(), INSECURE_NAME);
  });
  withEnv({ AUTH_URL: undefined, NODE_ENV: undefined }, () => {
    assert.equal(getSessionCookieName(), INSECURE_NAME);
  });
});

test("schemeless/malformed AUTH_URL falls through to the NODE_ENV check", () => {
  withEnv({ AUTH_URL: "requests.example.com", NODE_ENV: "production" }, () => {
    assert.equal(getSessionCookieName(), SECURE_NAME);
  });
  withEnv({ AUTH_URL: "requests.example.com", NODE_ENV: "development" }, () => {
    assert.equal(getSessionCookieName(), INSECURE_NAME);
  });
  // Scheme matching is case-sensitive prefix matching: "HTTPS://" is neither
  // branch, so it also falls through. Pins current behavior.
  withEnv({ AUTH_URL: "HTTPS://example.com", NODE_ENV: "development" }, () => {
    assert.equal(getSessionCookieName(), INSECURE_NAME);
  });
});

// --- serializeSessionCookie: exact attribute strings ---

test("secure context serializes the full __Host- contract (Secure, Path=/, no Domain)", () => {
  withEnv({ AUTH_URL: "https://requests.example.com" }, () => {
    const cookie = serializeSessionCookie("tok.abc.def", { maxAgeSeconds: 3600 });
    assert.equal(
      cookie,
      "__Host-summonarr-session=tok.abc.def; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure",
    );
    // __Host- prefix invariants the browser enforces — violating any one of
    // these makes browsers silently reject the Set-Cookie.
    assert.ok(cookie.includes("Secure"));
    assert.ok(cookie.includes("Path=/"));
    assert.ok(!/domain=/i.test(cookie));
  });
});

test("insecure context serializes the plain name without Secure", () => {
  withEnv({ AUTH_URL: "http://localhost:3000" }, () => {
    const cookie = serializeSessionCookie("tok.abc.def", { maxAgeSeconds: 86400 });
    assert.equal(
      cookie,
      "summonarr-session=tok.abc.def; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400",
    );
  });
});

test("maxAgeSeconds is emitted verbatim (session windows differ by rememberMe/client)", () => {
  withEnv({ AUTH_URL: "https://example.com" }, () => {
    for (const maxAge of [0, 60, 30 * 24 * 60 * 60]) {
      const cookie = serializeSessionCookie("t", { maxAgeSeconds: maxAge });
      assert.ok(cookie.includes(`Max-Age=${maxAge}`));
    }
  });
});

test("HttpOnly and SameSite=Lax are present in both contexts", () => {
  // HttpOnly keeps the JWT out of web JS (guardrail 6b); Lax blocks
  // cross-site subresource/POST cookie attachment.
  for (const authUrl of ["https://example.com", "http://example.com"]) {
    withEnv({ AUTH_URL: authUrl }, () => {
      const cookie = serializeSessionCookie("t", { maxAgeSeconds: 1 });
      assert.ok(cookie.includes("HttpOnly"));
      assert.ok(cookie.includes("SameSite=Lax"));
    });
  }
});

// --- serializeClearedSessionCookies: sign-out clearing set ---

test("cleared set expires BOTH summonarr variants regardless of current context", () => {
  // AUTH_URL can flip between deploys (http → https); sign-out must clear
  // whichever variant the browser actually holds.
  withEnv({ AUTH_URL: "http://localhost:3000" }, () => {
    const cleared = serializeClearedSessionCookies();
    assert.equal(
      cleared[0],
      "__Host-summonarr-session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure",
    );
    assert.equal(
      cleared[1],
      "summonarr-session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
    );
  });
});

test("every cleared cookie has an empty value, Max-Age=0, and Path=/", () => {
  const cleared = serializeClearedSessionCookies();
  for (const cookie of cleared) {
    assert.match(cookie, /^[^=;\s]+=; /); // name=; — value emptied
    assert.ok(cookie.includes("Max-Age=0"));
    assert.ok(cookie.includes("Path=/"));
    assert.ok(!/domain=/i.test(cookie)); // Domain would mismatch __Host-/__Secure- jar entries
  }
});

test("legacy next-auth/authjs cookies are cleared in both Secure and plain forms", () => {
  const cleared = serializeClearedSessionCookies();
  const names = cleared.map((c) => c.slice(0, c.indexOf("=")));
  // Spot-check the migration-critical legacy names.
  for (const legacy of [
    "next-auth.session-token",
    "__Secure-next-auth.session-token",
    "__Host-next-auth.session-token",
    "authjs.session-token",
    "next-auth.csrf-token",
    "authjs.callback-url",
  ]) {
    const variants = cleared.filter((c) => c.startsWith(`${legacy}=;`));
    assert.equal(variants.length, 2, `${legacy} should be cleared twice`);
    assert.equal(variants.filter((c) => c.endsWith("; Secure")).length, 1);
  }
  // 2 summonarr variants + 13 legacy names × 2 (plain + Secure) = 28 total.
  assert.equal(cleared.length, 28);
  // The current-session names are always covered.
  assert.ok(names.includes(SECURE_NAME));
  assert.ok(names.includes(INSECURE_NAME));
});

// --- parseSessionCookie ---

test("parses the current-context cookie out of a multi-cookie header", () => {
  withEnv({ AUTH_URL: "https://example.com" }, () => {
    const header = `theme=dark; ${SECURE_NAME}=eyJhbGciOi.payload.sig; other=1`;
    assert.equal(parseSessionCookie(header), "eyJhbGciOi.payload.sig");
  });
  withEnv({ AUTH_URL: "http://localhost:3000" }, () => {
    const header = `${INSECURE_NAME}=tok.a.b; theme=dark`;
    assert.equal(parseSessionCookie(header), "tok.a.b");
  });
});

test("null or empty header → null", () => {
  withEnv({ AUTH_URL: "https://example.com" }, () => {
    assert.equal(parseSessionCookie(null), null);
    assert.equal(parseSessionCookie(""), null);
  });
});

test("secure context does NOT honor a plain-named cookie (spoof resistance)", () => {
  // A sibling-host attacker can set `summonarr-session` for the parent domain
  // but can never set `__Host-summonarr-session`. In a secure context only
  // the prefixed name may authenticate.
  withEnv({ AUTH_URL: "https://requests.example.com" }, () => {
    assert.equal(parseSessionCookie(`${INSECURE_NAME}=forged.tok.en`), null);
    // And the reverse: insecure context ignores the prefixed name.
  });
  withEnv({ AUTH_URL: "http://localhost:3000" }, () => {
    assert.equal(parseSessionCookie(`${SECURE_NAME}=stale.tok.en`), null);
  });
});

test("name match is exact, not prefix/suffix", () => {
  withEnv({ AUTH_URL: "http://localhost:3000" }, () => {
    assert.equal(parseSessionCookie(`x-${INSECURE_NAME}=evil`), null);
    assert.equal(parseSessionCookie(`${INSECURE_NAME}-x=evil`), null);
    assert.equal(parseSessionCookie(`${SECURE_NAME}=notme; ${INSECURE_NAME}=me`), "me");
  });
});

test("first-match wins when the header repeats the name (browser precedence order)", () => {
  // Browsers send the most-specific/oldest cookie first; the parser takes the
  // first occurrence rather than letting a later duplicate override it.
  withEnv({ AUTH_URL: "http://localhost:3000" }, () => {
    const header = `${INSECURE_NAME}=first.tok.en; ${INSECURE_NAME}=second.tok.en`;
    assert.equal(parseSessionCookie(header), "first.tok.en");
  });
});

test("tolerates missing separator whitespace and skips '='-less pieces", () => {
  withEnv({ AUTH_URL: "http://localhost:3000" }, () => {
    assert.equal(parseSessionCookie(`a=1;${INSECURE_NAME}=tok;b=2`), "tok");
    assert.equal(parseSessionCookie(`garbage; ${INSECURE_NAME}=tok`), "tok");
    assert.equal(parseSessionCookie("garbage-no-equals"), null);
  });
});

test("value is taken after the FIRST '=' so base64url padding-free JWTs round-trip", () => {
  withEnv({ AUTH_URL: "http://localhost:3000" }, () => {
    // JWT segments never contain '=', but the parser must not truncate a
    // value at a later '=' either (defense against odd upstream rewrites).
    assert.equal(parseSessionCookie(`${INSECURE_NAME}=a=b=c`), "a=b=c");
    // Empty value parses to the empty string, not null — the cookie exists.
    assert.equal(parseSessionCookie(`${INSECURE_NAME}=`), "");
  });
});

test("serialize → parse roundtrip in both contexts", () => {
  const token = "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InUxIn0.c2ln";
  for (const authUrl of ["https://example.com", "http://localhost:3000"]) {
    withEnv({ AUTH_URL: authUrl }, () => {
      const setCookie = serializeSessionCookie(token, { maxAgeSeconds: 3600 });
      // A browser echoes back just the name=value pair.
      const pair = setCookie.split("; ")[0];
      assert.equal(parseSessionCookie(pair), token);
    });
  }
});
