// Shared setup for the REAL-Postgres suite (npm run test:db). Everything under
// tests/db/ talks to an actual database through the app's own `@/lib/prisma`
// client — no stubs — so it can see what the stubbed unit suite cannot:
// transaction rollback semantics, UPDATE … RETURNING races, advisory locks,
// raw SQL. See scripts/test-db.sh for how the database is provided.
//
// Import this module FIRST in every test file: it validates the target and sets
// the env that `@/lib/prisma` reads at load time.
process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.NEXTAUTH_SECRET ??= "db-suite-secret-0123456789abcdef0123";
process.env.TRUST_PROXY ??= "true";

const url = process.env.DATABASE_URL ?? "";
let dbName = "";
try {
  dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
} catch {
  /* fall through to the refusal below */
}
// The suite TRUNCATEs. A database that does not announce itself as disposable is refused.
if (!/test|ci/i.test(dbName)) {
  throw new Error(
    `tests/db refuses to run against database "${dbName || "(none)"}": its name must contain "test" or "ci". Use npm run test:db.`,
  );
}

// Console noise from the code under test is not the subject here.
const { prisma } = await import("@/lib/prisma");
export { prisma };

const TABLES = [
  "MediaRequest",
  "User",
  "Setting",
  "PlexLibraryItem",
  "PlexLibraryItemStaging",
  "JellyfinLibraryItem",
  "JellyfinLibraryItemStaging",
  "AuthSession",
  "Issue",
  "AutoRequestLedger",
  "RadarrWantedItem",
  "RadarrAvailableItem",
  "SonarrWantedItem",
  "SonarrAvailableItem",
  "TVEpisodeCache",
  "MediaServerUser",
  "PlayHistory",
];

export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

let seq = 0;
export async function makeUser(over: { deactivated?: boolean } = {}): Promise<{ id: string; email: string }> {
  const email = `user${++seq}-${Date.now()}@db-suite.test`;
  const u = await prisma.user.create({
    data: { email, ...(over.deactivated ? { deactivatedAt: new Date() } : {}) },
    select: { id: true, email: true },
  });
  return u;
}

export async function makeRequests(
  requestedBy: string,
  count: number,
  status: "PENDING" | "APPROVED" | "DECLINED" | "AVAILABLE" = "APPROVED",
): Promise<Array<{ id: string; requestedBy: string }>> {
  const out: Array<{ id: string; requestedBy: string }> = [];
  for (let i = 0; i < count; i++) {
    const r = await prisma.mediaRequest.create({
      data: { mediaType: "MOVIE", tmdbId: 1000 + ++seq, title: `Movie ${seq}`, requestedBy, status },
      select: { id: true, requestedBy: true },
    });
    out.push(r);
  }
  return out;
}

// One request with arbitrary columns; tmdbId defaults to a fresh value so the
// (tmdbId, mediaType, requestedBy, arrInstance) unique key never collides.
export async function makeRequest(
  requestedBy: string,
  over: Record<string, unknown> = {},
): Promise<{ id: string }> {
  return prisma.mediaRequest.create({
    data: {
      mediaType: "MOVIE",
      tmdbId: 500000 + ++seq,
      title: `Req ${seq}`,
      requestedBy,
      ...over,
    } as Parameters<typeof prisma.mediaRequest.create>[0]["data"],
    select: { id: true },
  });
}

export const daysAgo = (d: number): Date => new Date(Date.now() - d * 86_400_000);

export async function closeDb(): Promise<void> {
  await prisma.$disconnect();
}
