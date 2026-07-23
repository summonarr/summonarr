import { requireAppSession } from "@/lib/require-app-session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/design";
import { HiddenGrid } from "@/components/hidden/hidden-grid";

export const dynamic = "force-dynamic";

// Manage the caller's "not interested" list. requireAppSession() is the per-page
// DB-checked login gate — the (app) layout's gate can be skipped via a client-supplied
// RSC router state tree, so each page enforces the login wall itself (guardrail 29,
// src/lib/require-app-session.ts). The returned session also supplies the caller's own id.
export default async function HiddenPage() {
  const session = await requireAppSession();
  const items = session
    ? await prisma.hiddenItem.findMany({
        where: { userId: session.user.id },
        select: { tmdbId: true, mediaType: true, title: true, posterPath: true },
        orderBy: { createdAt: "desc" },
        take: 500,
      })
    : [];

  return (
    <div>
      <PageHeader title="Hidden" subtitle="Titles you've marked “not interested.” These are kept out of your discovery." />
      <div style={{ marginTop: 16 }}>
        <HiddenGrid initialItems={items} />
      </div>
    </div>
  );
}
