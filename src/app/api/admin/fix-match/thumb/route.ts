import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveToSafeUrl } from "@/lib/ssrf";
import { safeFetch, safeFetchAdminConfigured } from "@/lib/safe-fetch";

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

  let fetchUrl: string;
  let plexTokenHeader: Record<string, string> = {};

  let trusted = false;

  if (/^https?:\/\//i.test(thumbPath)) {
    const parsed = new URL(thumbPath);
    const inner  = parsed.searchParams.get("url");

    const safe = await resolveToSafeUrl(inner ?? thumbPath);
    if (!safe) return new NextResponse("URL not allowed", { status: 400 });
    fetchUrl = safe;
  } else {
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
    fetchUrl = url.toString();

    plexTokenHeader = { "X-Plex-Token": tokenRow.value };
    trusted = true;
  }

  const MAX_THUMB_BYTES = 5 * 1024 * 1024;
  const fetcher = trusted ? safeFetchAdminConfigured : safeFetch;
  const res = await fetcher(fetchUrl, {
    timeoutMs: 10_000,
    maxResponseBytes: MAX_THUMB_BYTES,
    headers: { "User-Agent": "Summonarr/1.0 (Node.js)", ...plexTokenHeader },
  }).catch(() => null);

  if (!res?.ok) return new NextResponse("Thumb fetch failed", { status: 502 });

  const contentType = res.headers.get("content-type") ?? "";

  const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
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
