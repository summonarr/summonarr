import { NextRequest, NextResponse } from "next/server";
import { getSyncableMediaInstances } from "@/lib/media-instance-registry";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

// The Jellyfin sign-in server picker, for clients that can't render one from a
// server component.
//
// Multi-server support means a user's Jellyfin account may live on a NAMED
// instance rather than the default one, so sign-in has to be told which server
// to authenticate against. The web login page builds that picker by calling
// getSyncableMediaInstances("jellyfin") directly in a server component
// (src/app/login/page.tsx) — a native client has no such path, so without this
// endpoint a user whose account lives on a named server simply cannot sign in
// from the app.
//
// PUBLIC by design: it is consumed BEFORE sign-in, when the caller has no
// session by definition. Pre-auth via the `/api/auth/` prefix in isPublicPath
// (src/proxy.ts), and covered by the blanket `auth/` allowlist entry in
// scripts/audit-routes.mts.
//
// RATE-LIMITED, unlike /api/config/compat: that route is a pure constant
// projection with no DB access, so it can't be used as a load amplifier. This
// one reads the registry Setting plus each instance's connection rows, so an
// unauthenticated caller could otherwise turn it into one. The budget matches
// /api/auth/setup-status deliberately — the same pre-login screen probes both,
// so a tighter cap here would just fail first while its sibling still answered.
//
// Only CONFIGURED instances are listed: getSyncableMediaInstances requires both
// the server URL and the API key to be present, which is precisely the same
// gate the web login page applies. Offering a registered-but-unconfigured
// server would put an entry in the picker that can only ever fail to
// authenticate. Jellyfin not configured at all ⇒ an empty list with 200, not a
// 404 — "no Jellyfin sign-in available" is a normal answer, not an error.
//
// The projection to { slug, name } is deliberate and must stay exhaustive: this
// is an unauthenticated surface, so it may carry only what the picker needs to
// label an option and echo the choice back at sign-in. No server URLs, no API
// keys, no library/user counts, and not the registry's `restricted` flag (a
// per-user library-visibility concern that says nothing about sign-in).
export async function GET(req: NextRequest) {
  if (!checkRateLimit(`jellyfin-servers:${getClientIp(req.headers)}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  // Default ("") first when configured — getMediaInstances synthesizes it ahead
  // of the registry entries and the configured-filter preserves that order, so
  // a client defaulting to servers[0] lands on the default server.
  const instances = await getSyncableMediaInstances("jellyfin");
  return NextResponse.json({
    servers: instances.map((i) => ({ slug: i.slug, name: i.name })),
  });
}
