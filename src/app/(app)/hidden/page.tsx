import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/design";
import { HiddenGrid } from "@/components/hidden/hidden-grid";

export const dynamic = "force-dynamic";

// Manage the caller's "not interested" list. The (app) layout DB-gates login for
// the subtree (guardrail 29); auth() here is a personalization read of the
// caller's own id, not an authorization decision.
export default async function HiddenPage() {
  const session = await auth();
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
