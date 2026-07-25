import { notFound } from "next/navigation";
import { requireAppSession } from "@/lib/require-app-session";
import { getEnrichedPerson } from "@/lib/person";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { PersonView } from "@/components/media/person-view";

export const dynamic = "force-dynamic";

// Person detail page — filmography with per-viewer availability + requesting,
// reached by tapping a cast member. requireAppSession() is the per-page DB-checked
// login gate (guardrail 29); the enrichment is scoped to the session user inside
// getEnrichedPerson (shared with GET /api/person/[id]). A genuine TMDB 404 →
// notFound(); any other upstream/DB failure propagates to the error boundary.
export default async function PersonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireAppSession();
  const { id } = await params;
  const personId = Number(id);
  if (!Number.isFinite(personId) || personId <= 0) notFound();

  const person = await getEnrichedPerson(personId, session).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (/failed: 404\b/.test(message)) notFound();
    throw err;
  });

  const { showPlex, showJellyfin } = getBadgeVisibility(session);
  return <PersonView person={person} showPlex={showPlex} showJellyfin={showJellyfin} />;
}
