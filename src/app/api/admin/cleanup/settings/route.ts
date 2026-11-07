import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { readJsonCapped } from "@/lib/body-size";
import { logAudit, auditContext } from "@/lib/audit";
import { validateCleanupSettingsPatch } from "@/lib/library-cleanup";
import { loadCleanupSettings } from "@/lib/library-cleanup-data";
import { cleanupDisabledResponse } from "@/lib/library-cleanup-gate";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { invalidateNeverWatchedReport } from "@/lib/never-watched-report";

// Library cleanup rules (ADMIN). GET returns the rules in force; PATCH takes a
// partial object keyed by field name (unwatchedEnabled, unwatchedDays, …) and
// refuses the WHOLE patch on any bad value — nothing is repaired on write.

export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const off = await cleanupDisabledResponse(t);
  if (off) return off;
  return NextResponse.json({ settings: await loadCleanupSettings() });
});

export const PATCH = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const off = await cleanupDisabledResponse(t);
  if (off) return off;
  const parsed = await readJsonCapped<Record<string, unknown>>(req, 4096);
  if (parsed instanceof NextResponse) return parsed;
  const result = validateCleanupSettingsPatch(parsed, t);
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 });

  await prisma.$transaction(
    result.rows.map((r) =>
      prisma.setting.upsert({ where: { key: r.key }, create: { key: r.key, value: r.value }, update: { value: r.value } }),
    ),
  );
  invalidateNeverWatchedReport();
  // Committed with no enclosing transaction left ⇒ the swallowing variant (guardrail 26).
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SETTINGS_CHANGE",
    target: "library-cleanup",
    details: { changed: Object.fromEntries(result.rows.map((r) => [r.key, r.value])) },
    ...auditContext(req, session),
  });
  return NextResponse.json({ settings: await loadCleanupSettings() });
});
