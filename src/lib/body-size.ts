import { NextRequest, NextResponse } from "next/server";

// Picks the right unit so a 16 KB cap doesn't render as "max 0MB": MB for
// >=1 MiB, KB otherwise. Integer + unit suffix — 413 messages stay terse.
function formatByteCap(maxBytes: number): string {
  const ONE_MB = 1024 * 1024;
  if (maxBytes >= ONE_MB) {
    return `${Math.round(maxBytes / ONE_MB)}MB`;
  }
  return `${Math.max(1, Math.round(maxBytes / 1024))}KB`;
}

// Header-only fast path. Rejects pre-read when the client honestly declared
// Content-Length. Returns null for missing/non-numeric headers (e.g.
// Transfer-Encoding: chunked) — callers MUST follow up with
// assertBodyBytesUnderCap() after reading the body to catch chunked-encoding
// bypasses. The post-read check is cheap (one length comparison) so even
// trusted callers should run both.
export function checkBodySize(
  req: NextRequest,
  maxBytes: number,
): NextResponse | null {
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (!isNaN(size) && size > maxBytes) {
      return NextResponse.json(
        { error: `Request body too large (max ${formatByteCap(maxBytes)})` },
        { status: 413 },
      );
    }
  }
  return null;
}

// Post-read companion to checkBodySize. Returns a 413 NextResponse when the
// buffer is larger than maxBytes; null otherwise. Caller pattern:
//
//   const headerCheck = checkBodySize(req, MAX);
//   if (headerCheck) return headerCheck;
//   const bytes = new Uint8Array(await req.arrayBuffer());
//   const bodyCheck = assertBodyBytesUnderCap(bytes, MAX);
//   if (bodyCheck) return bodyCheck;
//
// Necessary because Content-Length is absent on Transfer-Encoding: chunked
// requests, which would otherwise bypass checkBodySize entirely.
export function assertBodyBytesUnderCap(
  bytes: { byteLength: number },
  maxBytes: number,
): NextResponse | null {
  if (bytes.byteLength > maxBytes) {
    return NextResponse.json(
      { error: `Request body too large (max ${formatByteCap(maxBytes)})` },
      { status: 413 },
    );
  }
  return null;
}

// One-shot capped JSON read: Content-Length fast-reject + post-read byte
// assertion (catches chunked-encoding bypasses) + JSON.parse. Returns the parsed
// value, or a NextResponse to return verbatim (413 over cap, 400 on malformed
// JSON; discriminate on `instanceof NextResponse`). Use on every non-upload JSON
// route — proxyClientMaxBodySize (50 MB) is only a backstop. Pick a cap fitting
// the largest legitimate payload (single objects ~64 KB, bulk arrays more).
export async function readJsonCapped<T = unknown>(
  req: NextRequest,
  maxBytes: number,
): Promise<T | NextResponse> {
  const headerCheck = checkBodySize(req, maxBytes);
  if (headerCheck) return headerCheck;
  const raw = new Uint8Array(await req.arrayBuffer());
  const sizeCheck = assertBodyBytesUnderCap(raw, maxBytes);
  if (sizeCheck) return sizeCheck;
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as T;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
}

// Tolerant variant for routes where a missing/empty/malformed body is VALID
// (all fields optional). Still enforces the size cap (413 over cap), but on an
// empty/unparseable body returns `fallback` instead of 400 — preserving the
// "no body = defaults" contract. Discriminate the 413 on `instanceof NextResponse`.
export async function readJsonCappedOr<T>(
  req: NextRequest,
  maxBytes: number,
  fallback: T,
): Promise<T | NextResponse> {
  const headerCheck = checkBodySize(req, maxBytes);
  if (headerCheck) return headerCheck;
  const raw = new Uint8Array(await req.arrayBuffer());
  const sizeCheck = assertBodyBytesUnderCap(raw, maxBytes);
  if (sizeCheck) return sizeCheck;
  if (raw.byteLength === 0) return fallback;
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as T;
  } catch {
    return fallback;
  }
}
