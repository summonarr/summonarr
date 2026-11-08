import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { attachAllAvailability } from "@/lib/attach-all";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { loadUpcomingTitles } from "@/lib/upcoming-list";
import { checkRateLimit } from "@/lib/rate-limit";
import { isFeatureEnabled } from "@/lib/features";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Native-client mirror of src/app/(app)/upcoming/page.tsx: the same list
// (src/lib/upcoming-list.ts), enriched and filtered the same way.
export const GET = withAuth(async (request, _ctx, session) => {
  const t = translatorForRequest(request);
  if (!(await isFeatureEnabled("feature.page.upcoming"))) {
    return NextResponse.json({ error: t("apiUser.browse.upcomingDisabled") }, { status: 403 });
  }
  if (!checkRateLimit(`upcoming:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequests") }, { status: 429 });
  }

  const hideAvailable = request.nextUrl.searchParams.get("hideAvailable") === "1";
  // Per-user server visibility for the hideAvailable gate — with the integration
  // flags, which default to TRUE when omitted.
  const [plexEnabled, jellyfinEnabled] = await Promise.all([
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
  ]);
  const { showPlex, showJellyfin } = getBadgeVisibility(session, {
    plex: plexEnabled,
    jellyfin: jellyfinEnabled,
  });
  const { titles: raw, failed } = await loadUpcomingTitles();
  if (failed) {
    // Surface a real fetch failure as 502 instead of returning 200 with an empty
    // list — the latter is indistinguishable from "no upcoming releases" and hides
    // the outage. A legitimately-empty result (no error) still falls through to
    // 200, and so does a partial failure that still produced titles.
    return NextResponse.json({ error: t("apiUser.browse.upcomingFailed") }, { status: 502 });
  }

  const show4k = await getShow4kVisibility(session);
  let items = await attachAllAvailability(raw, session.user.id, { show4k });
  if (hideAvailable) {
    items = items.filter((m) => !((showPlex && m.plexAvailable) || (showJellyfin && m.jellyfinAvailable)));
  }

  return NextResponse.json({ items });
});
