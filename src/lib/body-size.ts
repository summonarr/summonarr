import { NextRequest, NextResponse } from "next/server";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Picks the right unit so a 16 KB cap doesn't render as "max 0MB": MB for
// >=1 MiB, KB otherwise. Integer + unit suffix — 413 messages stay terse.
function formatByteCap(maxBytes: number): string {
  const ONE_MB = 1024 * 1024;
  if (maxBytes >= ONE_MB) {
    return `${Math.round(maxBytes / ONE_MB)}MB`;
  }
  return `${Math.max(1, Math.round(maxBytes / 1024))}KB`;
}

// Every consuming route localizes its own errors through translatorForRequest,
// so these shared rejections must too — a French viewer otherwise saw an English
// "Invalid request body" between French validation errors on the same route.
// `req` is optional on the post-read helper for callers that hold only the
// bytes; without it the instance default language is used.
function tooLarge(maxBytes: number, req?: NextRequest): NextResponse {
  const t = translatorForRequest(req ?? new Request("http://localhost/"));
  return NextResponse.json(
    { error: t("apiAdmin.common.bodyTooLarge", { max: formatByteCap(maxBytes) }) },
    { status: 413 },
  );
}

// The same 413 the readers answer, for a route that reads its own bytes with
// readBodyBytesCapped and got null back.
export function bodyTooLarge(maxBytes: number, req?: NextRequest): NextResponse {
  return tooLarge(maxBytes, req);
}

function invalidBody(req: NextRequest): NextResponse {
  const t = translatorForRequest(req);
  return NextResponse.json({ error: t("apiAdmin.common.invalidBody") }, { status: 400 });
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
      return tooLarge(maxBytes, req);
    }
  }
  return null;
}

// Reads the body, giving up as soon as it passes maxBytes: the reader is
// cancelled and null returned, so a chunked body (no Content-Length for
// checkBodySize to refuse) is never buffered past the cap. req.arrayBuffer()
// would read all of it first and only then let the caller measure it. Returns
// the bytes (empty for a body-less request) when it fits.
export async function readBodyBytesCapped(
  req: Request,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
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
  req?: NextRequest,
): NextResponse | null {
  if (bytes.byteLength > maxBytes) {
    return tooLarge(maxBytes, req);
  }
  return null;
}

// One-shot capped JSON read: Content-Length fast-reject + a read that stops at the
// cap (catches chunked-encoding bypasses) + JSON.parse. Returns the parsed object,
// or a NextResponse to return verbatim (413 over cap, 400 on malformed JSON or a
// body that is not an object; discriminate on `instanceof NextResponse`). Use on
// every non-upload JSON route — proxyClientMaxBodySize (next.config.ts) is only a
// backstop. Pick a cap fitting the largest legitimate payload (single objects
// ~64 KB, bulk arrays more).
export async function readJsonCapped<T = unknown>(
  req: NextRequest,
  maxBytes: number,
): Promise<T | NextResponse> {
  const headerCheck = checkBodySize(req, maxBytes);
  if (headerCheck) return headerCheck;
  const raw = await readBodyBytesCapped(req, maxBytes);
  if (raw === null) return tooLarge(maxBytes, req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return invalidBody(req);
  }
  // A body of `null` (or a bare number/string/boolean) is VALID JSON, so it parsed
  // cleanly and used to be handed back as if it were the expected object. Every
  // caller then reads a property off it — and on `null` that is a TypeError, i.e. an
  // unauthenticated 500 from a one-word request body. Every consumer types this as an
  // object, so anything else is a malformed request, not a body. That includes a
  // top-level array: `typeof [] === "object"`, and a handler reading `body.ids` off
  // one gets undefined — its defaults — with no validation error.
  if (!isJsonObject(parsed)) {
    return invalidBody(req);
  }
  return parsed as T;
}

function isJsonObject(parsed: unknown): boolean {
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
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
  const raw = await readBodyBytesCapped(req, maxBytes);
  if (raw === null) return tooLarge(maxBytes, req);
  if (raw.byteLength === 0) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return fallback;
  }
  // Same non-object guard as readJsonCapped, resolved the tolerant way: this variant's
  // contract is "a body I cannot use means defaults", and `null` (or an array) is
  // exactly that.
  if (!isJsonObject(parsed)) return fallback;
  return parsed as T;
}

// For routes where the body is OPTIONAL but, when sent, must be meant: an empty
// (or whitespace-only) body is `fallback`, and anything else must be a JSON object
// — malformed JSON, an array or a primitive is the same 400 readJsonCapped gives.
// readJsonCappedOr turns those into the defaults, which is wrong where the defaults
// are a broader action than the caller asked for (mark EVERY notification read,
// mint for the oldest admin instead of the userId that failed to parse).
export async function readOptionalJsonCapped<T>(
  req: NextRequest,
  maxBytes: number,
  fallback: T,
): Promise<T | NextResponse> {
  const headerCheck = checkBodySize(req, maxBytes);
  if (headerCheck) return headerCheck;
  const raw = await readBodyBytesCapped(req, maxBytes);
  if (raw === null) return tooLarge(maxBytes, req);
  const text = new TextDecoder().decode(raw);
  if (text.trim() === "") return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalidBody(req);
  }
  if (!isJsonObject(parsed)) return invalidBody(req);
  return parsed as T;
}
