import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma, type PrismaTxClient } from "@/lib/prisma";
import { readJsonCapped } from "@/lib/body-size";
import { auditActor, logAudit } from "@/lib/audit";
import { testRadarrConnection, testSonarrConnection } from "@/lib/arr";
import {
  type ArrService,
  type ArrInstanceConfig,
  ARR_SETTING_FIELDS,
  arrSettingKey,
  DEFAULT_ARR_INSTANCE,
  FOURK_ARR_INSTANCE,
} from "@/lib/arr-instances";
import { connectionChanged, connectionWrites, instancePayloadError, type InstancePayload } from "@/lib/arr-instances-save";
import { settleLimit } from "@/lib/concurrency";
import { buildArrInstanceRegistryWrite, getArrInstances, readArrInstanceRegistryForSave } from "@/lib/arr-instance-registry";
import { SECRET_MASK_SENTINEL } from "@/lib/secret-mask";
import { BATCH_TX_TIMEOUT } from "@/lib/batch-write";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { stripUrlUserinfo } from "@/lib/server-url";
import { clearArrSnapshots } from "@/lib/arr-snapshot";
import { invalidateShow4kVisibilityCache } from "@/lib/four-k-visibility";

// Admin management surface for the full Radarr/Sonarr instance list (multi-
// instance support): the registry metadata (slug/name/routing/access) AND each
// instance's connection Setting rows (url/apiKey/rootFolder/qualityProfileId/
// webhookSecret). The default ("") and legacy 4K ("4k") instances are managed
// here too — their connection keys are the same radarrUrl/radarr4kUrl rows the
// legacy settings surface uses, so back-compat is preserved.
//
// Secrets are never returned; the UI receives hasApiKey/hasWebhookSecret flags
// and sends SECRET_MASK_SENTINEL back unchanged for a field it didn't edit.
//
// A save replaces the whole list. GET and POST hand out a `version` per service
// (a hash of the named instances as GET shows them); a POST that sends it back
// as `baseVersion` is refused with a 409 and no write when the stored list has
// changed since, so a stale tab can't delete an instance added elsewhere or put
// back another admin's edited fields. Without `baseVersion` (older clients) the
// save is unconditional, as before.

// The full per-instance Setting field set — the view reads it, the save loop
// writes it, and removal cleanup deletes it, so a field added in arr-instances.ts
// is covered everywhere at once. MinimumAvailability is Radarr-meaningful and
// LanguageProfileId Sonarr-meaningful only; the unused service's key simply
// never gets a row (the UI never offers it and getCfg ignores it).
const FIELDS = ARR_SETTING_FIELDS;

interface SavePayload {
  service?: string;
  instances?: InstancePayload[];
  // The `version` from the GET/POST this list was edited from; optional.
  baseVersion?: unknown;
}

// The interactive-tx client of the EXTENDED prisma (the generated
// Prisma.TransactionClient is not assignable to it — see account-lifecycle.ts).
type TxClient = PrismaTxClient;

const isNamedSlug = (slug: string) => slug !== DEFAULT_ARR_INSTANCE && slug !== FOURK_ARR_INSTANCE;

// Every listed instance's view from ONE Setting read, so the same code serves
// the GET, the in-transaction staleness check (one query at a time, guardrail
// 23c) and the POST response.
async function readInstanceViews(db: Pick<TxClient, "setting">, service: ArrService, instances: ArrInstanceConfig[]) {
  if (instances.length === 0) return [];
  const keys = instances.flatMap((i) => FIELDS.map((f) => arrSettingKey(service, i.slug, f)));
  const rows = await db.setting.findMany({ where: { key: { in: keys } } });
  const map: Record<string, string> = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return instances.map((i) => instanceView(service, i, map));
}

// What a client edits from: the named instances only, since the built-ins have
// their own forms and a change there must not refuse a manager's save.
function instancesVersion(views: ReturnType<typeof instanceView>[]): string {
  return createHash("sha256").update(JSON.stringify(views.filter((v) => isNamedSlug(v.slug)))).digest("hex");
}

function instanceView(service: ArrService, instance: ArrInstanceConfig, map: Record<string, string>) {
  return {
    slug: instance.slug,
    name: instance.name,
    restricted: instance.restricted,
    serverAll: instance.serverAll,
    skipLibraryCheck: instance.skipLibraryCheck,
    autoRoute: instance.autoRoute,
    // Redacted like the media-instances and /api/settings GETs: never echo an
    // embedded credential (older rows may predate the write-time URL check in
    // POST below).
    url: stripUrlUserinfo(map[arrSettingKey(service, instance.slug, "Url")] ?? ""),
    externalUrl: stripUrlUserinfo(map[arrSettingKey(service, instance.slug, "ExternalUrl")] ?? ""),
    rootFolder: map[arrSettingKey(service, instance.slug, "RootFolder")] ?? "",
    qualityProfileId: map[arrSettingKey(service, instance.slug, "QualityProfileId")] ?? "",
    minimumAvailability: map[arrSettingKey(service, instance.slug, "MinimumAvailability")] ?? "",
    languageProfileId: map[arrSettingKey(service, instance.slug, "LanguageProfileId")] ?? "",
    hasApiKey: !!map[arrSettingKey(service, instance.slug, "ApiKey")],
    hasWebhookSecret: !!map[arrSettingKey(service, instance.slug, "WebhookSecret")],
  };
}

type RemovedInfo = { slug: string; openRequests: number };
type RemovedCounts = Record<string, { wantedItems: number; availableItems: number; trashApplications: number }>;
type SaveOutcome =
  | { kind: "stale" }
  | { kind: "saved"; removed: RemovedInfo[]; removedCounts: RemovedCounts; retest: Set<string> };

// The body's service and instance list, checked whole before anything is
// written, or the 400 to answer.
function parseSaveBody(
  body: SavePayload,
  t: Translator,
): { service: ArrService; instances: InstancePayload[]; baseVersion: string | undefined } | NextResponse {
  const service = body.service;
  if (service !== "radarr" && service !== "sonarr") {
    return NextResponse.json({ error: t("apiAdmin.common.serviceRadarrOrSonarr") }, { status: 400 });
  }
  // Require the array explicitly. Coercing a missing/malformed `instances` to []
  // reads downstream as "the admin removed every named instance" and deleteMany's
  // their Setting rows — including the encrypted API keys and webhook secrets,
  // which are unrecoverable. A body that doesn't say is not a body that means
  // "delete everything".
  if (!Array.isArray(body.instances)) {
    return NextResponse.json({ error: t("apiAdmin.common.instancesArray") }, { status: 400 });
  }
  if (body.baseVersion !== undefined && typeof body.baseVersion !== "string") {
    return NextResponse.json({ error: t("apiAdmin.common.invalidBody") }, { status: 400 });
  }
  for (const inst of body.instances as unknown[]) {
    const error = instancePayloadError(inst, t);
    if (error) return NextResponse.json({ error }, { status: 400 });
  }
  return { service, instances: body.instances as InstancePayload[], baseVersion: body.baseVersion };
}

// Persist registry metadata (built-ins excluded — the default ("") and legacy 4K
// ("4k") instances are synthesized in getArrInstances, never registry-backed; a
// "4k" entry here would shadow legacyFourKConfig(). Mirrors normalizeEntry's
// read-side reject of both slugs.
function registryEntries(instances: InstancePayload[]): ArrInstanceConfig[] {
  return instances
    .filter((i) => isNamedSlug(i.slug))
    .map((i) => ({
      slug: i.slug,
      name: (typeof i.name === "string" ? i.name.trim() : "") || i.slug,
      restricted: i.restricted === true,
      serverAll: i.serverAll === true,
      skipLibraryCheck: i.skipLibraryCheck === true,
      autoRoute: i.autoRoute ?? null,
    }));
}

// Requests that still target a removed slug are STRANDED: every later approve
// or retry resolves the instance through getCfg, which returns null once the
// slug's Url/ApiKey rows are gone, and the [id] PATCH has no re-point path.
// The removal is NOT refused (decommissioning a server is a legitimate
// reason) but the count travels with it — in the response so the manager UI
// can warn, and in the audit so the row answers "what did this strand".
// Scoped by mediaType: the Radarr and Sonarr registries are independent, so
// the same slug on both is the normal shape, and a MOVIE request on "anime"
// belongs to Radarr's "anime" while a TV one belongs to Sonarr's.
async function strandedRequests(tx: TxClient, service: ArrService, removed: string[]): Promise<RemovedInfo[]> {
  const out: RemovedInfo[] = [];
  for (const slug of removed) {
    const openRequests = await tx.mediaRequest.count({
      where: { arrInstance: slug, mediaType: service === "radarr" ? "MOVIE" : "TV", status: { in: ["PENDING", "APPROVED"] } },
    });
    out.push({ slug, openRequests });
  }
  return out;
}

// Writes each posted instance's connection Setting rows (connectionWrites:
// a secret left at the mask is untouched, "" clears a row) and answers the
// slugs whose address or key this save changed — the ones worth a connection
// test. The stored Url/ApiKey are read first, in one query.
async function writeConnections(tx: TxClient, service: ArrService, instances: InstancePayload[]): Promise<Set<string>> {
  const keyOf = (slug: string, field: "Url" | "ApiKey") => arrSettingKey(service, slug, field);
  const before = await tx.setting.findMany({
    where: { key: { in: instances.flatMap((i) => [keyOf(i.slug, "Url"), keyOf(i.slug, "ApiKey")]) } },
  });
  const stored = new Map(before.map((r) => [r.key, r.value]));
  const retest = new Set<string>();
  for (const inst of instances) {
    const writes = connectionWrites(inst);
    if (connectionChanged(writes, { url: stored.get(keyOf(inst.slug, "Url")), apiKey: stored.get(keyOf(inst.slug, "ApiKey")) })) {
      retest.add(inst.slug);
    }
    for (const { field, value } of writes) {
      // Encryption fires in the Prisma extension (guardrail 7a) — never here.
      const key = arrSettingKey(service, inst.slug, field);
      await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
    }
  }
  return retest;
}

// Clean up rows for removed named instances — the Setting keys AND the
// slug's wanted/available cache rows. Without the latter, a de-registered
// instance's rows were unreachable by every writer (no sync path targets a
// removed slug — its scoped deleteMany never fires again) while the
// availability attach reads them unscoped, so its titles read "in arr"
// forever. Mirrors the media-instances route's removal cleanup (guardrail
// 35); like it, this is not retroactive for slugs removed before the fix.
async function removeInstanceRows(tx: TxClient, service: ArrService, removed: string[]): Promise<RemovedCounts> {
  const counts: RemovedCounts = {};
  for (const slug of removed) {
    await tx.setting.deleteMany({
      where: { key: { in: FIELDS.map((f) => arrSettingKey(service, slug, f)) } },
    });
    const [wanted, available] = service === "radarr"
      ? [
          await tx.radarrWantedItem.deleteMany({ where: { arrInstance: slug } }),
          await tx.radarrAvailableItem.deleteMany({ where: { arrInstance: slug } }),
        ]
      : [
          await tx.sonarrWantedItem.deleteMany({ where: { arrInstance: slug } }),
          await tx.sonarrAvailableItem.deleteMany({ where: { arrInstance: slug } }),
        ];
    // TRaSH applications are per-instance CACHE, not history: recordApply
    // upserts them on every apply and they mirror what was pushed upstream.
    // Left behind, they resurrect on a REUSED slug — listSpecs would report a
    // stale remoteId as "applied" to a different server, and buildProfileBody
    // would treat the spec as satisfied and skip re-creating the custom format,
    // embedding a remoteId that does not exist there into a live profile push.
    // (IssueGrab also carries arrInstance but is deliberately NOT deleted — it
    // is a per-action record that already cascades from its Issue.)
    //
    // Scoped to THIS service through the TrashSpec relation: TrashApplication
    // has no service column of its own, and the Radarr and Sonarr registries
    // are independent, so the same slug on both is the normal shape. An
    // unscoped delete here wiped Sonarr "anime"'s applications when Radarr
    // "anime" was removed — listSpecs then reported every CF "not applied"
    // and the next apply re-created them upstream as duplicates. Same
    // relation filter the trash.ts readers use.
    const trash = await tx.trashApplication.deleteMany({
      where: { arrInstance: slug, trashSpec: { service: service === "radarr" ? "RADARR" : "SONARR" } },
    });
    counts[slug] = { wantedItems: wanted.count, availableItems: available.count, trashApplications: trash.count };
  }
  return counts;
}

// One transaction for the registry write, the per-instance connection rows and
// the removal cleanup. Previously each statement auto-committed on its own, so
// a failure after the registry commit left the instance de-registered while its
// Setting rows and wanted/available cache rows survived — and unrecoverably so,
// because the cleanup is diff-driven: only the request that sees the registry
// stop listing a slug treats it as removed, and that request had already
// committed. The next attempt reads a `before` that no longer contains it.
// Mirrors the media-instances route. Network I/O stays outside.
//
// Guardrail 23: nothing in here catches a write error; a failure propagates,
// the whole transaction rolls back and the route 500s. Every query is awaited
// in turn (23c).
function saveInstanceList(service: ArrService, instances: InstancePayload[], baseVersion: string | undefined): Promise<SaveOutcome> {
  const registry = registryEntries(instances);
  const nextNamed = new Set(registry.map((i) => i.slug));
  const registryWrite = buildArrInstanceRegistryWrite(service, registry);
  return prisma.$transaction(async (tx): Promise<SaveOutcome> => {
    // Which named slugs existed before — so removing one from the list cleans up its
    // Setting rows (dead config a de-registered instance would otherwise leave behind).
    // Read HERE, under the per-service save lock, never before the transaction: a
    // save that committed in between (an instance added in another tab) was
    // otherwise overwritten without being "removed", orphaning its rows.
    // BUILT-INS ARE NEVER CLEANUP CANDIDATES: the default ("") and legacy 4K ("4k")
    // instances are synthesized into getArrInstances (not registry-backed — this
    // read returns named entries only) and the manager UI deliberately omits them
    // from its POST — treating their absence as "removed" would wipe the
    // radarr4k*/sonarr4k* connection Settings (including the unrecoverable
    // encrypted API key + webhook secret) on every save.
    const before = await readArrInstanceRegistryForSave(tx, service);
    // The list the client edited is not the one stored: refuse before any write.
    if (baseVersion !== undefined && instancesVersion(await readInstanceViews(tx, service, before)) !== baseVersion) {
      return { kind: "stale" };
    }
    // Even without a version: "keep the saved secret" for a named instance that
    // is not registered means the client's list is stale (another save removed
    // it meanwhile). Re-adding it would register an instance with no API key.
    const registered = new Set(before.map((i) => i.slug));
    if (instances.some((i) => isNamedSlug(i.slug) && !registered.has(i.slug) && (i.apiKey === SECRET_MASK_SENTINEL || i.webhookSecret === SECRET_MASK_SENTINEL))) {
      return { kind: "stale" };
    }
    const removedSlugs = before.map((i) => i.slug).filter((slug) => !nextNamed.has(slug));
    const removed = await strandedRequests(tx, service, removedSlugs);
    await tx.setting.upsert({
      where: { key: registryWrite.key },
      create: registryWrite,
      update: { value: registryWrite.value },
    });
    const retest = await writeConnections(tx, service, instances);
    const removedCounts = await removeInstanceRows(tx, service, removedSlugs);
    return { kind: "saved", removed, removedCounts, retest };
  }, { timeout: BATCH_TX_TIMEOUT });
}

// The connection a test talks to, for each slug, from one Setting read; an
// instance missing its address or key is not tested.
async function readConnections(service: ArrService, slugs: string[]): Promise<Array<{ slug: string; url: string; apiKey: string }>> {
  if (slugs.length === 0) return [];
  const rows = await prisma.setting.findMany({
    where: { key: { in: slugs.flatMap((slug) => [arrSettingKey(service, slug, "Url"), arrSettingKey(service, slug, "ApiKey")]) } },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return slugs.flatMap((slug) => {
    const url = map.get(arrSettingKey(service, slug, "Url"));
    const apiKey = map.get(arrSettingKey(service, slug, "ApiKey"));
    return url && apiKey ? [{ slug, url, apiKey }] : [];
  });
}

async function connectionTestResult(service: ArrService, conn: { url: string; apiKey: string }, t: Translator): Promise<{ version?: string; error?: string }> {
  try {
    const version = service === "radarr"
      ? await testRadarrConnection(conn.url, conn.apiKey)
      : await testSonarrConnection(conn.url, conn.apiKey);
    return { version };
  } catch {
    return { error: t("apiAdmin.arrInstances.connectionFailed", { service }) };
  }
}

export const GET = withAdmin(async (_req, _ctx, _session) => {
  const [radarr, sonarr] = await Promise.all([
    getArrInstances("radarr").then((list) => readInstanceViews(prisma, "radarr", list)),
    getArrInstances("sonarr").then((list) => readInstanceViews(prisma, "sonarr", list)),
  ]);
  // `versions` is additive: clients that decode only the two lists are unaffected.
  return NextResponse.json({ radarr, sonarr, versions: { radarr: instancesVersion(radarr), sonarr: instancesVersion(sonarr) } });
});

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<SavePayload>(req, 64 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parseSaveBody(parsed, t);
  if (body instanceof NextResponse) return body;
  const { service, instances, baseVersion } = body;

  const outcome = await saveInstanceList(service, instances, baseVersion);
  if (outcome.kind === "stale") {
    return NextResponse.json({ error: t("apiAdmin.common.instancesChanged", { service: service === "radarr" ? "Radarr" : "Sonarr" }) }, { status: 409 });
  }

  // Connection tests for the instances whose address or key this save changed
  // (and that now have both): a save that only renames or re-routes waits on
  // no upstream, and an unreachable instance nobody touched can't stretch every
  // save to its timeout. Bounded — the list is admin-sized but still
  // input-scaled (guardrail 31).
  const testResults: Record<string, { version?: string; error?: string }> = {};
  const configured = await getArrInstances(service);
  const toTest = configured.map((i) => i.slug).filter((slug) => outcome.retest.has(slug));
  await settleLimit(await readConnections(service, toTest), 4, async (conn) => {
    testResults[conn.slug] = await connectionTestResult(service, conn, t);
  });

  // The registry changed (an instance added, removed or re-pointed): the admin
  // arr pages' snapshots may name an instance that is gone (guardrail 5h).
  clearArrSnapshots();
  // A 4K instance added or removed shows on the next page, not after the 10 s hold.
  invalidateShow4kVisibilityCache();

  void logAudit({
    ...auditActor(req, session),
    action: "SETTINGS_CHANGE",
    target: `arr-instances:${service}`,
    // Records what the removal destroyed and stranded, like the media sibling.
    details: { service, instances: instances.map((i) => i.slug), removed: outcome.removed, removedCounts: outcome.removedCounts },
  });

  const view = await readInstanceViews(prisma, service, configured);
  // `removed` and `version` are additive (the iOS app decodes this response):
  // one entry per de-registered slug with the PENDING/APPROVED requests it left
  // behind, and the list's version for the client's next `baseVersion`.
  return NextResponse.json({ ok: true, instances: view, testResults, removed: outcome.removed, version: instancesVersion(view) });
});
