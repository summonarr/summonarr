import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/design";
import { TrashGuidesNav } from "@/components/admin/trash-guides/trash-guides-nav";
import { TruncationBanner } from "@/components/admin/trash-guides/banners";

export const dynamic = "force-dynamic";

const LAYOUT_KEYS = [
  "radarrUrl",
  "radarrApiKey",
  "sonarrUrl",
  "sonarrApiKey",
  "radarr4kUrl",
  "radarr4kApiKey",
  "sonarr4kUrl",
  "sonarr4kApiKey",
  "trashLastRefreshTruncatedAt",
] as const;

const TRUNCATION_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export default async function TrashGuidesLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") redirect("/");

  const rows = await prisma.setting.findMany({
    where: { key: { in: [...LAYOUT_KEYS] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const radarrConfigured = !!(map.radarrUrl && map.radarrApiKey);
  const sonarrConfigured = !!(map.sonarrUrl && map.sonarrApiKey);
  const radarr4kConfigured = !!(map.radarr4kUrl && map.radarr4kApiKey);
  const sonarr4kConfigured = !!(map.sonarr4kUrl && map.sonarr4kApiKey);

  // Compute truncation staleness server-side — guardrail 16 forbids Date.now() in client render path.
  // The banner only fires if the last truncation was within the last 7 days; older markers are stale signal.
  const truncatedAtRaw = map.trashLastRefreshTruncatedAt ?? null;
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
        radarr4kConfigured={radarr4kConfigured}
        sonarr4kConfigured={sonarr4kConfigured}
      />
      {recentTruncation && <TruncationBanner at={recentTruncation.at} />}
      {children}
    </div>
  );
}
