import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { isFeatureEnabled } from "@/lib/features";
import { getSyncableArrInstances } from "@/lib/arr-instance-registry";
import { parseMissingMode, parseMissingService } from "@/lib/arr-missing-data";
import { getTranslator } from "@/lib/i18n/server";
import { PageHeader } from "@/components/ui/design";
import { MissingReport } from "@/components/admin/missing-report";

export const dynamic = "force-dynamic";

async function serviceConfigured(service: "radarr" | "sonarr"): Promise<boolean> {
  if (!(await isFeatureEnabled(`feature.integration.${service}`))) return false;
  return (await getSyncableArrInstances(service)).length > 0;
}

// ADMIN-only. The (app)/admin layout admits delegated managers too, so the role
// decision is re-made here with the DB-checked authActive() (guardrail 29). The
// report itself loads client-side, per tab, because it makes live Radarr/Sonarr
// calls; this render only decides which tabs have anything to read.
export default async function MissingPage({
  searchParams,
}: {
  searchParams: Promise<{ service?: string | string[]; mode?: string | string[] }>;
}) {
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");
  const t = await getTranslator();
  const [sonarr, radarr] = await Promise.all([serviceConfigured("sonarr"), serviceConfigured("radarr")]);
  const sp = await searchParams;
  const raw = sp.service;
  const requested = parseMissingService(typeof raw === "string" ? raw : null);
  const initialMode = parseMissingMode(typeof sp.mode === "string" ? sp.mode : undefined) ?? "missing";
  // Sonarr is the first tab; land on Radarr only when asked, or when it is the
  // only one of the two with anything to show.
  const initialService = requested ?? (!sonarr && radarr ? "radarr" : "sonarr");

  return (
    <div className="ds-page-enter">
      <PageHeader title={t("adminManage.missing.title")} subtitle={t("adminManage.missing.subtitle")} />
      <MissingReport initialService={initialService} initialMode={initialMode} configured={{ sonarr, radarr }} />
    </div>
  );
}
