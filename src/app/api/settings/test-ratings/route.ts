import { NextResponse, type NextRequest } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { testOmdbConnection } from "@/lib/omdb";
import { getMdblistUsageSnapshot, testMdblistConnection } from "@/lib/mdblist";
import { testTraktConnection } from "@/lib/trakt";
import { testIpinfoConnection } from "@/lib/ip-lookup";
import { checkRateLimit } from "@/lib/rate-limit";
import { localeForRequest, translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";

type RatingsService = "omdb" | "mdblist" | "trakt" | "ipinfo";

// Each provider's live test: its log label, the success message built from what
// the test fetched, and the 422's message key when it fails.
const SERVICE_TESTS: Record<RatingsService, { label: string; failKey: string; run: (t: Translator, req: NextRequest) => Promise<string> }> = {
  omdb: {
    label: "OMDB",
    failKey: "apiAdmin.settings.omdbTestFailed",
    run: async (t) => t("apiAdmin.settings.connectedFetched", { title: String(await testOmdbConnection()) }),
  },
  mdblist: { label: "MDBList", failKey: "apiAdmin.settings.mdblistTestFailed", run: mdblistMessage },
  trakt: {
    label: "Trakt",
    failKey: "apiAdmin.settings.traktTestFailed",
    run: async (t) => t("apiAdmin.settings.connectedFetched", { title: String(await testTraktConnection()) }),
  },
  ipinfo: {
    label: "ipinfo",
    failKey: "apiAdmin.settings.ipinfoTestFailed",
    run: async (t) => t("apiAdmin.settings.connected", { detail: String(await testIpinfoConnection()) }),
  },
};

// The test's own reply carried MDBList's usage report, so the plan and today's
// count are known now (when MDBList sent them) and the message names them.
async function mdblistMessage(t: Translator, req: NextRequest): Promise<string> {
  const title = String(await testMdblistConnection());
  const usage = await getMdblistUsageSnapshot();
  if (usage.reportedLimit === null || usage.usedToday === null) {
    return t("apiAdmin.settings.connectedFetched", { title });
  }
  const number = new Intl.NumberFormat(localeForRequest(req));
  const vars = { title, limit: number.format(usage.reportedLimit), used: number.format(usage.usedToday) };
  return usage.reportedPlan
    ? t("apiAdmin.settings.mdblistConnectedPlan", { ...vars, plan: t(`settings.form.mdblistPlan.name.${usage.reportedPlan}`) })
    : t("apiAdmin.settings.mdblistConnectedLimit", vars);
}

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

  const service = typeof body.service === "string" && Object.hasOwn(SERVICE_TESTS, body.service)
    ? SERVICE_TESTS[body.service as RatingsService]
    : null;
  if (service) {
    try {
      return NextResponse.json({ ok: true, message: await service.run(t, req) });
    } catch (err) {
      console.error(`[test-ratings] ${service.label} test failed:`, err instanceof Error ? err.message : err);
      return NextResponse.json({ ok: false, error: t(service.failKey) }, { status: 422 });
    }
  }

  return NextResponse.json({ error: t("apiAdmin.settings.ratingsServiceInvalid") }, { status: 400 });
});
