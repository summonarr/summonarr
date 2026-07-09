import { NextResponse } from "next/server";

// 429 Too Many Requests with a Retry-After header, so well-behaved clients back
// off for the given window instead of hammering. `retryAfterSeconds` should
// reflect the limiter's window — it's a conservative hint (the sliding window
// may free up sooner). Centralized so routes emit a consistent, spec-compliant
// 429 rather than a bare JSON body.
export function tooManyRequests(
  retryAfterSeconds = 60,
  message = "Too many requests — try again later.",
): NextResponse {
  return NextResponse.json(
    { error: message },
    { status: 429, headers: { "Retry-After": String(Math.max(1, Math.floor(retryAfterSeconds))) } },
  );
}
