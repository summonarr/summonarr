import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { hasPermission, Permission } from "@/lib/permissions";
import { getPlexConfig } from "@/lib/plex-config";
import { safeFetchAdminConfigured, safeFetchTrusted } from "@/lib/safe-fetch";

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
  // DB-checked auth — see /api/events for why inline JWT-only auth() is
  // insufficient on the prefetch-header path. role:"ISSUE_ADMIN" admits ADMIN
  // too. requireAuth returns 401 (no/expired/revoked session) or 403 (wrong role).
  //
  // Intentionally does NOT thread a sliding-refresh Set-Cookie. requireAuth
  // (api-auth.ts) discards the refreshed JWT; re-issuing it here would mean
  // re-implementing the verify/fingerprint/role boilerplate inline (guardrail 6a
  // forbids) or widening the shared api-auth signature (out of scope). Impact is
  // nil — this binary image proxy carries no Set-Cookie, and the next normal
  // withAuth request re-runs the sliding refresh, so the window is never lost.
  const gate = await requireAuth({ role: "ISSUE_ADMIN" });
  if (gate instanceof NextResponse) return gate;
  // Authoritative on the MANAGE_ISSUES bit (same gate as the sibling fix-match
  // routes' withIssueAdmin), so clearing the bit revokes thumbnail access too.
  if (!hasPermission(gate.user.permissions, Permission.MANAGE_ISSUES)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const thumbPath = new URL(request.url).searchParams.get("path");
  if (!thumbPath) return new NextResponse("Missing path", { status: 400 });

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
    // Plex-relative path — join with the configured Plex server URL.
    const plexConfig = await getPlexConfig();
    if (!plexConfig.url || !plexConfig.token) return new NextResponse("Plex not configured", { status: 500 });

    const serverUrl = plexConfig.url.replace(/\/$/, "");
    const url = new URL(`${serverUrl}${thumbPath}`);

    const expectedHostname = new URL(serverUrl).hostname;
    if (url.hostname !== expectedHostname) {
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
