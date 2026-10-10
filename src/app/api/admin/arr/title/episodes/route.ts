import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { arrFailure, arrTitleGate, parseIdArray, parseSeasonNumber } from "@/lib/arr-admin-http";
import { loadSeasonEpisodes, setEpisodesMonitored } from "@/lib/arr-title-data";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";

const MAX_EPISODES = 5_000;

// Admin title manager, a series' episodes (ADMIN, Sonarr only).
//   GET ?service=sonarr&instance&id&season → { episodes, now } of that season.
//   PATCH { service: "sonarr", instance, id, episodeIds, monitored } —
//       monitor or unmonitor episodes; every id must be one of the series'
//       episodes (409 otherwise, nothing written). Audited ARR_TITLE_EDIT.
export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const q = req.nextUrl.searchParams;
  const target = await arrTitleGate(q.get("service"), q.get("instance"), q.get("id"), t);
  if (target instanceof NextResponse) return target;
  const season = parseSeasonNumber(q.get("season"));
  if (target.service !== "sonarr" || season === null) {
    return NextResponse.json({ error: t("apiAdmin.arr.episodesParamsInvalid") }, { status: 400 });
  }
  try {
    // `now` is the reference time the page judges "aired" against (guardrail 16).
    return NextResponse.json({ episodes: await loadSeasonEpisodes(target.instance, target.arrId, season), now: new Date().toISOString() });
  } catch (err) {
    return arrFailure(err, target, t, "episode read");
  }
});

export const PATCH = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, 128 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const target = await arrTitleGate(body.service, body.instance, body.id, t);
  if (target instanceof NextResponse) return target;
  const episodeIds = parseIdArray(body.episodeIds, MAX_EPISODES);
  if (target.service !== "sonarr" || !episodeIds || typeof body.monitored !== "boolean") {
    return NextResponse.json({ error: t("apiAdmin.arr.episodesBodyInvalid") }, { status: 400 });
  }
  const monitored = body.monitored;
  try {
    await setEpisodesMonitored(target.instance, target.arrId, episodeIds, monitored);
  } catch (err) {
    return arrFailure(err, target, t, "episode monitor");
  }
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_TITLE_EDIT",
    target: `${target.service}:${target.instance}:${target.arrId}`,
    details: { service: target.service, instance: target.instance, arrId: target.arrId, fields: ["episodes"], episodes: episodeIds.length, monitored },
    ...auditContext(req, session),
  });
  return NextResponse.json({ updated: episodeIds.length });
});
