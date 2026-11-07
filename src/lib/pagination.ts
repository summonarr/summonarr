// Shared page-number parsing for paginated routes and pages. Clamps to [1, max]
// so an oversized `?page=` can never reach Prisma's `skip` (page × PAGE_SIZE) as
// a huge offset — several routes hardened this independently and two copies had
// been missed, letting `?page=999999999999` drive skip into the trillions (past
// Prisma's 64-bit skip limit, a query error and a 500 page).
export function parsePageParam(
  searchParams: URLSearchParams,
  opts: { max?: number } = {},
): number {
  return parsePageNumber(searchParams.get("page"), opts);
}

// The same rule for a raw value: a server component's `searchParams` field. A
// repeated key (`?page=2&page=3`) arrives as an array at runtime; its first
// value counts.
export function parsePageNumber(
  raw: string | string[] | null | undefined,
  opts: { max?: number } = {},
): number {
  const max = opts.max ?? 10_000;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return Math.min(Math.max(1, parseInt(typeof value === "string" ? value : "1", 10) || 1), max);
}
