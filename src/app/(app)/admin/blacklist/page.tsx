import { authActive } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { PageHeader } from "@/components/ui/design";
import { BlacklistManager } from "@/components/admin/blacklist-manager";

export const dynamic = "force-dynamic";

// Admin-only. The (app)/admin layout is already DB-gated, but per guardrail 29 a
// page making a role decision re-checks with authActive() rather than trusting the
// proxy alone (the prefetch path skips it).
export default async function BlacklistPage() {
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const items = await prisma.blacklistItem.findMany({ orderBy: { createdAt: "desc" }, take: 1000 });
  const initial = items.map((i) => ({
    tmdbId: i.tmdbId,
    mediaType: i.mediaType,
    title: i.title,
    reason: i.reason,
    createdAt: i.createdAt.toISOString(),
  }));

  return (
    <div className="ds-page-enter">
      <PageHeader
        title="Blacklist"
        subtitle="Block specific titles from discovery and requests"
      />
      <BlacklistManager initial={initial} />
    </div>
  );
}
