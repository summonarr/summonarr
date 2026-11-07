import { NextResponse } from "next/server";

// The 409 an admin route answers when the advisory lock it needs is held by
// another run (the nightly cron, or another admin's click). `message` is the
// route's own translated "already running" text. The body and the Retry-After
// header are a shared contract: the admin buttons read `retryAfter`/`error`.
export function lockBusyResponse(message: string) {
  return NextResponse.json(
    { ok: false, error: message, retryAfter: 30 },
    { status: 409, headers: { "Retry-After": "30" } },
  );
}
