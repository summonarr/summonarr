import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { snapshotted } from "@/lib/arr-snapshot";
import { arrFailure, arrGate, type ArrTarget, readWarnKey } from "@/lib/arr-admin-http";
import { parseIdList, parsePaging } from "@/lib/arr-history";
import { BlocklistUnsupportedError, loadBlocklistPage, removeFromBlocklist } from "@/lib/arr-history-data";
import { auditContext, logAudit } from "@/lib/audit";
import { forgetWarnOnChange } from "@/lib/log-dedup";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";

// Admin → Download History → Blocklist (ADMIN): releases Radarr/Sonarr will
// never grab again, one instance at a time.
//   GET ?service&instance&page&pageSize → { page, pageSize, totalRecords, records }
//       — each with the title, release name, quality, indexer and the reason.
//   DELETE ?service&instance&ids=1,2[&page&pageSize] — take those releases off
//       the blocklist (the arr's bulk DELETE) so they can be grabbed again.
//       `page`/`pageSize` name the page the admin picked them from, re-read
//       first so a removal from the page in view costs one read. Audited
//       ARR_BLOCKLIST_CHANGE after the arr accepted it, with each release's
//       name and title (the ids point at nothing afterwards). Clearing the
//       whole list is POST /api/admin/arr/blocklist/clear.
// An arr older than the /blocklist API (Radarr v3, Sonarr v3 before Aug 2021)
// answers 404 — named as such, never as "that item is gone".

// A literal map: the dead-key check can't see a built key.
const TOO_OLD_KEYS = {
  radarr: "apiAdmin.arr.blocklistTooOld.radarr",
  sonarr: "apiAdmin.arr.blocklistTooOld.sonarr",
} as const;

// The audit names at most this many releases; `removed` still lists every id.
const MAX_AUDITED_RELEASES = 100;

function failure(err: unknown, target: ArrTarget, t: Translator, what: string, opts: { warnKey?: string } = {}): NextResponse {
  if (err instanceof BlocklistUnsupportedError) {
    return NextResponse.json({ error: t(TOO_OLD_KEYS[target.service]) }, { status: 404 });
  }
  return arrFailure(err, target, t, what, opts);
}

// GET with `cached=1` → the last answer kept for this exact read, for display only
// (src/lib/arr-snapshot.ts).
export const GET = withAdmin(snapshotted(async (req) => {
  const t = translatorForRequest(req);
  const q = req.nextUrl.searchParams;
  const target = await arrGate(q.get("service"), q.get("instance"), t);
  if (target instanceof NextResponse) return target;
  const paging = parsePaging(q.get("page"), q.get("pageSize"));
  if (!paging) return NextResponse.json({ error: t("apiAdmin.arr.pagingInvalid") }, { status: 400 });
  const warnKey = readWarnKey("blocklist", target);
  try {
    const page = await loadBlocklistPage(target.service, target.instance, paging);
    forgetWarnOnChange(warnKey);
    return NextResponse.json(page);
  } catch (err) {
    return failure(err, target, t, "blocklist read", { warnKey });
  }
}));

export const DELETE = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const q = req.nextUrl.searchParams;
  const target = await arrGate(q.get("service"), q.get("instance"), t);
  if (target instanceof NextResponse) return target;
  const ids = parseIdList(q.get("ids"), 500);
  if (!ids) return NextResponse.json({ error: t("apiAdmin.arr.blocklistIdsInvalid") }, { status: 400 });
  const hinted = q.has("page") || q.has("pageSize");
  const viewed = hinted ? parsePaging(q.get("page"), q.get("pageSize")) : null;
  if (hinted && !viewed) return NextResponse.json({ error: t("apiAdmin.arr.pagingInvalid") }, { status: 400 });
  let removed;
  try {
    removed = await removeFromBlocklist(target.service, target.instance, ids, viewed);
  } catch (err) {
    return failure(err, target, t, "blocklist remove");
  }
  const mediaKey = target.service === "radarr" ? "movieId" : "seriesId";
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_BLOCKLIST_CHANGE",
    target: `${target.service}:${target.instance}`,
    details: {
      service: target.service,
      instance: target.instance,
      removed: ids,
      releases: removed.slice(0, MAX_AUDITED_RELEASES).map((r) => ({ id: r.id, release: r.release, [mediaKey]: r.arrMediaId })),
      ...(removed.length > MAX_AUDITED_RELEASES ? { releasesOmitted: removed.length - MAX_AUDITED_RELEASES } : {}),
    },
    ...auditContext(req, session),
  });
  return NextResponse.json({ removed: ids.length });
});
