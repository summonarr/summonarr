// Request caps shared by a route and the client that has to stay under them.
// Zero-import so client components can use it (a route file can't export
// arbitrary constants).

// Items per POST /api/requests/bulk. The route rejects a larger batch outright
// (400 "Too many items"), and the collection "Request all" button chunks by the
// same value — a hand-kept copy that drifted lower on the server would 400
// every chunk.
export const BULK_REQUEST_MAX_ITEMS = 50;

// Longest admin note (decline reason / reply) PATCH /api/requests/[id] and
// /api/requests/batch accept (400 "adminNoteTooLong" past it). The queue's note
// inputs cap at the same value, so a long reason is stopped while typing rather
// than refused after submit.
export const ADMIN_NOTE_MAX = 1000;

// Longest note a requester may attach to a request (POST /api/requests, 400
// "noteTooLong" past it). The request dialog's note field cuts typing at the
// same length.
export const REQUEST_NOTE_MAX = 500;
