import { NextRequest, NextResponse } from "next/server";
import { initiateJellyfinQuickConnect, pollJellyfinQuickConnect } from "@/lib/jellyfin";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

const JELLYFIN_URL = process.env.JELLYFIN_URL;

// In-memory per-secret poll limiter; caps attempts per QuickConnect session without a DB round-trip
interface PollEntry { count: number; expiresAt: number; }
const pollCounts = new Map<string, PollEntry>();
const MAX_POLLS = 60;
const QC_TTL = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, e] of pollCounts) if (e.expiresAt < now) pollCounts.delete(k);
}, 60_000).unref();

export async function POST(req: NextRequest) {
  if (!JELLYFIN_URL) {
    return NextResponse.json({ error: "Jellyfin not configured" }, { status: 503 });
  }

  if (!checkRateLimit(`qc-initiate:${getClientIp(req.headers)}`, 10, 60_000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }
  try {
    const result = await initiateJellyfinQuickConnect(JELLYFIN_URL);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[jellyfin quickconnect] initiate error:", err);
    return NextResponse.json({ error: "Failed to initiate QuickConnect" }, { status: 502 });
  }
}

export async function GET(req: NextRequest) {
  if (!JELLYFIN_URL) {
    return NextResponse.json({ error: "Jellyfin not configured" }, { status: 503 });
  }
  const { searchParams } = new URL(req.url);
  const secret = searchParams.get("secret");
  if (!secret) {
    return NextResponse.json({ error: "Missing secret" }, { status: 400 });
  }

  if (!checkRateLimit(`qc-poll:${getClientIp(req.headers)}`, 60, 60_000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }

  if (!checkRateLimit(`qc-poll-secret:${secret.slice(0, 32)}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }

  const countKey = secret.slice(0, 32);
  const existing = pollCounts.get(countKey);
  const now = Date.now();
  if (existing && existing.expiresAt < now) pollCounts.delete(existing as unknown as string);
  const attempts = (existing && existing.expiresAt >= now ? existing.count : 0) + 1;
  if (attempts > MAX_POLLS) {
    pollCounts.delete(countKey);
    return NextResponse.json({ error: "QuickConnect session expired" }, { status: 410 });
  }
  pollCounts.set(countKey, { count: attempts, expiresAt: existing?.expiresAt ?? now + QC_TTL });
  try {
    const authenticated = await pollJellyfinQuickConnect(JELLYFIN_URL, secret);
    if (authenticated) {
      pollCounts.delete(countKey);
    }
    return NextResponse.json({ authenticated });
  } catch (err) {
    console.error("[jellyfin quickconnect] poll error:", err);
    return NextResponse.json({ error: "Failed to poll QuickConnect" }, { status: 502 });
  }
}
