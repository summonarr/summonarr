import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { testOmdbConnection } from "@/lib/omdb";
import { testMdblistConnection } from "@/lib/mdblist";
import { testTraktConnection } from "@/lib/trakt";
import { testIpinfoConnection } from "@/lib/ip-lookup";

export const POST = withAdmin(async (req, _ctx, _session) => {
  const parsed = await readJsonCapped<{ service?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

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

  if (body.service === "ipinfo") {
    try {
      const detail = await testIpinfoConnection();
      return NextResponse.json({ ok: true, message: `Connected — ${detail}` });
    } catch (err) {
      console.error("[test-ratings] ipinfo test failed:", err);
      return NextResponse.json({ ok: false, error: "ipinfo test failed" }, { status: 422 });
    }
  }

  return NextResponse.json({ error: "service must be 'omdb', 'mdblist', 'trakt', or 'ipinfo'" }, { status: 400 });
});
