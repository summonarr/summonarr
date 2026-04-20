import { NextRequest, NextResponse } from "next/server";

export function checkBodySize(
  req: NextRequest,
  maxBytes: number,
): NextResponse | null {
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (!isNaN(size) && size > maxBytes) {
      return NextResponse.json(
        { error: `Request body too large (max ${Math.round(maxBytes / (1024 * 1024))}MB)` },
        { status: 413 },
      );
    }
  }
  return null;
}
