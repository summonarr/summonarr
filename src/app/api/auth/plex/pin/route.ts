import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import { PLEX_CLIENT_ID } from "@/lib/plex";

const PLEX_PIN_HEADERS = {
  "X-Plex-Client-Identifier": PLEX_CLIENT_ID,
  "X-Plex-Product": "Summonarr",
  "X-Plex-Version": "1.0",
  "X-Plex-Model": "hosted",
  "X-Plex-Device": "Web",
  "X-Plex-Device-Name": "Summonarr",
  "X-Plex-Platform": "Web",
  Accept: "application/json",
};

export const POST = withAdmin(async (_req, _ctx, _session) => {
  const res = await safeFetchTrusted("https://plex.tv/api/v2/pins", {
    allowedHosts: ["plex.tv"],
    method: "POST",
    headers: {
      ...PLEX_PIN_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "strong=true",
    timeoutMs: 15_000,
  });

  if (!res.ok) {
    return NextResponse.json({ error: "plex pin create failed" }, { status: 502 });
  }

  const data = (await res.json()) as { id?: number; code?: string };
  if (typeof data.id !== "number" || typeof data.code !== "string") {
    return NextResponse.json({ error: "plex pin response malformed" }, { status: 502 });
  }
  return NextResponse.json({ id: data.id, code: data.code });
});

export const GET = withAdmin(async (req, _ctx, _session) => {
  const idRaw = req.nextUrl.searchParams.get("id");
  const id = idRaw ? Number(idRaw) : NaN;
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const res = await safeFetchTrusted(`https://plex.tv/api/v2/pins/${id}`, {
    allowedHosts: ["plex.tv"],
    headers: PLEX_PIN_HEADERS,
    timeoutMs: 15_000,
  });

  if (!res.ok) {
    return NextResponse.json({ error: "plex pin poll failed" }, { status: 502 });
  }

  // Returning a Plex authToken on GET is normally avoided (caching/logging risk),
  // but it's required and safe here. The PIN-claim handshake (client page
  // src/app/auth/plex/done/page.tsx) polls this GET until the token materializes,
  // then posts it back to link the account. Plex enforces the ordering: every poll
  // returns `authToken: null` until the user claims the PIN, so intermediate polls
  // leak nothing. Cache-Control: no-store keeps the real token out of any cache
  // once it IS returned.
  const data = (await res.json()) as { authToken?: string | null };
  return NextResponse.json(
    { authToken: data.authToken ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
});
