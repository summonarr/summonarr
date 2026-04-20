import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { testOmdbConnection } from "@/lib/omdb";
import { testMdblistConnection } from "@/lib/mdblist";
import { testTraktConnection } from "@/lib/trakt";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { service?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.service === "omdb") {
    try {
      const title = await testOmdbConnection();
      return NextResponse.json({ ok: true, message: `Connected — fetched "${title}"` });
    } catch (err) {
      console.error("[test-ratings] OMDB test failed:", err);
      return NextResponse.json({ ok: false, error: "OMDB test failed" }, { status: 422 });
    }
  }

  if (body.service === "mdblist") {
    try {
      const title = await testMdblistConnection();
      return NextResponse.json({ ok: true, message: `Connected — fetched "${title}"` });
    } catch (err) {
      console.error("[test-ratings] MDBList test failed:", err);
      return NextResponse.json({ ok: false, error: "MDBList test failed" }, { status: 422 });
    }
  }

  if (body.service === "trakt") {
    try {
      const title = await testTraktConnection();
      return NextResponse.json({ ok: true, message: `Connected — fetched "${title}"` });
    } catch (err) {
      console.error("[test-ratings] Trakt test failed:", err);
      return NextResponse.json({ ok: false, error: "Trakt test failed" }, { status: 422 });
    }
  }

  return NextResponse.json({ error: "service must be 'omdb', 'mdblist', or 'trakt'" }, { status: 400 });
}
