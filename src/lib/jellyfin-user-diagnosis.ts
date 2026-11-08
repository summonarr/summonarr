// Why the Jellyfin user sync would skip a user — the pure half of
// GET /api/admin/server-users/diagnose. Reads the raw /Users answer field by
// field, so a malformed entry is reported rather than dropped.

export type SkipReason = "missing-id" | "empty-name" | "missing-name" | "no-policy";

// One user as the diagnosis reports it. The email is masked for skipped AND
// processed rows alike — the skipped ones are exactly what gets pasted into a
// bug report.
export interface DiagnosedUser {
  id: string | null;
  name: string | null;
  email: string | null;
  isAdmin: boolean | null;
  isDisabled: boolean | null;
  isHidden: boolean | null;
  downloadsEnabled: boolean | null;
  wouldBeSkipped: boolean;
  skipReasons: SkipReason[];
}

export type UsersResponseShape = "array" | "QueryResult{Items}" | "unknown" | `unexpected:${string}`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// The user list however the body came back: a bare array (current Jellyfin) or
// a QueryResult `{ Items }`. Anything else is an empty list with its shape named.
export function readUsersBody(raw: unknown): { items: unknown[]; responseShape: UsersResponseShape } {
  if (Array.isArray(raw)) return { items: raw, responseShape: "array" };
  if (isRecord(raw) && Array.isArray(raw.Items)) return { items: raw.Items, responseShape: "QueryResult{Items}" };
  if (raw !== null) return { items: [], responseShape: `unexpected:${typeof raw}` };
  return { items: [], responseShape: "unknown" };
}

function maskEmail(email: string | null): string | null {
  return email ? `${email.slice(0, 3)}…` : null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

// Reasons are stable machine codes (not prose, not translated): the route is
// curl/OpenAPI-only and the codes are what a bug report gets grepped for.
export function diagnoseJellyfinUser(raw: unknown): DiagnosedUser {
  const u = isRecord(raw) ? raw : {};
  const id = str(u.Id);
  const name = str(u.Name);
  const policy = isRecord(u.Policy) ? u.Policy : null;
  const skipReasons: SkipReason[] = [];
  if (!id) skipReasons.push("missing-id");
  if (!name) skipReasons.push(name === "" ? "empty-name" : "missing-name");
  if (!policy) skipReasons.push("no-policy");
  return {
    id,
    name,
    email: maskEmail(str(u.Email)),
    isAdmin: bool(policy?.IsAdministrator),
    isDisabled: bool(policy?.IsDisabled),
    isHidden: bool(policy?.IsHidden),
    downloadsEnabled: bool(policy?.EnableContentDownloading),
    wouldBeSkipped: skipReasons.length > 0,
    skipReasons,
  };
}
