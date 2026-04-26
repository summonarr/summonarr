import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
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

export async function POST() {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

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
}

export async function GET(req: NextRequest) {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

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

  const data = (await res.json()) as { authToken?: string | null };
  return NextResponse.json({ authToken: data.authToken ?? null });
}
