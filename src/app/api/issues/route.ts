import { NextResponse, after } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { maintenanceGuard } from "@/lib/maintenance";
import { isFeatureEnabled } from "@/lib/features";
import { hasPermission, Permission } from "@/lib/permissions";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { createIssue } from "@/lib/issue-create";

export const GET = withAuth(async (req, _ctx, session) => {
  // Issue visibility is bitmask-authoritative: a demoted ISSUE_ADMIN (role kept but
  // MANAGE_ISSUES cleared) is scoped to their own issues. ADMIN passes via the superbit.
  const canManageIssues = hasPermission(session.user.permissions, Permission.MANAGE_ISSUES);
  const where = canManageIssues ? {} : { reportedBy: session.user.id };

  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = Math.min(100, Math.max(1, parseInt(limitParam ?? "50", 10) || 50));

  const issues = await (canManageIssues
    ? prisma.issue.findMany({
        where,
        include: { user: { select: { name: true, email: true } } },
        orderBy: { createdAt: "desc" },
        take: limit,
      })
    : prisma.issue.findMany({
        where,
        include: { user: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: limit,
      }));

  return NextResponse.json(issues);
});

export const POST = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!(await isFeatureEnabled("feature.page.issues"))) {
    return NextResponse.json({ error: t("apiUser.issues.disabled") }, { status: 403 });
  }

  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  const rlRow = await prisma.setting.findUnique({ where: { key: "rateLimitIssues" } });
  const rlLimit = parseRateLimit(rlRow?.value, 10);
  if (!checkRateLimit(`issues:${session.user.id}`, rlLimit, 60 * 1000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
  }

  const parsed = await readJsonCapped<{
    mediaType?: string;
    tmdbId?: number;
    tvdbId?: number;
    issueType?: string;
    scope?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    note?: string;
  }>(req, 65536);
  if (parsed instanceof NextResponse) return parsed;

  // Validation, the library gate, the create and the admin fan-out are the
  // shared chokepoint Discord's /issue files through too (src/lib/issue-create.ts).
  // A body tvdbId is ignored there on purpose.
  const created = await createIssue(session, parsed, t);
  if (!created.ok) return NextResponse.json({ error: created.error }, { status: created.status });
  const { issue } = created;
  after(created.notify);
  return NextResponse.json(issue, { status: 201 });
});
