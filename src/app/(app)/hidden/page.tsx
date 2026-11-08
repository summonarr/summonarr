import { requireAppSession } from "@/lib/require-app-session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/design";
import { HiddenGrid } from "@/components/hidden/hidden-grid";
import { getTranslator } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// Newest-first page size. One row past it is read, only to tell "exactly the
// cap" from "more": the grid says the list was cut (and offers a reload once
// this slice is un-hidden) only when there really are older titles.
const LIST_CAP = 500;

// Manage the caller's "not interested" list. requireAppSession() is the per-page
// DB-checked login gate — the (app) layout's gate can be skipped via a client-supplied
// RSC router state tree, so each page enforces the login wall itself (guardrail 29,
// src/lib/require-app-session.ts). The returned session also supplies the caller's own id.
export default async function HiddenPage() {
  const session = await requireAppSession();
  const t = await getTranslator();
  const rows = await prisma.hiddenItem.findMany({
    where: { userId: session.user.id },
    select: { tmdbId: true, mediaType: true, title: true, posterPath: true },
    orderBy: { createdAt: "desc" },
    take: LIST_CAP + 1,
  });
  const truncated = rows.length > LIST_CAP;
  const items = truncated ? rows.slice(0, LIST_CAP) : rows;

  return (
    <div className="ds-page-enter">
      <PageHeader
        title={t("personal.hidden.title")}
        subtitle={t("personal.hidden.subtitle")}
      />
      <HiddenGrid initialItems={items} cap={LIST_CAP} truncated={truncated} />
    </div>
  );
}
