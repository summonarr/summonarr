import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { isFeatureEnabled } from "@/lib/features";
import { getSyncableArrInstances } from "@/lib/arr-instance-registry";
import { getTranslator } from "@/lib/i18n/server";
import { PageHeader } from "@/components/ui/design";
import { DownloadQueue } from "@/components/admin/download-queue";

export const dynamic = "force-dynamic";

async function anyConfigured(): Promise<boolean> {
  for (const service of ["radarr", "sonarr"] as const) {
    if (!(await isFeatureEnabled(`feature.integration.${service}`))) continue;
    if ((await getSyncableArrInstances(service)).length > 0) return true;
  }
  return false;
}

// ADMIN-only. The (app)/admin layout admits delegated managers too, so the role
// decision is re-made here with the DB-checked authActive() (guardrail 29). The
// queue and the health panel load client-side because both make live
// Radarr/Sonarr calls; this render only decides whether there is anything to read.
export default async function DownloadQueuePage() {
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");
  const t = await getTranslator();
  const configured = await anyConfigured();
  return (
    <div className="ds-page-enter">
      <PageHeader title={t("adminManage.queue.title")} subtitle={t("adminManage.queue.subtitle")} />
      <DownloadQueue configured={configured} />
    </div>
  );
}
