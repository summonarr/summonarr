import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: string;
      provider?: string;
      // Identifies which media server authenticated this user (e.g. "plex", "jellyfin")
      mediaServer?: string | null;
    } & DefaultSession["user"];

    // Unix timestamp; isTokenExpired() checks this to force re-auth on expiry
    tokenExpiresAt?: number;
    // References AuthSession table row for per-device session tracking and revocation
    sessionId?: string;
  }
}
