import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { testOmdbConnection } from "@/lib/omdb";
import { testMdblistConnection } from "@/lib/mdblist";
import { testTraktConnection } from "@/lib/trakt";
import { testIpinfoConnection } from "@/lib/ip-lookup";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin connectivity test for the ratings/lookup providers: dispatches on the
// requested service to the matching test helper (OMDB, MDBList, Trakt, ipinfo).
export const POST = withAdmin(async (req, _ctx, _session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<{ service?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  if (body.service === "omdb") {
    try {
      const title = await testOmdbConnection();
      return NextResponse.json({ ok: true, message: t("apiAdmin.settings.connectedFetched", { title: String(title) }) });
    } catch (err) {
      console.error("[test-ratings] OMDB test failed:", err);
      return NextResponse.json({ ok: false, error: t("apiAdmin.settings.omdbTestFailed") }, { status: 422 });
    }
  }

  if (body.service === "mdblist") {
    try {
      const title = await testMdblistConnection();
      return NextResponse.json({ ok: true, message: t("apiAdmin.settings.connectedFetched", { title: String(title) }) });
    } catch (err) {
      console.error("[test-ratings] MDBList test failed:", err);
      return NextResponse.json({ ok: false, error: t("apiAdmin.settings.mdblistTestFailed") }, { status: 422 });
    }
  }

  if (body.service === "trakt") {
    try {
      const title = await testTraktConnection();
      return NextResponse.json({ ok: true, message: t("apiAdmin.settings.connectedFetched", { title: String(title) }) });
    } catch (err) {
      console.error("[test-ratings] Trakt test failed:", err);
      return NextResponse.json({ ok: false, error: t("apiAdmin.settings.traktTestFailed") }, { status: 422 });
    }
  }

  if (body.service === "ipinfo") {
    try {
      const detail = await testIpinfoConnection();
      return NextResponse.json({ ok: true, message: t("apiAdmin.settings.connected", { detail: String(detail) }) });
    } catch (err) {
      console.error("[test-ratings] ipinfo test failed:", err);
      return NextResponse.json({ ok: false, error: t("apiAdmin.settings.ipinfoTestFailed") }, { status: 422 });
    }
  }

  return NextResponse.json({ error: t("apiAdmin.settings.ratingsServiceInvalid") }, { status: 400 });
});
