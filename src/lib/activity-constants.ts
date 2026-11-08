// Values shared by the Activity server pages and their client components. They
// live outside the "use client" modules on purpose: a value exported from a
// client module reaches a server component as a client reference, not a value.

// Rows per page of the overview's Recent plays card. The page seeds page 1 with
// this many rows and the card asks /api/play-history for page N at the same
// size, whose offset is (N - 1) × size: the two must agree, or rows are skipped
// or repeated at the page boundary.
export const RECENT_PLAYS_PAGE_SIZE = 20;
