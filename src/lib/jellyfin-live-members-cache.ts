// A short-lived cache over getLiveJellyfinUsers for the admin Activity users
// page: its Active/Removed filter asked every Jellyfin server for its /Users
// on every render, so one slow server stalled the page each time the admin
// changed the sort or the search. Plex membership is cached the same way
// (plex-membership.ts). Process-wide (guardrail 27a), and concurrent renders
// share one read.
import { processSingleton } from "./process-singleton";
import { getLiveJellyfinUsers } from "./jellyfin-live-members";

export const LIVE_JELLYFIN_USERS_TTL_MS = 60_000;

type LiveUsers = Awaited<ReturnType<typeof getLiveJellyfinUsers>>;

const state = processSingleton("jellyfin-live-members:cache", () => ({
  value: null as { at: number; users: LiveUsers } | null,
  inflight: null as Promise<LiveUsers> | null,
}));

export async function getCachedLiveJellyfinUsers(): Promise<LiveUsers> {
  const cached = state.value;
  if (cached && Date.now() - cached.at < LIVE_JELLYFIN_USERS_TTL_MS) return cached.users;
  if (!state.inflight) {
    state.inflight = getLiveJellyfinUsers()
      .then((users) => {
        // An answer with no server in it means every server was unreadable;
        // don't keep that for a minute, ask again next time.
        if (users.size > 0) state.value = { at: Date.now(), users };
        return users;
      })
      .finally(() => {
        state.inflight = null;
      });
  }
  return state.inflight;
}

/** Tests only: forget the cached answer. */
export function __resetLiveJellyfinUsersCacheForTests(): void {
  state.value = null;
  state.inflight = null;
}
