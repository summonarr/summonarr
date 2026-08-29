// Shared page-number parsing for paginated API routes. Clamps to [1, max] so an
// oversized `?page=` can never reach Prisma's `skip` (page × PAGE_SIZE) as a
// huge offset — several routes hardened this independently and two copies had
// been missed, letting `?page=999999999999` drive skip into the trillions.
export function parsePageParam(
  searchParams: URLSearchParams,
  opts: { max?: number } = {},
): number {
  const max = opts.max ?? 10_000;
  return Math.min(Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1), max);
}
