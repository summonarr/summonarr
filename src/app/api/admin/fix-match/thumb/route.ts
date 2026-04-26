import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeFetchAdminConfigured, safeFetchTrusted } from "@/lib/safe-fetch";

// Hosts that Plex's metadata agents return for candidate thumbnails. The external-URL
// branch below routes through safeFetchTrusted with this allowlist so an admin can't
// turn fix-match into an open image proxy (CodeQL js/request-forgery, alert #4).
// Add entries here if Plex starts returning thumbs from a new agent CDN.
const PLEX_AGENT_THUMB_HOSTS = [
  "image.tmdb.org",
  "metadata-static.plex.tv",
  "artworks.thetvdb.com",
  "assets.fanart.tv",
];

const MAX_THUMB_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || isTokenExpired(session) || (session.user.role !== "ADMIN" && session.user.role !== "ISSUE_ADMIN")) {
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
    const [urlRow, tokenRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: "plexServerUrl" } }),
      prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
    ]);
    if (!urlRow?.value || !tokenRow?.value) return new NextResponse("Plex not configured", { status: 500 });

    const serverUrl = urlRow.value.replace(/\/$/, "");
    const url = new URL(`${serverUrl}${thumbPath}`);

    const expectedHostname = new URL(serverUrl).hostname;
    if (url.hostname !== expectedHostname) {
      return new NextResponse("Invalid path", { status: 400 });
    }

    res = await safeFetchAdminConfigured(url.toString(), {
      timeoutMs: 10_000,
      maxResponseBytes: MAX_THUMB_BYTES,
      headers: { "User-Agent": "Summonarr/1.0 (Node.js)", "X-Plex-Token": tokenRow.value },
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
      "Cache-Control": "public, max-age=3600",
    },
  });
}
