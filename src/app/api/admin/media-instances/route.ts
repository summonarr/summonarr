import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma, type PrismaTxClient } from "@/lib/prisma";
import { readJsonCapped } from "@/lib/body-size";
import { logAudit, auditContext } from "@/lib/audit";
import { pingPlexToken, getPlexMachineId, checkPlexServerAccess, PLEX_IDENTITY_TIMEOUT_MS } from "@/lib/plex";
import { getJellyfinUserCount } from "@/lib/jellyfin";
import { type MediaServerService, type PlexSettingField, type JellyfinSettingField, DEFAULT_MEDIA_INSTANCE, MEDIA_INSTANCE_NAME_MAX_LEN, isValidMediaInstanceSlug, mediaInstanceSlugCollidesWithDefault, plexSettingKey, jellyfinSettingKey } from "@/lib/media-instances";
import { settleLimit } from "@/lib/concurrency";
import { type MediaInstanceConfig, getMediaInstances, buildMediaInstanceRegistryWrite, readMediaInstanceRegistryForSave } from "@/lib/media-instance-registry";
import { SECRET_MASK_SENTINEL } from "@/lib/secret-mask";
import { BATCH_TX_TIMEOUT } from "@/lib/batch-write";
import { validateServerUrl, stripUrlUserinfo } from "@/lib/server-url";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { upstreamStatusKey } from "@/lib/never-watched-data";
import { invalidateNeverWatchedReport } from "@/lib/never-watched-report";

// Admin management surface for the full Plex/Jellyfin instance list (multi-
// server support): the registry metadata (slug/name — deliberately thin, see
// media-instance-registry.ts) AND each instance's connection Setting rows. The
// default ("") instance is managed here too — its connection keys are the same
// plexServerUrl/jellyfinUrl rows the legacy settings surface uses, so
// back-compat is preserved; PlexConnectForm/JellyfinSyncForm keep working
// unmodified.
//
// Scope: the connection fields needed for sync/sign-in (Plex:
// ServerUrl/AdminToken/AdminEmail; Jellyfin: Url/ApiKey/RestrictSignIn), the
// per-server library selection, and the per-server Movie/Tv path-strip
// prefixes. The prefixes have DELETE-on-blank semantics (see setStripPrefix
// below): an absent Setting row means "inherit the default server's prefix"
// (the ?? fallback in bad-matches.ts / admin/library), and an upserted ""
// row would silently shadow that fallback with "no prefix". Removal cleanup
// covers the WHOLE field union, so no field can be orphaned.
//
// This route — not /api/settings — owns every per-instance key, mirroring the
// arr multi-instance split (/api/admin/arr-instances). /api/settings validates
// against a static ALLOWED_KEYS literal that cannot enumerate admin-defined
// slugs, and silently drops (200, no write) anything it doesn't recognize; the
// default instance's own keys stay with /api/settings unchanged.
//
// Secrets are never returned; the UI receives a hasSecret flag and sends
// SECRET_MASK_SENTINEL back unchanged for a field it didn't edit.
//
// A save replaces the whole list. GET and POST hand out a `version` per service
// (a hash of the named instances as GET shows them); a POST that sends it back
// as `baseVersion` is refused with a 409 and no write when the stored list has
// changed since, so a stale tab can't delete a server added elsewhere (and its
// library, sessions and watch-sync pairs with it). Without `baseVersion` the
// save is unconditional, as before.

// The display name renders on the server picker, availability badges and admin
// chips; bounded like the arr-instances and notification-agent siblings. The
// registry truncates to the same constant on read.
const INSTANCE_NAME_MAX_LEN = MEDIA_INSTANCE_NAME_MAX_LEN;
// A Plex token or Jellyfin API key is a few dozen characters (a plex.tv JWT a
// few hundred); this bounds a paste error, not a real credential.
const SECRET_MAX_LEN = 4096;
// The free-text fields (address, library ids, path prefixes, e-mail) are short
// by nature; the cap bounds a paste error stored verbatim in a Setting row.
const FREE_TEXT_MAX_LEN = 2048;

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
  // App-written, not admin-editable — but still this instance's key, so removing
  // the instance must take it too or the row is orphaned forever (nothing else
  // ever writes a de-registered slug's keys).
  ServerReachable: true,
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
  // Comma-joined library ids/section keys to sync from THIS server. Omit to
  // leave untouched; "" clears the selection, which means "sync all libraries".
  // Per-server because a Plex section key is only meaningful on the server it
  // came from — see the orchestrator, where one shared selection silently
  // ingested the wrong sections from every non-default instance.
  libraries?: string;
  restricted?: boolean; // gate this server's library behind a per-user view grant
  // Per-server Movie/Tv path-strip prefixes for bad-match/library-diff path
  // normalization. Omit to leave untouched; "" DELETES the row so the server
  // goes back to inheriting the default instance's prefix (an empty-string row
  // would shadow that fallback — the resolver reads `named ?? default`).
  moviePathStripPrefix?: string;
  tvPathStripPrefix?: string;
}

interface SavePayload {
  service?: string;
  instances?: InstancePayload[];
  // The `version` from the GET/POST this list was edited from; optional.
  baseVersion?: unknown;
}

// The interactive-tx client of the EXTENDED prisma (the generated
// Prisma.TransactionClient is not assignable to it — see account-lifecycle.ts).
type TxClient = PrismaTxClient;

const PLEX_VIEW_FIELDS: PlexSettingField[] = ["ServerUrl", "AdminToken", "AdminEmail", "Libraries", "MoviePathStripPrefix", "TvPathStripPrefix"];
const JELLYFIN_VIEW_FIELDS: JellyfinSettingField[] = ["Url", "ApiKey", "RestrictSignIn", "Libraries", "MoviePathStripPrefix", "TvPathStripPrefix"];

// Same parse as isJellyfinSignInAllowed (auth.ts): fail-CLOSED, so a missing row
// reads as restricted. The GET view must report that default rather than `false`,
// or the toggle would render "off" for an instance that is actually enforcing.
function readRestrictSignIn(value: string | undefined): boolean {
  return (value ?? "true").trim().toLowerCase() !== "false";
}

// Every listed instance's view from ONE Setting read, so the same code serves
// the GET, the in-transaction staleness check (one query at a time, guardrail
// 23c) and the POST response.
async function readInstanceViews(db: Pick<TxClient, "setting">, service: MediaServerService, instances: MediaInstanceConfig[]) {
  if (instances.length === 0) return [];
  const keys = instances.flatMap((i) =>
    service === "plex"
      ? PLEX_VIEW_FIELDS.map((f) => plexSettingKey(i.slug, f))
      : JELLYFIN_VIEW_FIELDS.map((f) => jellyfinSettingKey(i.slug, f)),
  );
  const rows = await db.setting.findMany({ where: { key: { in: keys } } });
  const map: Record<string, string> = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return instances.map((i) => instanceView(service, i.slug, i.name, i.restricted, map));
}

// What a client edits from: the named instances only — the default has its own
// form, and a change there must not refuse a manager's save.
function instancesVersion(views: ReturnType<typeof instanceView>[]): string {
  return createHash("sha256").update(JSON.stringify(views.filter((v) => v.slug !== DEFAULT_MEDIA_INSTANCE))).digest("hex");
}

// `restricted` is echoed straight from the registry entry (not a Setting row):
// the manager UI round-trips this view back through POST, so omitting it here
// would make every save silently clear the flag.
function instanceView(service: MediaServerService, slug: string, name: string, restricted: boolean, map: Record<string, string>) {
  if (service === "plex") {
    return {
      slug,
      name,
      restricted,
      // Redacted like the /api/settings GET: never echo an embedded credential
      // (older rows may predate the write-time URL check in POST below).
      serverUrl: stripUrlUserinfo(map[plexSettingKey(slug, "ServerUrl")] ?? ""),
      adminEmail: map[plexSettingKey(slug, "AdminEmail")] ?? "",
      hasAdminToken: !!map[plexSettingKey(slug, "AdminToken")],
      libraries: map[plexSettingKey(slug, "Libraries")] ?? "",
      // Absent row reads as "" — indistinguishable from an inherited default on
      // the wire, which matches the write side: saving "" deletes the row.
      moviePathStripPrefix: map[plexSettingKey(slug, "MoviePathStripPrefix")] ?? "",
      tvPathStripPrefix: map[plexSettingKey(slug, "TvPathStripPrefix")] ?? "",
    };
  }
  return {
    slug,
    name,
    restricted,
    url: stripUrlUserinfo(map[jellyfinSettingKey(slug, "Url")] ?? ""),
    hasApiKey: !!map[jellyfinSettingKey(slug, "ApiKey")],
    restrictSignIn: readRestrictSignIn(map[jellyfinSettingKey(slug, "RestrictSignIn")]),
    libraries: map[jellyfinSettingKey(slug, "Libraries")] ?? "",
    moviePathStripPrefix: map[jellyfinSettingKey(slug, "MoviePathStripPrefix")] ?? "",
    tvPathStripPrefix: map[jellyfinSettingKey(slug, "TvPathStripPrefix")] ?? "",
  };
}

export const GET = withAdmin(async (_req, _ctx, _session) => {
  const [plex, jellyfin] = await Promise.all([
    getMediaInstances("plex").then((list) => readInstanceViews(prisma, "plex", list)),
    getMediaInstances("jellyfin").then((list) => readInstanceViews(prisma, "jellyfin", list)),
  ]);
  // `versions` is additive: clients that decode only the two lists are unaffected.
  return NextResponse.json({ plex, jellyfin, versions: { plex: instancesVersion(plex), jellyfin: instancesVersion(jellyfin) } });
});

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<SavePayload>(req, 64 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const save = validateSave(parsed, t);
  if (save instanceof NextResponse) return save;
  const { service, instances, baseVersion } = save;

  // Registry metadata (built-in default excluded — synthesized in
  // getMediaInstances, never registry-backed; a "" entry here would shadow it).
  // Serialized through the registry module's own normalizer so this in-tx write
  // can't drift from what the readers parse.
  const isNamedSlug = (slug: string) => slug !== DEFAULT_MEDIA_INSTANCE;
  const nextNamed = new Set(instances.filter((i) => isNamedSlug(i.slug)).map((i) => i.slug));
  const registryWrite = buildMediaInstanceRegistryWrite(
    service,
    instances
      .filter((i) => isNamedSlug(i.slug))
      .map((i) => ({
        slug: i.slug,
        name: (typeof i.name === "string" ? i.name.trim() : "") || i.slug,
        // Strict === true, matching the registry normalizer. The default ("")
        // is filtered out above and is never restrictable (guardrail 35).
        restricted: i.restricted === true,
      })),
  );

  // ONE transaction for the registry write, the connection-Setting writes AND
  // the removal cleanup. The registry JSON and the library rows must not
  // diverge: no sync path ever targets a de-registered slug again, so if the
  // registry commits while the delete doesn't, that server's library rows are
  // orphaned forever — still counted by the admin dashboard and stats, with
  // nothing left to retry the cleanup (guardrail 35). BATCH_TX_TIMEOUT because
  // a single library deleteMany can span 25k+ rows.
  //
  // Guardrail 23: nothing in here catches a write error. A failure propagates,
  // the whole transaction rolls back, and the route 500s — the admin retries
  // against unchanged state. Every query is awaited in turn (23c).
  let removed: string[] = [];
  let reservedSlug: string | null = null;
  let secretRebindSlug: string | null = null;
  const removedCounts: Record<string, RemovedCounts> = {};
  const outcome = await prisma.$transaction(async (tx) => {
    // Which named slugs existed before — so removing one from the list cleans
    // up its rows. The set difference is the only signal that a removal
    // happened, so this read is taken HERE, under the per-service save lock and
    // ahead of the registry write — never before the transaction, where a save
    // committing in between was lost: a slug it added was overwritten without
    // its rows ever being cleaned up, and one it re-added lost its token to this
    // save's cleanup. The default ("") is never a cleanup candidate: it's
    // synthesized (this read returns named entries only) and the manager UI
    // omits it from its POST — treating its absence as "removed" would wipe the
    // base plexServerUrl/jellyfinUrl connection Settings and the whole default
    // server's library cache.
    const before = await readMediaInstanceRegistryForSave(tx, service);
    // The list the client edited is not the one stored: refuse before any write.
    if (typeof baseVersion === "string" && instancesVersion(await readInstanceViews(tx, service, before)) !== baseVersion) {
      return "stale" as const;
    }
    // Even without a version: "keep the saved token" for a named server that is
    // not registered means the client's list is stale (another save removed it,
    // and its token, meanwhile). Re-adding it would register a server with none.
    const registered = new Set(before.map((i) => i.slug));
    if (instances.some((i) => isNamedSlug(i.slug) && !registered.has(i.slug) && (i.adminToken === SECRET_MASK_SENTINEL || i.apiKey === SECRET_MASK_SENTINEL))) {
      return "stale" as const;
    }
    // A NEW slug whose derived keys equal a default-server key (e.g. "movie" →
    // plexMoviePathStripPrefix) would read and overwrite the main server's
    // settings. One already registered stays accepted, so a list saved before
    // this check can still be edited.
    // A kept secret must not follow a CHANGED address: the connection test below
    // would send the stored token to the new host. A changed URL needs the
    // secret typed again.
    secretRebindSlug = await findSecretRebind(tx, service, instances);
    if (secretRebindSlug !== null) return "secretRebind" as const;
    reservedSlug = instances.find((i) => isNamedSlug(i.slug) && !registered.has(i.slug) && mediaInstanceSlugCollidesWithDefault(i.slug))?.slug ?? null;
    if (reservedSlug !== null) return "reserved" as const;
    removed = before.map((i) => i.slug).filter((slug) => !nextNamed.has(slug));

    // The registry row is the first WRITE: its row lock is what orders this
    // removal against an upstream watch refresh in flight (stillRegisteredInTx
    // in upstream-watch-data.ts locks the same row before writing a slug's
    // evidence or status, so it never re-creates them for a removed slug).
    await tx.setting.upsert({
      where: { key: registryWrite.key },
      create: registryWrite,
      update: { value: registryWrite.value },
    });

    for (const inst of instances) await writeInstanceSettings(tx, service, inst);
    for (const slug of removed) removedCounts[slug] = await cleanUpRemovedInstance(tx, service, slug);
    return "saved" as const;
  }, { timeout: BATCH_TX_TIMEOUT });
  if (outcome === "reserved") {
    return NextResponse.json({ error: t("apiAdmin.mediaInstances.slugReserved", { slug: reservedSlug ?? "" }) }, { status: 400 });
  }
  if (outcome === "secretRebind") {
    return NextResponse.json({ error: t("apiAdmin.mediaInstances.secretNeededForNewUrl", { slug: secretRebindSlug ?? "" }) }, { status: 400 });
  }
  if (outcome === "stale") {
    return NextResponse.json({ error: t("apiAdmin.common.instancesChanged", { service: service === "plex" ? "Plex" : "Jellyfin" }) }, { status: 409 });
  }
  // A removal changed the never-watched report's inputs (library rows, evidence,
  // the coverage rows); the cached report must not outlive it (guardrail 14d).
  if (removed.length > 0) invalidateNeverWatchedReport();

  // Connection tests run outside the transaction: network I/O must never hold
  // a DB transaction open.
  const configured = await getMediaInstances(service);
  const testResults = await testConnections(service, configured, t);

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

  const view = await readInstanceViews(prisma, service, configured);
  // `version` is additive: the client's next `baseVersion`.
  return NextResponse.json({ ok: true, instances: view, testResults, version: instancesVersion(view) });
});

// The save request, refused at its first bad field: the service, the list
// itself, the optional version, and each instance's slug (valid and listed
// once), secrets, server URL and name.
function validateSave(
  body: SavePayload,
  t: Translator,
): { service: MediaServerService; instances: InstancePayload[]; baseVersion: string | undefined } | NextResponse {
  const bad = (error: string) => NextResponse.json({ error }, { status: 400 });
  const service = body.service;
  if (service !== "plex" && service !== "jellyfin") return bad(t("apiAdmin.mediaInstances.servicePlexOrJellyfin"));
  // Require the array explicitly — see the identical rationale in
  // admin/arr-instances/route.ts: coercing a missing/malformed `instances` to
  // [] reads downstream as "remove every named instance" and deletes their
  // Setting rows, including an unrecoverable encrypted token/key — and now
  // their library rows too.
  if (!Array.isArray(body.instances)) return bad(t("apiAdmin.common.instancesArray"));
  if (body.baseVersion !== undefined && typeof body.baseVersion !== "string") return bad(t("apiAdmin.common.invalidBody"));
  const instances = body.instances;
  const seen = new Set<string>();
  for (const inst of instances) {
    if (typeof inst?.slug !== "string" || !isValidMediaInstanceSlug(inst.slug)) {
      return bad(t("apiAdmin.common.invalidSlug", { slug: String(inst?.slug) }));
    }
    // A slug listed twice: each entry's Setting writes run in turn, so the
    // last one silently won while the registry kept the first.
    if (seen.has(inst.slug)) return bad(t("apiAdmin.common.duplicateSlug", { slug: inst.slug }));
    seen.add(inst.slug);
    // The token/key goes to a String column as sent: anything but a string (a
    // number, null, an object) failed inside the transaction as a 500.
    for (const [field, value] of [["adminToken", inst.adminToken], ["apiKey", inst.apiKey]] as const) {
      if (value !== undefined && (typeof value !== "string" || value.length > SECRET_MAX_LEN)) {
        return bad(t("apiAdmin.common.invalidSecret", { slug: inst.slug, field, max: SECRET_MAX_LEN }));
      }
    }
    // Same URL rules as the /api/settings sibling: the value ships out on every
    // safeFetchAdminConfigured call, so reject a bad scheme or an embedded
    // credential here rather than storing it verbatim and echoing it back.
    const rawUrl = service === "plex" ? inst.serverUrl : inst.url;
    if (typeof rawUrl === "string" && rawUrl.trim().length > 0) {
      const err = validateServerUrl(rawUrl.trim(), {}, t);
      if (err) return bad(t("apiAdmin.mediaInstances.invalidServerUrl", { slug: inst.slug, reason: err }));
    }
    for (const [field, value] of [["adminEmail", inst.adminEmail], ["libraries", inst.libraries], ["moviePathStripPrefix", inst.moviePathStripPrefix], ["tvPathStripPrefix", inst.tvPathStripPrefix], ["address", rawUrl]] as const) {
      if (typeof value === "string" && value.length > FREE_TEXT_MAX_LEN) {
        return bad(t("apiAdmin.mediaInstances.fieldTooLong", { slug: inst.slug, field, max: FREE_TEXT_MAX_LEN }));
      }
    }
    if (typeof inst.name === "string" && inst.name.trim().length > INSTANCE_NAME_MAX_LEN) {
      return bad(t("apiAdmin.common.instanceNameTooLong", { slug: inst.slug, max: INSTANCE_NAME_MAX_LEN }));
    }
  }
  return { service, instances, baseVersion: body.baseVersion };
}

function withoutTrailingSlashes(url: string): string {
  const v = url.trim();
  let end = v.length;
  while (end > 0 && v.charCodeAt(end - 1) === 47) end--;
  return v.slice(0, end);
}
const sameServerUrl = (a: string, b: string) => withoutTrailingSlashes(a) === withoutTrailingSlashes(b);

// The first instance saved with the mask sentinel for its secret AND a server
// address different from the stored one, read one query at a time (guardrail
// 23c). Null when every kept secret still points at the same server.
async function findSecretRebind(tx: TxClient, service: MediaServerService, instances: InstancePayload[]): Promise<string | null> {
  for (const inst of instances) {
    const secret = service === "plex" ? inst.adminToken : inst.apiKey;
    const nextUrl = trimmedString(service === "plex" ? inst.serverUrl : inst.url);
    if (secret !== SECRET_MASK_SENTINEL || !nextUrl) continue;
    const urlKey = service === "plex" ? plexSettingKey(inst.slug, "ServerUrl") : jellyfinSettingKey(inst.slug, "Url");
    const stored = await tx.setting.findUnique({ where: { key: urlKey }, select: { value: true } });
    // No stored address means the kept secret was never pointed anywhere yet.
    if (stored && !sameServerUrl(stored.value, nextUrl)) return inst.slug;
  }
  return null;
}

const trimmedString = (v: unknown): string | undefined => (typeof v === "string" ? v.trim() : undefined);
const rawString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// One instance's connection Setting rows. Skip a secret field left at the mask
// sentinel (unchanged); an explicit "" clears the row. Encryption fires in the
// Prisma extension (isSensitiveSettingKey matches plex<Slug>AdminToken /
// jellyfin<Slug>ApiKey) — never at this call site (guardrail 7a).
async function writeInstanceSettings(tx: TxClient, service: MediaServerService, inst: InstancePayload): Promise<void> {
  const set = async (key: string, value: string | undefined, isSecret: boolean) => {
    if (value === undefined) return;
    if (isSecret && value === SECRET_MASK_SENTINEL) return;
    await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  };
  // Strip prefixes are the one field where "" must DELETE the row rather than
  // store it: the read side (stripResolver in bad-matches.ts / admin/library)
  // falls back `cfg[named] ?? cfg[default]`, so an empty-string row is not
  // "unset" — it shadows the default server's prefix with "strip nothing".
  // Deleting restores inheritance; a non-empty value overrides it. (An
  // explicit no-strip override isn't expressible, and doesn't need to be:
  // stripping is a conditional startsWith, so an inherited prefix that
  // doesn't match this server's paths is already a no-op.)
  const setStripPrefix = async (key: string, value: string | undefined) => {
    if (value === undefined) return;
    const trimmed = value.trim();
    if (trimmed === "") await tx.setting.deleteMany({ where: { key } });
    else await tx.setting.upsert({ where: { key }, create: { key, value: trimmed }, update: { value: trimmed } });
  };
  if (service === "plex") {
    await set(plexSettingKey(inst.slug, "ServerUrl"), trimmedString(inst.serverUrl), false);
    await set(plexSettingKey(inst.slug, "AdminToken"), inst.adminToken, true);
    await set(plexSettingKey(inst.slug, "AdminEmail"), trimmedString(inst.adminEmail), false);
    await set(plexSettingKey(inst.slug, "Libraries"), trimmedString(inst.libraries), false);
    await setStripPrefix(plexSettingKey(inst.slug, "MoviePathStripPrefix"), rawString(inst.moviePathStripPrefix));
    await setStripPrefix(plexSettingKey(inst.slug, "TvPathStripPrefix"), rawString(inst.tvPathStripPrefix));
  } else {
    await set(jellyfinSettingKey(inst.slug, "Url"), trimmedString(inst.url), false);
    await set(jellyfinSettingKey(inst.slug, "ApiKey"), inst.apiKey, true);
    await set(jellyfinSettingKey(inst.slug, "RestrictSignIn"), typeof inst.restrictSignIn === "boolean" ? String(inst.restrictSignIn) : undefined, false);
    await set(jellyfinSettingKey(inst.slug, "Libraries"), trimmedString(inst.libraries), false);
    await setStripPrefix(jellyfinSettingKey(inst.slug, "MoviePathStripPrefix"), rawString(inst.moviePathStripPrefix));
    await setStripPrefix(jellyfinSettingKey(inst.slug, "TvPathStripPrefix"), rawString(inst.tvPathStripPrefix));
  }
}

type RemovedCounts = { libraryItems: number; activeSessions: number; serverUsersDisabled: number; watchSyncPairs: number };

// Clean up everything a removed named instance owned, in the save's transaction.
async function cleanUpRemovedInstance(tx: TxClient, service: MediaServerService, slug: string): Promise<RemovedCounts> {
  // The connection/ancillary keys AND the upstream watch-record status
  // (guardrail 14d). A status left behind is inherited by a server later
  // registered under the same slug: it reads "ok" for up to 7 days before
  // that server's own first refresh, lifting the cleanup's upstreamUnchecked
  // hold on evidence it never produced. It can't collide with the default's
  // key (the slug is its own segment), so no default-key filter is needed.
  await tx.setting.deleteMany({
    where: { key: { in: [...instanceSettingKeys(service, slug), upstreamStatusKey(service, slug)] } },
  });
  // The server's own watch-record snapshot: derived rows its next refresh
  // would rebuild, but nothing ever refreshes a de-registered slug again.
  await tx.upstreamWatchEvidence.deleteMany({ where: { source: service, serverInstance: slug } });
  // Each identity's titles read from this server's own history for For You
  // (guardrail 40c), and how far they were read. Derived from a server that
  // is gone; a server later re-added under this slug starts a fresh import
  // instead of adding its whole history on top of the old rows.
  await tx.serverWatchedTitle.deleteMany({ where: { mediaServerUser: { source: service, serverInstance: slug } } });
  await tx.serverWatchCursor.deleteMany({ where: { mediaServerUser: { source: service, serverInstance: slug } } });
  // Watch-sync pairs with an account on this server (guardrail 19e). Their
  // read points and ledgers (Plex ratingKeys are per server) describe a
  // server that is gone, and a server later registered under this slug
  // would inherit them. The ledgers go with the pair (onDelete: Cascade).
  // Nothing is unmarked on either server.
  const watchSyncPairs = await tx.watchSyncPair.deleteMany({
    where: service === "plex"
      ? { plexUser: { source: "plex", serverInstance: slug } }
      : { jellyfinUser: { source: "jellyfin", serverInstance: slug } },
  });

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

  return { libraryItems: library.count, activeSessions: sessions.count, serverUsersDisabled: serverUsers.count, watchSyncPairs: watchSyncPairs.count };
}

type ConnectionTest = { ok?: boolean; error?: string };

// Connection tests for every instance that has its required fields, from ONE
// Setting read. Bounded — the instance list is admin-sized but still
// input-scaled (guardrail 31). Every instance is tested, not only the edited
// ones: the manager shows each server's status after a save.
async function testConnections(service: MediaServerService, configured: MediaInstanceConfig[], t: Translator): Promise<Record<string, ConnectionTest>> {
  const keysOf = (slug: string) =>
    service === "plex"
      ? { url: plexSettingKey(slug, "ServerUrl"), secret: plexSettingKey(slug, "AdminToken") }
      : { url: jellyfinSettingKey(slug, "Url"), secret: jellyfinSettingKey(slug, "ApiKey") };
  const rows = configured.length === 0
    ? []
    : await prisma.setting.findMany({ where: { key: { in: configured.flatMap((i) => Object.values(keysOf(i.slug))) } } });
  const values = new Map(rows.map((r) => [r.key, r.value]));

  const testResults: Record<string, ConnectionTest> = {};
  await settleLimit(configured, 4, async (inst) => {
    const keys = keysOf(inst.slug);
    const url = values.get(keys.url);
    const secret = values.get(keys.secret);
    if (!url || !secret) return;
    testResults[inst.slug] = service === "plex" ? await testPlex(url, secret, t) : await testJellyfin(url, secret, t);
  });
  return testResults;
}

async function testPlex(serverUrl: string, token: string, t: Translator): Promise<ConnectionTest> {
  try {
    const ok = await pingPlexToken(token);
    if (!ok) return { error: t("apiAdmin.mediaInstances.plexTokenCheckFailed") };
    // pingPlexToken only proves the TOKEN is valid at plex.tv — it never
    // touches the entered ServerUrl, so a wrong or unreachable server used
    // to report "Connected". Probe the server itself. getPlexMachineId
    // swallows every error and returns null, so null IS the failure signal.
    const machineId = await getPlexMachineId(serverUrl, token, PLEX_IDENTITY_TIMEOUT_MS);
    if (!machineId) return { error: t("apiAdmin.mediaInstances.plexUnreachable") };
    // /identity answers UNAUTHENTICATED on PMS, so a reachable server with
    // a token that has no access to it still read "Connected". One
    // authorized probe discriminates token-vs-server problems.
    const access = await checkPlexServerAccess(serverUrl, token);
    if (access === "ok") return { ok: true };
    if (access === "unauthorized") return { error: t("apiAdmin.mediaInstances.plexTokenNotAuthorized") };
    return { error: t("apiAdmin.mediaInstances.plexUnreachable") };
  } catch {
    return { error: t("apiAdmin.mediaInstances.plexConnectionFailed") };
  }
}

async function testJellyfin(url: string, apiKey: string, t: Translator): Promise<ConnectionTest> {
  try {
    await getJellyfinUserCount(url, apiKey);
    return { ok: true };
  } catch {
    return { error: t("apiAdmin.common.jellyfinConnectionFailed") };
  }
}
