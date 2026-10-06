import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { testOmdbConnection } from "@/lib/omdb";
import { testMdblistConnection } from "@/lib/mdblist";
import { testTraktConnection } from "@/lib/trakt";
import { testIpinfoConnection } from "@/lib/ip-lookup";
import { checkRateLimit } from "@/lib/rate-limit";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin connectivity test for the ratings/lookup providers: dispatches on the
// requested service to the matching test helper (OMDB, MDBList, Trakt, ipinfo).
export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  // Same 10/min per-admin budget as the settings PATCH and the notification-agent
  // test route. Every call here is a LIVE upstream request, and OMDB's free tier
  // is 1k/day: a stuck Test retry would burn it and trip the quota lockout that
  // hides OMDB ratings for every user until the window rolls.
  if (!checkRateLimit(`admin-test-ratings:${session.user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: t("apiAdmin.common.tooManyRequestsLater") }, { status: 429 });
  }
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
