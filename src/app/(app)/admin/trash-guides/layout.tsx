import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getSyncableArrInstances } from "@/lib/arr-instance-registry";
import { PageHeader } from "@/components/ui/design";
import { TrashGuidesNav } from "@/components/admin/trash-guides/trash-guides-nav";
import { TruncationBanner } from "@/components/admin/trash-guides/banners";

export const dynamic = "force-dynamic";

const TRUNCATION_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export default async function TrashGuidesLayout({ children }: { children: React.ReactNode }) {
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const [radarrInstances, sonarrInstances, truncRow] = await Promise.all([
    getSyncableArrInstances("radarr"),
    getSyncableArrInstances("sonarr"),
    prisma.setting.findUnique({ where: { key: "trashLastRefreshTruncatedAt" } }),
  ]);

  const radarrConfigured = radarrInstances.some((i) => i.slug === "");
  const sonarrConfigured = sonarrInstances.some((i) => i.slug === "");

  // Compute truncation staleness server-side — guardrail 16 forbids Date.now() in client render path.
  // The banner only fires if the last truncation was within the last 7 days; older markers are stale signal.
  const truncatedAtRaw = truncRow?.value ?? null;
  let recentTruncation: { at: string } | null = null;
  if (truncatedAtRaw) {
    const t = Date.parse(truncatedAtRaw);
    // eslint-disable-next-line react-hooks/purity -- server component; Date.now() runs once per request
    if (!Number.isNaN(t) && Date.now() - t < TRUNCATION_STALE_MS) {
      recentTruncation = { at: truncatedAtRaw };
    }
  }

  return (
    <div className="ds-page-enter">
      <PageHeader
        title="TRaSH Guides"
        subtitle={
          <>
            Sync recommended custom formats, quality profiles, naming schemes,
            and quality sizes from{" "}
            <a
              href="https://trash-guides.info"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
              style={{ color: "var(--ds-accent)" }}
            >
              trash-guides.info
            </a>
            .
          </>
        }
      />
      <TrashGuidesNav
        radarrConfigured={radarrConfigured}
        sonarrConfigured={sonarrConfigured}
        radarrInstances={radarrInstances.map((i) => ({ slug: i.slug, name: i.name }))}
        sonarrInstances={sonarrInstances.map((i) => ({ slug: i.slug, name: i.name }))}
      />
      {recentTruncation && <TruncationBanner at={recentTruncation.at} />}
      {children}
    </div>
  );
}
