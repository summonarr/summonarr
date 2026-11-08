// How the client session provider (summonarr-session-provider.tsx) reads
// GET /api/auth/me. Pure, so the unit suite pins it (tests/session-read.test.mts).
//
// - 401/403: the server says there is no usable session — signed out.
// - Anything else that isn't an answer — no answer at all, a 5xx while the
//   server restarts behind a proxy, a body that isn't the session — keeps the
//   session shown: a transient blip must not sign the user out of the UI.
import type { FetchJsonResult } from "@/lib/client/fetch-json";
import { v, type Infer } from "@/lib/validate";

export const MeSessionSchema = v.object({
  user: v.object({
    id: v.string(),
    role: v.string(),
    permissions: v.optional(v.string()),
    email: v.optional(v.nullable(v.string())),
    name: v.optional(v.nullable(v.string())),
    provider: v.optional(v.string()),
    mediaServer: v.optional(v.nullable(v.string())),
  }),
  expiresAt: v.optional(v.number()),
});
export const MeSchema = v.object({ session: v.nullable(MeSessionSchema) });

export type MeSession = Infer<typeof MeSessionSchema>;
export type SessionStatus = "loading" | "authenticated" | "unauthenticated";
export interface SessionState<S> {
  session: S | null;
  status: SessionStatus;
}

export function sessionAfterRead<S>(prev: SessionState<S>, res: FetchJsonResult<{ session: S | null }>): SessionState<S> {
  if (res.ok) return { session: res.data.session, status: res.data.session ? "authenticated" : "unauthenticated" };
  if (res.kind === "http" && (res.status === 401 || res.status === 403)) return { session: null, status: "unauthenticated" };
  return { session: prev.session, status: prev.session ? "authenticated" : "unauthenticated" };
}
