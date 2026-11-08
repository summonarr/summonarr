// Request-body list limits that a route enforces AND the API spec documents.
// Zero imports, so the spec modules can read them (guardrail 25: the spec never
// imports a route file); the route and its maxItems can then never drift apart.

/** POST /api/admin/queue/remove: queue record ids per call. */
export const QUEUE_REMOVE_MAX_IDS = 5_000;
/** POST /api/admin/queue/grab: queue record ids per call. */
export const QUEUE_GRAB_MAX_IDS = 500;
/** POST /api/admin/queue/import (+ /preview): files per manual import. */
export const QUEUE_IMPORT_MAX_FILES = 2_000;
/** GET /api/requests/[id]/comments and GET /api/issues/[id]/messages: the newest messages a thread read returns (older ones drop off; `X-Truncated`). */
export const THREAD_READ_CAP = 500;
/** POST /api/ratings/batch: titles per call. */
export const RATINGS_BATCH_MAX_ITEMS = 200;
/** POST /api/issues/[id]/files: file ids per delete. */
export const ISSUE_FILES_MAX_IDS = 5_000;
/** POST /api/admin/arr/title/command: episode ids per command. */
export const TITLE_COMMAND_MAX_EPISODES = 1_000;
/** PATCH /api/admin/arr/title/episodes: episode ids per monitor change. */
export const TITLE_EPISODES_MAX_IDS = 5_000;
/** PATCH /api/requests/batch: request ids per call. */
export const REQUEST_BATCH_MAX_IDS = 100;
/** PATCH /api/requests/batch with `permanent`: ids per permanent decline. */
export const REQUEST_BATCH_MAX_PERMANENT = 25;
/** POST /api/admin/notification-agents: outbound channels in all. */
export const NOTIFICATION_AGENTS_MAX = 25;
