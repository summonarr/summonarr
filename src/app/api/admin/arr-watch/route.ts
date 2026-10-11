import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { readJsonCapped } from "@/lib/body-size";
import { logAudit, auditContext } from "@/lib/audit";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import {
  ARR_WATCH_DISK_LOW_PERCENT_KEY,
  MAX_DISK_LOW_PERCENT,
  MIN_DISK_LOW_PERCENT,
  validateDiskLowPercent,
} from "@/lib/arr-watch";
import { loadDiskLowPercent, readArrWatchSummary } from "@/lib/arr-watch-data";

// The Radarr/Sonarr monitor's setting and its last run's counts (ADMIN).
// GET: { settings: { diskLowPercent }, summary: { at, attention, lowDisks,
// failed24h } | null }. PATCH { diskLowPercent }: a whole number of percent,
// 1–50; anything else is refused whole — nothing is repaired on write.

async function settings() {
  return { diskLowPercent: await loadDiskLowPercent() };
}

export const GET = withAdmin(async () => {
  const [s, summary] = await Promise.all([settings(), readArrWatchSummary()]);
  return NextResponse.json({ settings: s, summary });
});

export const PATCH = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, 4096);
  if (parsed instanceof NextResponse) return parsed;
  const percent = validateDiskLowPercent(parsed?.diskLowPercent);
  if (percent === null) {
    return NextResponse.json(
      { error: t("apiAdmin.arrWatch.diskLowPercent", { min: MIN_DISK_LOW_PERCENT, max: MAX_DISK_LOW_PERCENT }) },
      { status: 400 },
    );
  }
  const value = String(percent);
  await prisma.setting.upsert({
    where: { key: ARR_WATCH_DISK_LOW_PERCENT_KEY },
    create: { key: ARR_WATCH_DISK_LOW_PERCENT_KEY, value },
    update: { value },
  });
  // Committed with no enclosing transaction left ⇒ the swallowing variant (guardrail 26).
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SETTINGS_CHANGE",
    target: "arr-watch",
    details: { changed: { [ARR_WATCH_DISK_LOW_PERCENT_KEY]: value } },
    ...auditContext(req, session),
  });
  return NextResponse.json({ settings: await settings() });
});
