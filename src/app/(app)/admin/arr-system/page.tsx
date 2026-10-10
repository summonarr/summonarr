import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { enabledArrInstances } from "@/lib/arr-admin";
import { getTranslator } from "@/lib/i18n/server";
import { PageHeader } from "@/components/ui/design";
import { ArrSystem } from "@/components/admin/arr-system";

export const dynamic = "force-dynamic";

// ADMIN-only (guardrail 29, as the other arr pages). Every tab reads
// Radarr/Sonarr live from the client; this render only decides whether there
// is anything to read and which tab the URL asked for.
export default async function ArrSystemPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");
  const t = await getTranslator();
  const configured = (await enabledArrInstances()).length > 0;
  const raw = (await searchParams).tab;
  const tab = raw === "providers" || raw === "storage" ? raw : "tasks";
  return (
    <div className="ds-page-enter">
      <PageHeader title={t("adminArr.system.title")} subtitle={t("adminArr.system.subtitle")} />
      <ArrSystem configured={configured} initialTab={tab} />
    </div>
  );
}
