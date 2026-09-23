import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { hasPermission, Permission } from "@/lib/permissions";
import { getPlexConfig } from "@/lib/plex-config";
import { safeFetchAdminConfigured, safeFetchTrusted } from "@/lib/safe-fetch";
import { DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug } from "@/lib/media-instances";

// Hosts Plex's metadata agents return for candidate thumbnails. The external-URL
// branch routes through safeFetchTrusted with this allowlist so the admin-controlled
// `path` param can't turn this into an SSRF proxy fetching arbitrary URLs. The
// allowlist is the trust boundary — add entries if Plex returns thumbs from a new CDN.
const PLEX_AGENT_THUMB_HOSTS = [
  "image.tmdb.org",
  "metadata-static.plex.tv",
  "artworks.thetvdb.com",
  "assets.fanart.tv",
];

const MAX_THUMB_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];

export async function GET(request: NextRequest) {
  // This route returns an image, not JSON, so it calls requireAuth directly
  // instead of a withAuth wrapper (guardrail 6a). requireAuth is DB-checked
  // (revoked sessions are refused), unlike the JWT-only auth(). It returns 401
  // when there is no valid session.
  //
  // It does NOT send back a refreshed session cookie: requireAuth drops the
  // re-signed token. That is harmless — the next normal API call refreshes it.
  //
  // requireAuth only checks "signed in". The MANAGE_ISSUES permission check
  // below is the real access rule. Requiring the ISSUE_ADMIN role instead would
  // wrongly block a plain USER who was granted that permission, while the other
  // fix-match routes (withIssueAdmin) let them in.
  const gate = await requireAuth();
  if (gate instanceof NextResponse) return gate;
  // Authoritative on the MANAGE_ISSUES bit (same gate as the sibling fix-match
  // routes' withIssueAdmin), so clearing the bit revokes thumbnail access too.
  if (!hasPermission(gate.user.permissions, Permission.MANAGE_ISSUES)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const thumbPath = searchParams.get("path");
  if (!thumbPath) return new NextResponse("Missing path", { status: 400 });

  // Which configured Plex server a RELATIVE thumb path belongs to (a Plex thumb
  // path is server-local, like the ratingKey it hangs off). Validated here rather
  // than inside the relative branch so an invalid slug is rejected uniformly.
  // Absent ⇒ the default server, matching every pre-multi-server caller.
  const serverInstanceParam = searchParams.get("serverInstance");
  if (serverInstanceParam !== null && !isValidMediaInstanceSlug(serverInstanceParam)) {
    return new NextResponse("Invalid serverInstance", { status: 400 });
  }
  const serverInstance = serverInstanceParam ?? DEFAULT_MEDIA_INSTANCE;

  if (/[@\\]/.test(thumbPath) && !/^https?:\/\//i.test(thumbPath)) {
    return new NextResponse("Invalid path", { status: 400 });
  }

  let res: Response | null;

  if (/^https?:\/\//i.test(thumbPath)) {
    // External thumbnail URL returned by a Plex metadata agent. Some agents wrap
    // the real CDN URL in a `?url=` parameter — unwrap it before the host check.
    let parsed: URL;
    try {
      parsed = new URL(thumbPath);
    } catch {
      return new NextResponse("Invalid path", { status: 400 });
    }
    let fetchUrl = thumbPath;
    const inner = parsed.searchParams.get("url");
    if (inner) {
      try {
        new URL(inner);
        fetchUrl = inner;
      } catch {
        return new NextResponse("Invalid path", { status: 400 });
      }
    }

    res = await safeFetchTrusted(fetchUrl, {
      allowedHosts: PLEX_AGENT_THUMB_HOSTS,
      timeoutMs: 10_000,
      maxResponseBytes: MAX_THUMB_BYTES,
      headers: { "User-Agent": "Summonarr/1.0 (Node.js)" },
    }).catch(() => null);
  } else {
    // Plex-relative path — join with the configured Plex server URL. Require a
    // genuine absolute path and pin the FULL ORIGIN (scheme+host+port), not just
    // the hostname: a leading `:9999/…` concatenated onto a port-less serverUrl
    // (e.g. "http://plex.local") re-parses to "http://plex.local:9999/…" — same
    // hostname, attacker-chosen port — so the old hostname-only check let a
    // MANAGE_ISSUES caller redirect the X-Plex-Token'd fetch to any TCP port on
    // the Plex host (SSRF / internal port scan). The `//` reject stops a
    // protocol-relative authority from smuggling a different host past the join.
    if (!thumbPath.startsWith("/") || thumbPath.startsWith("//")) {
      return new NextResponse("Invalid path", { status: 400 });
    }
    const plexConfig = await getPlexConfig(serverInstance);
    if (!plexConfig.url || !plexConfig.token) return new NextResponse("Plex not configured", { status: 500 });

    const serverUrl = plexConfig.url.replace(/\/$/, "");
    let url: URL;
    let expectedOrigin: string;
    try {
      url = new URL(`${serverUrl}${thumbPath}`);
      expectedOrigin = new URL(serverUrl).origin;
    } catch {
      return new NextResponse("Invalid path", { status: 400 });
    }
    if (url.origin !== expectedOrigin) {
      return new NextResponse("Invalid path", { status: 400 });
    }

    res = await safeFetchAdminConfigured(url.toString(), {
      timeoutMs: 10_000,
      maxResponseBytes: MAX_THUMB_BYTES,
      headers: { "User-Agent": "Summonarr/1.0 (Node.js)", "X-Plex-Token": plexConfig.token },
    }).catch(() => null);
  }

  if (!res?.ok) return new NextResponse("Thumb fetch failed", { status: 502 });

  const contentType = res.headers.get("content-type") ?? "";

  if (!ALLOWED_IMAGE_TYPES.some((t) => contentType.startsWith(t))) {
    return new NextResponse("Response is not an image", { status: 502 });
  }

  const body = await res.arrayBuffer();
  return new NextResponse(body, {
    headers: {
      "Content-Type": contentType,
      // private (not public): this is an authenticated image proxy, so a shared
      // proxy/CDN must not cache the thumbnail across users/sessions.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
