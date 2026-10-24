import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { requireFeature } from "@/lib/features";
import { getTranslator } from "@/lib/i18n/server";
import { PageHeader } from "@/components/ui/design";
import { WatchSyncPanel } from "@/components/admin/watch-sync-panel";

export const dynamic = "force-dynamic";

// ADMIN-only. The (app)/admin layout admits delegated managers too, so the role
// decision is re-made here with the DB-checked authActive() (guardrail 29).
// Pairs a Plex account with a Jellyfin user for watch sync (guardrail 19e).
export default async function WatchSyncPage() {
  await requireFeature("feature.admin.watchSync");
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");
  const t = await getTranslator();
  return (
    <div className="ds-page-enter">
      <PageHeader title={t("adminManage.watchSync.title")} subtitle={t("adminManage.watchSync.subtitle")} />
      <WatchSyncPanel />
    </div>
  );
}
