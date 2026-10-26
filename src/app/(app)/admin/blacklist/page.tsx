import { authActive } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { PageHeader } from "@/components/ui/design";
import { BlacklistManager } from "@/components/admin/blacklist-manager";
import { getTranslator } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

const BLACKLIST_LIST_CAP = 1000;

// Admin-only. The (app)/admin layout is already DB-gated, but per guardrail 29 a
// page making a role decision re-checks with authActive() rather than trusting the
// proxy alone (the prefetch path skips it).
export default async function BlacklistPage() {
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const [items, total] = await Promise.all([
    prisma.blacklistItem.findMany({ orderBy: { createdAt: "desc" }, take: BLACKLIST_LIST_CAP }),
    prisma.blacklistItem.count(),
  ]);
  const initial = items.map((i) => ({
    tmdbId: i.tmdbId,
    mediaType: i.mediaType,
    title: i.title,
    reason: i.reason,
    createdAt: i.createdAt.toISOString(),
  }));
  const t = await getTranslator();

  return (
    <div className="ds-page-enter">
      <PageHeader
        title={t("adminQueue.blacklist.title")}
        subtitle={t("adminQueue.blacklist.subtitle")}
      />
      {total > items.length && (
        <p
          role="status"
          className="ds-mono"
          style={{ fontSize: 11, color: "var(--ds-fg-subtle)", marginBottom: 10 }}
        >
          {t("adminQueue.blacklist.capped", { cap: BLACKLIST_LIST_CAP, total })}
        </p>
      )}
      <BlacklistManager initial={initial} total={total} />
    </div>
  );
}
