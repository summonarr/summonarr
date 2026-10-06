import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import { requireAppSession } from "@/lib/require-app-session";
import { getEnrichedPerson } from "@/lib/person";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { isFeatureEnabled } from "@/lib/features";
import { PersonView } from "@/components/media/person-view";
import { DetailTitle } from "@/components/layout/detail-title";

export const dynamic = "force-dynamic";

// Person detail page — filmography with per-viewer availability + requesting,
// reached by tapping a cast member. requireAppSession() is the per-page DB-checked
// login gate (guardrail 29); the enrichment is scoped to the session user inside
// getEnrichedPerson (shared with GET /api/person/[id]). A genuine TMDB 404 →
// notFound(); any other upstream/DB failure propagates to the error boundary.
//
// The gate + the read run ONCE per request, shared by generateMetadata and the
// page body (React `cache`, keyed on the route id — the (app)/layout.tsx idiom).
// A redirect()/notFound() thrown here is cached as the rejection, so both
// callers see the same outcome.
const loadPerson = cache(async (id: string) => {
  const session = await requireAppSession();
  const personId = Number(id);
  if (!Number.isFinite(personId) || personId <= 0) notFound();

  const person = await getEnrichedPerson(personId, session).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (/failed: 404\b/.test(message)) notFound();
    throw err;
  });
  return { session, person };
});

// Tab / bookmark / history title: the person's name, under the root layout's
// "%s · Summonarr" template.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const { person } = await loadPerson(id);
  return { title: person.name };
}

export default async function PersonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { session, person } = await loadPerson(id);

  const [plexEnabled, jellyfinEnabled] = await Promise.all([
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
  ]);
  const { showPlex, showJellyfin } = getBadgeVisibility(session, {
    plex: plexEnabled,
    jellyfin: jellyfinEnabled,
  });
  return (
    <>
      {/* Renders nothing — publishes the name so the header breadcrumb can
          read it, the same way the movie/tv pages publish their title. */}
      <DetailTitle title={person.name} />
      <PersonView person={person} showPlex={showPlex} showJellyfin={showJellyfin} />
    </>
  );
}
