import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { readJsonCapped } from "@/lib/body-size";
import { logAudit, auditContext } from "@/lib/audit";
import { testRadarrConnection, testSonarrConnection } from "@/lib/arr";
import {
  type ArrService,
  type ArrInstanceConfig,
  arrSettingKey,
  isValidInstanceSlug,
  DEFAULT_ARR_INSTANCE,
  FOURK_ARR_INSTANCE,
} from "@/lib/arr-instances";
import { settleLimit } from "@/lib/concurrency";
import { buildArrInstanceRegistryWrite, getArrInstances } from "@/lib/arr-instance-registry";
import { BATCH_TX_TIMEOUT } from "@/lib/cron-auth";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { validateServerUrl, stripUrlUserinfo } from "@/lib/server-url";

// Admin management surface for the full Radarr/Sonarr instance list (multi-
// instance support): the registry metadata (slug/name/routing/access) AND each
// instance's connection Setting rows (url/apiKey/rootFolder/qualityProfileId/
// webhookSecret). The default ("") and legacy 4K ("4k") instances are managed
// here too — their connection keys are the same radarrUrl/radarr4kUrl rows the
// legacy settings surface uses, so back-compat is preserved.
//
// Secrets are never returned; the UI receives hasApiKey/hasWebhookSecret flags
// and sends the sentinel MASKED_VALUE back unchanged for a field it didn't edit.

const MASKED_VALUE = "••••••••";
// The display name renders on every "Request on <instance>" button, request-queue
// chip and admin badge; bounded like the notification-agent sibling.
const INSTANCE_NAME_MAX_LEN = 100;
// The full per-instance Setting field set — readInstanceView reads it, the save
// loop writes it, and removal cleanup deletes it, so a field added here is
// covered everywhere at once. MinimumAvailability is Radarr-meaningful and
// LanguageProfileId Sonarr-meaningful only; the unused service's key simply
// never gets a row (the UI never offers it and getCfg ignores it).
const FIELDS = ["Url", "ApiKey", "RootFolder", "QualityProfileId", "WebhookSecret", "MinimumAvailability", "LanguageProfileId", "ExternalUrl"] as const;

interface InstancePayload {
  slug: string;
  name?: string;
  restricted?: boolean;
  serverAll?: boolean;
  skipLibraryCheck?: boolean;
  autoRoute?: ArrInstanceConfig["autoRoute"];
  url?: string;
  // The browser-facing address ("Open in Radarr" links); null clears it.
  externalUrl?: string | null;
  apiKey?: string;
  rootFolder?: string;
  qualityProfileId?: number | string | null;
  webhookSecret?: string;
  // Radarr: announced | inCinemas | released; null clears (use Radarr's default).
  minimumAvailability?: string | null;
  // Sonarr v3: a language-profile id; null clears (don't send on adds).
  languageProfileId?: number | string | null;
}

interface SavePayload {
  service?: string;
  instances?: InstancePayload[];
}

async function readInstanceView(service: ArrService, instance: ArrInstanceConfig) {
  const keys = FIELDS.map((f) => arrSettingKey(service, instance.slug, f));
  const rows = await prisma.setting.findMany({ where: { key: { in: keys } } });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
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

export const GET = withAdmin(async (_req, _ctx, _session) => {
  const [radarr, sonarr] = await Promise.all([
    getArrInstances("radarr").then((list) => Promise.all(list.map((i) => readInstanceView("radarr", i)))),
    getArrInstances("sonarr").then((list) => Promise.all(list.map((i) => readInstanceView("sonarr", i)))),
  ]);
  return NextResponse.json({ radarr, sonarr });
});

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<SavePayload>(req, 64 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

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
  const instances = body.instances;
  for (const inst of instances) {
    if (typeof inst?.slug !== "string" || !isValidInstanceSlug(inst.slug)) {
      return NextResponse.json({ error: t("apiAdmin.common.invalidSlug", { slug: String(inst?.slug) }) }, { status: 400 });
    }
    // Validate BEFORE any write: the save loop below is not transactional, so a
    // mid-loop rejection would leave earlier instances' rows already applied.
    // Radarr's minimumAvailability is a closed enum — a bad stored value would
    // 400 every future add on the instance.
    if (inst.minimumAvailability !== undefined && inst.minimumAvailability !== null) {
      const v = String(inst.minimumAvailability);
      if (v !== "" && v !== "announced" && v !== "inCinemas" && v !== "released") {
        return NextResponse.json({ error: t("apiAdmin.arrInstances.invalidMinimumAvailability", { slug: inst.slug, value: String(v) }) }, { status: 400 });
      }
    }
    if (inst.languageProfileId !== undefined && inst.languageProfileId !== null && inst.languageProfileId !== "") {
      const n = Number(inst.languageProfileId);
      if (!Number.isInteger(n) || n < 1) {
        return NextResponse.json({ error: t("apiAdmin.arrInstances.invalidLanguageProfileId", { slug: inst.slug }) }, { status: 400 });
      }
    }
    // Same rule for the quality profile: getCfg drops a non-numeric stored value
    // on read, but the junk row would still be echoed by GET and render as the
    // blank "server default" choice until re-saved.
    if (inst.qualityProfileId !== undefined && inst.qualityProfileId !== null && inst.qualityProfileId !== "") {
      const n = Number(inst.qualityProfileId);
      if (!Number.isInteger(n) || n < 1) {
        return NextResponse.json({ error: t("apiAdmin.arrInstances.invalidQualityProfileId", { slug: inst.slug }) }, { status: 400 });
      }
    }
    // Same URL rules as the /api/settings and media-instances siblings: the value
    // ships out on every safeFetchAdminConfigured call, so reject a bad scheme or
    // an embedded credential here rather than storing it verbatim and echoing it
    // back on GET.
    if (typeof inst.url === "string" && inst.url.trim().length > 0) {
      const err = validateServerUrl(inst.url.trim(), {}, t);
      if (err) return NextResponse.json({ error: t("apiAdmin.arrInstances.invalidUrl", { slug: inst.slug, reason: err }) }, { status: 400 });
    }
    if (typeof inst.externalUrl === "string" && inst.externalUrl.trim().length > 0) {
      const err = validateServerUrl(inst.externalUrl.trim(), {}, t);
      if (err) return NextResponse.json({ error: t("apiAdmin.arrInstances.invalidUrl", { slug: inst.slug, reason: err }) }, { status: 400 });
    }
    if (typeof inst.name === "string" && inst.name.trim().length > INSTANCE_NAME_MAX_LEN) {
      return NextResponse.json({ error: t("apiAdmin.common.instanceNameTooLong", { slug: inst.slug, max: INSTANCE_NAME_MAX_LEN }) }, { status: 400 });
    }
  }

  // Which named slugs existed before — so removing one from the list cleans up its
  // Setting rows (dead config a de-registered instance would otherwise leave behind).
  // BUILT-INS ARE NEVER CLEANUP CANDIDATES: the default ("") and legacy 4K ("4k")
  // instances are synthesized into getArrInstances (not registry-backed) and the
  // manager UI deliberately omits them from its POST — treating their absence as
  // "removed" would wipe the radarr4k*/sonarr4k* connection Settings (including the
  // unrecoverable encrypted API key + webhook secret) on every save.
  const isNamedSlug = (slug: string) => slug !== DEFAULT_ARR_INSTANCE && slug !== FOURK_ARR_INSTANCE;
  const before = await getArrInstances(service);
  const beforeNamed = new Set(before.filter((i) => isNamedSlug(i.slug)).map((i) => i.slug));
  const nextNamed = new Set(instances.filter((i) => isNamedSlug(i.slug)).map((i) => i.slug));
  const removed = [...beforeNamed].filter((slug) => !nextNamed.has(slug));

  // Requests that still target a removed slug are STRANDED: every later approve
  // or retry resolves the instance through getCfg, which returns null once the
  // slug's Url/ApiKey rows are gone, and the [id] PATCH has no re-point path.
  // The removal is NOT refused (decommissioning a server is a legitimate
  // reason) but the count travels with it — in the response so the manager UI
  // can warn, and in the audit so the row answers "what did this strand".
  // Scoped by mediaType: the Radarr and Sonarr registries are independent, so
  // the same slug on both is the normal shape, and a MOVIE request on "anime"
  // belongs to Radarr's "anime" while a TV one belongs to Sonarr's.
  const removedInfo: Array<{ slug: string; openRequests: number }> = [];
  for (const slug of removed) {
    const openRequests = await prisma.mediaRequest.count({
      where: { arrInstance: slug, mediaType: service === "radarr" ? "MOVIE" : "TV", status: { in: ["PENDING", "APPROVED"] } },
    });
    removedInfo.push({ slug, openRequests });
  }

  // Persist registry metadata (built-ins excluded — the default ("") and legacy 4K
  // ("4k") instances are synthesized in getArrInstances, never registry-backed; a
  // "4k" entry here would shadow legacyFourKConfig(). Mirrors normalizeEntry's
  // read-side reject of both slugs.
  const registry: ArrInstanceConfig[] = instances
    .filter((i) => i.slug !== DEFAULT_ARR_INSTANCE && i.slug !== FOURK_ARR_INSTANCE)
    .map((i) => ({
      slug: i.slug,
      name: (typeof i.name === "string" ? i.name.trim() : "") || i.slug,
      restricted: i.restricted === true,
      serverAll: i.serverAll === true,
      skipLibraryCheck: i.skipLibraryCheck === true,
      autoRoute: i.autoRoute ?? null,
    }));
  // One transaction for the registry write, the per-instance connection rows and
  // the removal cleanup. Previously each statement auto-committed on its own, so
  // a failure after the registry commit left the instance de-registered while its
  // Setting rows and wanted/available cache rows survived — and unrecoverably so,
  // because the cleanup is diff-driven: only the request that sees the registry
  // stop listing a slug treats it as removed, and that request had already
  // committed. The next attempt reads a `before` that no longer contains it.
  // Mirrors the media-instances route. Network I/O stays outside (below).
  const registryWrite = buildArrInstanceRegistryWrite(service, registry);
  const removedCounts: Record<string, { wantedItems: number; availableItems: number; trashApplications: number }> = {};
  await prisma.$transaction(async (tx) => {
  await tx.setting.upsert({
    where: { key: registryWrite.key },
    create: registryWrite,
    update: { value: registryWrite.value },
  });

  // Write each instance's connection Setting rows. Skip a secret field left at the
  // mask sentinel (unchanged); an explicit "" clears the row.
  for (const inst of instances) {
    const set = async (field: (typeof FIELDS)[number], value: string | undefined, isSecret: boolean) => {
      if (value === undefined) return;
      if (isSecret && value === MASKED_VALUE) return;
      // Encryption fires in the Prisma extension (guardrail 7a) — never here.
      await tx.setting.upsert({
        where: { key: arrSettingKey(service, inst.slug, field) },
        create: { key: arrSettingKey(service, inst.slug, field), value },
        update: { value },
      });
    };
    await set("Url", typeof inst.url === "string" ? inst.url.trim() : undefined, false);
    await set(
      "ExternalUrl",
      inst.externalUrl === undefined ? undefined : inst.externalUrl === null ? "" : String(inst.externalUrl).trim(),
      false,
    );
    await set("ApiKey", inst.apiKey, true);
    await set("RootFolder", typeof inst.rootFolder === "string" ? inst.rootFolder : undefined, false);
    // null = explicit clear (the UI sends null for an emptied field); undefined = untouched.
    await set(
      "QualityProfileId",
      inst.qualityProfileId === undefined ? undefined : inst.qualityProfileId === null ? "" : String(inst.qualityProfileId),
      false,
    );
    // Same null-clears semantics; values were validated up front with the slugs
    // (and getCfg drops invalid stored values on read, as defense in depth).
    await set(
      "MinimumAvailability",
      inst.minimumAvailability === undefined ? undefined : inst.minimumAvailability === null ? "" : String(inst.minimumAvailability),
      false,
    );
    await set(
      "LanguageProfileId",
      inst.languageProfileId === undefined ? undefined : inst.languageProfileId === null ? "" : String(inst.languageProfileId),
      false,
    );
    await set("WebhookSecret", inst.webhookSecret, true);
  }

  // Clean up rows for removed named instances — the Setting keys AND the
  // slug's wanted/available cache rows. Without the latter, a de-registered
  // instance's rows were unreachable by every writer (no sync path targets a
  // removed slug — its scoped deleteMany never fires again) while the
  // availability attach reads them unscoped, so its titles read "in arr"
  // forever. Mirrors the media-instances route's removal cleanup (guardrail
  // 35); like it, this is not retroactive for slugs removed before the fix.
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
    removedCounts[slug] = { wantedItems: wanted.count, availableItems: available.count, trashApplications: trash.count };
  }
  }, { timeout: BATCH_TX_TIMEOUT });

  // Connection tests for every instance that now has url + apiKey. Bounded — the
  // instance list is admin-sized but still input-scaled (guardrail 31).
  const testResults: Record<string, { version?: string; error?: string }> = {};
  const configured = await getArrInstances(service);
  await settleLimit(configured, 4, async (inst) => {
    const rows = await prisma.setting.findMany({
      where: { key: { in: [arrSettingKey(service, inst.slug, "Url"), arrSettingKey(service, inst.slug, "ApiKey")] } },
    });
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const url = map[arrSettingKey(service, inst.slug, "Url")];
    const apiKey = map[arrSettingKey(service, inst.slug, "ApiKey")];
    if (!url || !apiKey) return;
    try {
      const version = service === "radarr"
        ? await testRadarrConnection(url, apiKey)
        : await testSonarrConnection(url, apiKey);
      testResults[inst.slug] = { version };
    } catch {
      testResults[inst.slug] = { error: t("apiAdmin.arrInstances.connectionFailed", { service }) };
    }
  });

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SETTINGS_CHANGE",
    target: `arr-instances:${service}`,
    // Records what the removal destroyed and stranded, like the media sibling.
    details: { service, instances: instances.map((i) => i.slug), removed: removedInfo, removedCounts },
    ...auditContext(req, session),
  });

  const view = await Promise.all(configured.map((i) => readInstanceView(service, i)));
  // `removed` is additive (the iOS app decodes this response): one entry per
  // de-registered slug with the PENDING/APPROVED requests it left behind.
  return NextResponse.json({ ok: true, instances: view, testResults, removed: removedInfo });
});
