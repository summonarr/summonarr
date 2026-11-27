// Revoking the per-user grants of a de-registered instance, inside the removal's
// own transaction. A grant is keyed by slug alone and holds no identity of the
// server it was made for, so one left behind is inherited by whatever server is
// later registered under that slug (guardrails 32 and 35).
//
// One UPDATE per slug, removing just that key (`#-`) on the rows that hold it:
// a read-then-write of the whole column would overwrite a grant edit to another
// slug that committed in between. A column that is not an object, or holds no
// such key, is left alone.
import { Prisma } from "@/generated/prisma";
import type { PrismaTxClient } from "./prisma";
import type { MediaServerService } from "./media-instances";

type GrantTx = Pick<PrismaTxClient, "$executeRaw">;

// User.mediaServerGrants[service][slug] — the visibility grants of one removed
// Plex/Jellyfin server. Returns how many accounts lost one.
export function revokeMediaServerGrantsInTx(tx: GrantTx, service: MediaServerService, slug: string): Promise<number> {
  return tx.$executeRaw(Prisma.sql`UPDATE "User" SET "mediaServerGrants" = "mediaServerGrants" #- ARRAY[${service}, ${slug}]::text[] WHERE "mediaServerGrants" #> ARRAY[${service}, ${slug}]::text[] IS NOT NULL`);
}

// User.instanceGrants[slug] — the request/auto-approve grants of a named
// Radarr/Sonarr slug. That map is NOT per service: one "anime" entry covers
// Radarr "anime" and Sonarr "anime" alike, so the caller revokes only a slug
// neither service registers any more (slugsRegisteredNowhereInTx).
export function revokeArrInstanceGrantsInTx(tx: GrantTx, slug: string): Promise<number> {
  return tx.$executeRaw(Prisma.sql`UPDATE "User" SET "instanceGrants" = "instanceGrants" #- ARRAY[${slug}]::text[] WHERE "instanceGrants" #> ARRAY[${slug}]::text[] IS NOT NULL`);
}
