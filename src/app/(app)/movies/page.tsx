export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { BrowsePage, browsePageTitle } from "@/components/media/browse-page";
import { requireAppSession } from "@/lib/require-app-session";
import type { PageSearchParams } from "@/lib/search-params";

// Tab / bookmark / history title — the nav label, in the viewer's language.
export async function generateMetadata(): Promise<Metadata> {
  return { title: await browsePageTitle("movie") };
}

// The body is shared with the /tv page (components/media/browse-page.tsx).
export default async function MoviesPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  // The DB-checked gate (guardrail 29) runs here, before any TMDB read.
  const session = await requireAppSession();
  return <BrowsePage mediaType="movie" session={session} searchParams={searchParams} />;
}
