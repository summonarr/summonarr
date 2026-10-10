import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { enabledArrInstances } from "@/lib/arr-admin";
import { getTranslator } from "@/lib/i18n/server";
import { PageHeader } from "@/components/ui/design";
import { ArrDownloadHistory } from "@/components/admin/arr-download-history";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

// ADMIN-only (guardrail 29, as the other arr pages). History and Blocklist
// load client-side — live, paged Radarr/Sonarr reads; this render passes the
// configured instances and the tab/instance the URL asked for.
export default async function ArrHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[]; service?: string | string[]; instance?: string | string[] }>;
}) {
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");
  const t = await getTranslator();
  const instances = await enabledArrInstances();
  const sp = await searchParams;
  const tab = first(sp.tab) === "blocklist" ? "blocklist" : "history";
  const service = first(sp.service);
  const initialInstance = service === "radarr" || service === "sonarr" ? `${service}:${first(sp.instance) ?? ""}` : null;
  return (
    <div className="ds-page-enter">
      <PageHeader title={t("adminArr.historyPage.title")} subtitle={t("adminArr.historyPage.subtitle")} />
      <ArrDownloadHistory instances={instances} initialTab={tab} initialInstance={initialInstance} />
    </div>
  );
}
