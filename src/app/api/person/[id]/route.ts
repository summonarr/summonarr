import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { getEnrichedPerson } from "@/lib/person";
import { checkRateLimit } from "@/lib/rate-limit";

// The enrichment lives in getEnrichedPerson (shared with the /person/[id] server
// page) so the two can't drift. This handler is just auth + rate-limit + the
// 404-vs-502 mapping.
export const GET = withAuth(async (
  _req,
  { params }: { params: Promise<{ id: string }> },
  session,
) => {
  if (!checkRateLimit(`person:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;
  const personId = Number(id);
  if (!Number.isFinite(personId) || personId <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  try {
    const person = await getEnrichedPerson(personId, session);
    return NextResponse.json(person);
  } catch (err) {
    console.error("[person] lookup failed:", err instanceof Error ? err.message : err);
    // Only an actual TMDB 404 (unknown person id) is a true Not Found. A TMDB
    // 5xx, a network error, or a Prisma/enrichment failure must NOT masquerade as
    // a 404 — return 502 so a transient upstream/DB problem is distinguishable
    // from a genuinely missing person.
    const message = err instanceof Error ? err.message : String(err);
    if (/failed: 404\b/.test(message)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Upstream error" }, { status: 502 });
  }
});
