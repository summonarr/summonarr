# Request comments

A private conversation between a requester and the people who manage requests, under each request row. Rules in [request-comments.ts](../../src/lib/request-comments.ts) (pure), fan-out in [request-comment-notify.ts](../../src/lib/request-comment-notify.ts), route `GET/POST /api/requests/[id]/comments`, UI [request-thread.tsx](../../src/components/requests/request-thread.tsx) on `/requests` and the admin queue.

## Data

- `RequestComment` (`requestId` cascade, `authorId` cascade, `body` VarChar(2000), `fromAdmin`). `fromAdmin` is set server-side from `MANAGE_REQUESTS` at write time and never read from the body. A comment's `requestId` can change: a re-request moves the thread onto the new row (see Known limits).
- `MediaRequest.note` (the requester's original note) and `adminNote` (the decline reason) are unchanged — Discord, the iOS app and the arr push read them. The UI shows them above the thread; they are not migrated into it.
- Like `IssueMessage`, comments survive an account purge de-identified (the author row is anonymized in place, guardrail 33). A Discord merge moves a shadow account's comments to the web account; a backup covers the table.

## Who can do what

- Read and write: the requester and `MANAGE_REQUESTS` holders (ADMIN included). Nobody else — 403.
- A requester is refused (403) on a `permanentlyDeclined` request; managers are not.
- `feature.behavior.requestComments` (default ON) off ⇒ requesters are refused on read and write; managers still read and post (closing notes).
- `author.email` is selected for managers only. A name-less manager reads as "Admin" to the requester.
- 10 comments/min/user (`request-comment:`, not a protected bucket — a cheap key, guardrail 6e), `readJsonCapped` 64 KB (guardrail 30), `sanitizeText`, 2000 characters.

## Notifications

`announceRequestComment` runs after the commit (guardrail 26), best effort:

- Manager comments ⇒ the requester: Discord DM (`notifyOnComment`; when a shared notification channel is set, the post there pings them WITHOUT the comment text — every linked user reads that channel), web push (`pushOnComment`), email (`emailOnComment`, default off) and an unconditional inbox row (`REQUEST_COMMENT`, re-rendered in the reader's language from `data`).
- Requester comments ⇒ every other `MANAGE_REQUESTS` holder through the same three preferences (Discord uses the ADMIN request channel, `discordAdminRequestChannelId`, like new-request alerts — never the shared notification channel; no admin channel ⇒ no Discord ping). Managers get no inbox row.
- A manager commenting on their own request counts as the requester (managers are told, nobody is self-notified).
- The requester's row is read once and fails CLOSED: a missing or deactivated account gets nothing, the inbox included (guardrail 33).
- Every comment emits the outbound `request.comment` event (webhook / ntfy / Gotify).
- SSE `request:comment` is named under `request:` on purpose: `/api/events` delivers that prefix to the requester (userId match) and to `MANAGE_REQUESTS` holders only.
- A notification links to `/requests?comments=<id>` (the requester) or `/admin?comments=<id>` (the queue). A link without a `page` param redirects ONCE to the explicit page that holds the request (page 1 included) under the page's OWN filter and order, so a live refresh of the target URL never relocates the viewer ([request-comment-deep-link.ts](../../src/lib/request-comment-deep-link.ts)): the requester's own requests on `/requests`, the `MANAGE_REQUESTS` queue on `/admin`. A request the filter excludes opens no thread.

## Audit

Every comment writes `REQUEST_COMMENT` under `request:<id>` with the swallowing `logAudit` after the commit (guardrail 26). Details are ids and the title only — `commentId`, `fromAdmin`, `title`, `mediaType` and the requester named by `requesterAuditDetails` — never the body or an email. The action is in `REQUEST_MODERATION_ACTIONS`, so an account purge scrubs these rows by exact request id (guardrail 33).

## iOS push

Comment pushes use the `request_comment` APNs category with a generic alert (“New comment” / “There's a new comment on a request”) in every locale; the title, text and author never reach the relay in cleartext. An E2E device also gets the encrypted `/requests/<id>` deep link. **The central relay is outside this repo:** if it validates the category against a fixed list, it must learn `request_comment` or it answers 400 for it (logged by `sendApns` as a server bug, per category). The inbox row appears in the app either way.

## Known limits
- Comments are not reportable through `/api/report` (its contract is pinned by the iOS app).
- No edit or delete of a comment; deleting a request (a manager's delete, or the requester cancelling their own pending one) cascades them.
- A re-request of a non-permanently declined title replaces the DECLINED row, and its thread moves to the new request ([request-comment-carry.ts](../../src/lib/request-comment-carry.ts), on every replace path: `request-create.ts`, the bulk route, the Discord pick): the newest 500 comments, each keeping its id, author, body, `fromAdmin` and `createdAt`; nothing is re-announced (no notification, SSE or audit row). Older comments go with the declined row.
