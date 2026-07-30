import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { readJsonCapped } from "@/lib/body-size";
import { logAudit, auditContext } from "@/lib/audit";
import { pingPlexToken, getPlexMachineId, PLEX_IDENTITY_TIMEOUT_MS } from "@/lib/plex";
import { getJellyfinUserCount } from "@/lib/jellyfin";
import { type MediaServerService, type PlexSettingField, type JellyfinSettingField, DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug, plexSettingKey, jellyfinSettingKey } from "@/lib/media-instances";
import { settleLimit } from "@/lib/concurrency";
import { getMediaInstances, buildMediaInstanceRegistryWrite } from "@/lib/media-instance-registry";
import { BATCH_TX_TIMEOUT } from "@/lib/cron-auth";

// Admin management surface for the full Plex/Jellyfin instance list (multi-
// server support): the registry metadata (slug/name — deliberately thin, see
// media-instance-registry.ts) AND each instance's connection Setting rows. The
// default ("") instance is managed here too — its connection keys are the same
// plexServerUrl/jellyfinUrl rows the legacy settings surface uses, so
// back-compat is preserved; PlexConnectForm/JellyfinSyncForm keep working
// unmodified.
//
// Scope: the core connection fields needed for sync/sign-in (Plex:
// ServerUrl/AdminToken/AdminEmail; Jellyfin: Url/ApiKey/RestrictSignIn).
// Library pickers and path-strip-prefix fields need a live per-server
// library-sections fetch and are a deliberately later UI sub-step — their
// Setting keys already exist (media-instances.ts's field types), just not
// written from here yet. Removal cleanup covers the WHOLE field union
// regardless, so an unwritten field can never be orphaned either.
//
// This route — not /api/settings — owns every per-instance key, mirroring the
// arr multi-instance split (/api/admin/arr-instances). /api/settings validates
// against a static ALLOWED_KEYS literal that cannot enumerate admin-defined
// slugs, and silently drops (200, no write) anything it doesn't recognize; the
// default instance's own keys stay with /api/settings unchanged.
//
// Secrets are never returned; the UI receives a hasSecret flag and sends the
// sentinel MASKED_VALUE back unchanged for a field it didn't edit.

const MASKED_VALUE = "••••••••";

// EVERY per-instance Setting field a service owns. Removing an instance must
// delete ALL of them: the cleanup used to drop only the connection pair, so
// Libraries / *PathStripPrefix / RestrictSignIn rows survived deregistration —
// orphaned forever, and silently inherited by a future instance re-created
// under the same slug. Declared as a Record over the field union so adding a
// field in media-instances.ts fails the build here until it's covered.
const PLEX_INSTANCE_FIELDS: Record<PlexSettingField, true> = {
  ServerUrl: true,
  AdminToken: true,
  AdminEmail: true,
  Libraries: true,
  PathStripPrefix: true,
  MoviePathStripPrefix: true,
  TvPathStripPrefix: true,
};
const JELLYFIN_INSTANCE_FIELDS: Record<JellyfinSettingField, true> = {
  Url: true,
  ApiKey: true,
  Libraries: true,
  PathStripPrefix: true,
  MoviePathStripPrefix: true,
  TvPathStripPrefix: true,
  RestrictSignIn: true,
};

// Every Setting key a named instance can own — used to clean up on removal.
//
// Subtracting the DEFAULT instance's own key set is load-bearing, not
// defensive: `instanceKeySegment` capitalizes only the slug's first character,
// so a slug whose name matches a field prefix collides with a default key.
// `plexSettingKey("movie", "PathStripPrefix")` and
// `plexSettingKey("", "MoviePathStripPrefix")` are both
// "plexMoviePathStripPrefix" — and "movie"/"tv" are admissible slugs. Without
// this filter, removing an instance named "movie" would delete the DEFAULT
// server's movie path-strip prefix, silently changing its path normalization.
function instanceSettingKeys(service: MediaServerService, slug: string): string[] {
  const fields = service === "plex"
    ? (Object.keys(PLEX_INSTANCE_FIELDS) as PlexSettingField[])
    : (Object.keys(JELLYFIN_INSTANCE_FIELDS) as JellyfinSettingField[]);
  const derive = (s: string, f: string) =>
    service === "plex"
      ? plexSettingKey(s, f as PlexSettingField)
      : jellyfinSettingKey(s, f as JellyfinSettingField);
  const defaultKeys = new Set(fields.map((f) => derive(DEFAULT_MEDIA_INSTANCE, f)));
  return fields.map((f) => derive(slug, f)).filter((k) => !defaultKeys.has(k));
}

interface InstancePayload {
  slug: string;
  name?: string;
  serverUrl?: string; // Plex
  adminToken?: string; // Plex, secret
  adminEmail?: string; // Plex
  url?: string; // Jellyfin
  apiKey?: string; // Jellyfin, secret
  restrictSignIn?: boolean; // Jellyfin — omit to leave the stored value untouched
}

interface SavePayload {
  service?: string;
  instances?: InstancePayload[];
}

// Same parse as isJellyfinSignInAllowed (auth.ts): fail-CLOSED, so a missing row
// reads as restricted. The GET view must report that default rather than `false`,
// or the toggle would render "off" for an instance that is actually enforcing.
function readRestrictSignIn(value: string | undefined): boolean {
  return (value ?? "true").trim().toLowerCase() !== "false";
}

async function readInstanceView(service: MediaServerService, slug: string, name: string) {
  if (service === "plex") {
    const keys = [plexSettingKey(slug, "ServerUrl"), plexSettingKey(slug, "AdminToken"), plexSettingKey(slug, "AdminEmail")];
    const rows = await prisma.setting.findMany({ where: { key: { in: keys } } });
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      slug,
      name,
      serverUrl: map[plexSettingKey(slug, "ServerUrl")] ?? "",
      adminEmail: map[plexSettingKey(slug, "AdminEmail")] ?? "",
      hasAdminToken: !!map[plexSettingKey(slug, "AdminToken")],
    };
  }
  const keys = [jellyfinSettingKey(slug, "Url"), jellyfinSettingKey(slug, "ApiKey"), jellyfinSettingKey(slug, "RestrictSignIn")];
  const rows = await prisma.setting.findMany({ where: { key: { in: keys } } });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    slug,
    name,
    url: map[jellyfinSettingKey(slug, "Url")] ?? "",
    hasApiKey: !!map[jellyfinSettingKey(slug, "ApiKey")],
    restrictSignIn: readRestrictSignIn(map[jellyfinSettingKey(slug, "RestrictSignIn")]),
  };
}

export const GET = withAdmin(async (_req, _ctx, _session) => {
  const [plex, jellyfin] = await Promise.all([
    getMediaInstances("plex").then((list) => Promise.all(list.map((i) => readInstanceView("plex", i.slug, i.name)))),
    getMediaInstances("jellyfin").then((list) => Promise.all(list.map((i) => readInstanceView("jellyfin", i.slug, i.name)))),
  ]);
  return NextResponse.json({ plex, jellyfin });
});

export const POST = withAdmin(async (req, _ctx, session) => {
  const parsed = await readJsonCapped<SavePayload>(req, 64 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const service = body.service;
  if (service !== "plex" && service !== "jellyfin") {
    return NextResponse.json({ error: "service must be plex or jellyfin" }, { status: 400 });
  }
  // Require the array explicitly — see the identical rationale in
  // admin/arr-instances/route.ts: coercing a missing/malformed `instances` to
  // [] reads downstream as "remove every named instance" and deletes their
  // Setting rows, including an unrecoverable encrypted token/key — and now
  // their library rows too.
  if (!Array.isArray(body.instances)) {
    return NextResponse.json({ error: "instances must be an array" }, { status: 400 });
  }
  const instances = body.instances;
  for (const inst of instances) {
    if (typeof inst?.slug !== "string" || !isValidMediaInstanceSlug(inst.slug)) {
      return NextResponse.json({ error: `invalid instance slug: ${inst?.slug}` }, { status: 400 });
    }
  }

  // Which named slugs existed before — so removing one from the list cleans up
  // its rows. This read MUST stay ahead of the registry write: the set
  // difference is the only signal that a removal happened. The default ("") is
  // never a cleanup candidate: it's synthesized (not registry-backed) and the
  // manager UI omits it from its POST — treating its absence as "removed" would
  // wipe the base plexServerUrl/jellyfinUrl connection Settings and the whole
  // default server's library cache.
  const isNamedSlug = (slug: string) => slug !== DEFAULT_MEDIA_INSTANCE;
  const before = await getMediaInstances(service);
  const beforeNamed = new Set(before.filter((i) => isNamedSlug(i.slug)).map((i) => i.slug));
  const nextNamed = new Set(instances.filter((i) => isNamedSlug(i.slug)).map((i) => i.slug));
  const removed = [...beforeNamed].filter((slug) => !nextNamed.has(slug));

  // Registry metadata (built-in default excluded — synthesized in
  // getMediaInstances, never registry-backed; a "" entry here would shadow it).
  // Serialized through the registry module's own normalizer so the in-tx write
  // below can't drift from saveMediaInstances().
  const registryWrite = buildMediaInstanceRegistryWrite(
    service,
    instances
      .filter((i) => i.slug !== DEFAULT_MEDIA_INSTANCE)
      .map((i) => ({ slug: i.slug, name: typeof i.name === "string" && i.name.trim() ? i.name : i.slug })),
  );

  // ONE transaction for the registry write, the connection-Setting writes AND
  // the removal cleanup. The registry JSON and the library rows must not
  // diverge: availability readers union PlexLibraryItem/JellyfinLibraryItem
  // across every serverInstance with no filter, and no sync path ever targets a
  // de-registered slug again — so if the registry commits while the delete
  // doesn't, that server's entire catalogue reads "In Plex"/"In Jellyfin"
  // FOREVER, with nothing left to retry the cleanup. BATCH_TX_TIMEOUT because a
  // single library deleteMany can span 25k+ rows.
  //
  // Guardrail 23: nothing in here catches a write error. A failure propagates,
  // the whole transaction rolls back, and the route 500s — the admin retries
  // against unchanged state.
  const removedCounts: Record<string, { libraryItems: number; activeSessions: number; serverUsersDisabled: number }> = {};
  await prisma.$transaction(async (tx) => {
    await tx.setting.upsert({
      where: { key: registryWrite.key },
      create: registryWrite,
      update: { value: registryWrite.value },
    });

    // Write each instance's connection Setting rows. Skip a secret field left at
    // the mask sentinel (unchanged); an explicit "" clears the row. Encryption
    // fires in the Prisma extension (isSensitiveSettingKey matches
    // plex<Slug>AdminToken / jellyfin<Slug>ApiKey) — never at this call site
    // (guardrail 7a).
    const set = async (key: string, value: string | undefined, isSecret: boolean) => {
      if (value === undefined) return;
      if (isSecret && value === MASKED_VALUE) return;
      await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
    };
    for (const inst of instances) {
      if (service === "plex") {
        await set(plexSettingKey(inst.slug, "ServerUrl"), typeof inst.serverUrl === "string" ? inst.serverUrl.trim() : undefined, false);
        await set(plexSettingKey(inst.slug, "AdminToken"), inst.adminToken, true);
        await set(plexSettingKey(inst.slug, "AdminEmail"), typeof inst.adminEmail === "string" ? inst.adminEmail.trim() : undefined, false);
      } else {
        await set(jellyfinSettingKey(inst.slug, "Url"), typeof inst.url === "string" ? inst.url.trim() : undefined, false);
        await set(jellyfinSettingKey(inst.slug, "ApiKey"), inst.apiKey, true);
        await set(jellyfinSettingKey(inst.slug, "RestrictSignIn"), typeof inst.restrictSignIn === "boolean" ? String(inst.restrictSignIn) : undefined, false);
      }
    }

    // Clean up everything a removed named instance owned.
    for (const slug of removed) {
      await tx.setting.deleteMany({ where: { key: { in: instanceSettingKeys(service, slug) } } });

      // Library rows: a pure derived cache, rebuilt from scratch if the server is
      // ever re-added. Leaving them is the headline bug this cleanup exists for.
      const library =
        service === "plex"
          ? await tx.plexLibraryItem.deleteMany({ where: { serverInstance: slug } })
          : await tx.jellyfinLibraryItem.deleteMany({ where: { serverInstance: slug } });

      // Live-playback rows: ephemeral state whose only writers (the 5s poller,
      // the Plex SSE manager map) iterate the REGISTERED instances, so nothing
      // will ever observe this slug again and a stranded row would render on the
      // admin now-playing card forever. This deliberately discards an in-flight
      // watch that would otherwise have finalized into PlayHistory — acceptable
      // for a server the admin just removed.
      const sessions = await tx.activeSession.deleteMany({ where: { source: service, serverInstance: slug } });

      // Server users: SOFT-delete only (guardrail 28). PlayHistory and
      // ActiveSession FK this table onDelete: Restrict, so a hard delete would
      // throw on any row that holds history — and history is server/usage data
      // that must outlive the server's removal (guardrail 19: the live poller is
      // its sole writer, nothing can rebuild it). PlayHistory itself is left
      // completely untouched here for the same reason.
      const serverUsers = await tx.mediaServerUser.updateMany({
        where: { source: service, serverInstance: slug },
        data: { active: false },
      });

      removedCounts[slug] = { libraryItems: library.count, activeSessions: sessions.count, serverUsersDisabled: serverUsers.count };
    }
  }, { timeout: BATCH_TX_TIMEOUT });

  // Connection tests for every instance that now has its required fields.
  // Bounded — the instance list is admin-sized but still input-scaled (guardrail 31).
  // Outside the transaction: network I/O must never hold a DB transaction open.
  const testResults: Record<string, { ok?: boolean; error?: string }> = {};
  const configured = await getMediaInstances(service);
  await settleLimit(configured, 4, async (inst) => {
    if (service === "plex") {
      const rows = await prisma.setting.findMany({
        where: { key: { in: [plexSettingKey(inst.slug, "ServerUrl"), plexSettingKey(inst.slug, "AdminToken")] } },
      });
      const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      const token = map[plexSettingKey(inst.slug, "AdminToken")];
      const serverUrl = map[plexSettingKey(inst.slug, "ServerUrl")];
      if (!serverUrl || !token) return;
      try {
        const ok = await pingPlexToken(token);
        if (!ok) {
          testResults[inst.slug] = { error: "Plex token check failed" };
          return;
        }
        // pingPlexToken only proves the TOKEN is valid at plex.tv — it never
        // touches the entered ServerUrl, so a wrong or unreachable server used
        // to report "Connected". Probe the server itself. getPlexMachineId
        // swallows every error and returns null, so null IS the failure signal.
        const machineId = await getPlexMachineId(serverUrl, token, PLEX_IDENTITY_TIMEOUT_MS);
        testResults[inst.slug] = machineId ? { ok: true } : { error: "Plex server unreachable" };
      } catch {
        testResults[inst.slug] = { error: "Plex connection failed" };
      }
    } else {
      const rows = await prisma.setting.findMany({
        where: { key: { in: [jellyfinSettingKey(inst.slug, "Url"), jellyfinSettingKey(inst.slug, "ApiKey")] } },
      });
      const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      const url = map[jellyfinSettingKey(inst.slug, "Url")];
      const apiKey = map[jellyfinSettingKey(inst.slug, "ApiKey")];
      if (!url || !apiKey) return;
      try {
        await getJellyfinUserCount(url, apiKey);
        testResults[inst.slug] = { ok: true };
      } catch {
        testResults[inst.slug] = { error: "Jellyfin connection failed" };
      }
    }
  });

  // Post-commit audit — logAudit (the swallowing variant), never logAuditOrFail:
  // the destructive cleanup is already durable, so a failed audit write must not
  // turn a successful removal into a 500 (guardrail 26). Records what was
  // destroyed so an operator can see it after the fact.
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SETTINGS_CHANGE",
    target: `media-instances:${service}`,
    details: { service, instances: instances.map((i) => i.slug), removed, removedCounts },
    ...auditContext(req, session),
  });

  const view = await Promise.all(configured.map((i) => readInstanceView(service, i.slug, i.name)));
  return NextResponse.json({ ok: true, instances: view, testResults });
});
