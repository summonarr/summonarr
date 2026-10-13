import type { Metadata } from "next";
import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { isFeatureEnabled } from "@/lib/features";
import { getSyncableArrInstances } from "@/lib/arr-instance-registry";
import { parseQueueLinkFilters } from "@/lib/arr-manage-links";
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
// Radarr/Sonarr calls; this render only decides whether there is anything to read,
// and passes the filters a link asked for: `?q=` (title text) and
// `?service=&instance=&arrId=` (exactly one title's downloads — the title
// manager's History tab links here) and `?filter=attention` (the tab the nav
// badge's count lands on), all validated by parseQueueLinkFilters.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("adminManage.queue.title") };
}

export default async function DownloadQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; service?: string | string[]; instance?: string | string[]; arrId?: string | string[]; filter?: string | string[] }>;
}) {
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");
  const t = await getTranslator();
  const configured = await anyConfigured();
  const initialFilters = parseQueueLinkFilters(await searchParams);
  return (
    <div className="ds-page-enter">
      <PageHeader title={t("adminManage.queue.title")} subtitle={t("adminManage.queue.subtitle")} />
      <DownloadQueue configured={configured} initialFilters={initialFilters} />
    </div>
  );
}
