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
import { getArrInstances, saveArrInstances } from "@/lib/arr-instance-registry";

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
const FIELDS = ["Url", "ApiKey", "RootFolder", "QualityProfileId", "WebhookSecret"] as const;

interface InstancePayload {
  slug: string;
  name?: string;
  restricted?: boolean;
  serverAll?: boolean;
  skipLibraryCheck?: boolean;
  autoRoute?: ArrInstanceConfig["autoRoute"];
  url?: string;
  apiKey?: string;
  rootFolder?: string;
  qualityProfileId?: number | string | null;
  webhookSecret?: string;
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
    url: map[arrSettingKey(service, instance.slug, "Url")] ?? "",
    rootFolder: map[arrSettingKey(service, instance.slug, "RootFolder")] ?? "",
    qualityProfileId: map[arrSettingKey(service, instance.slug, "QualityProfileId")] ?? "",
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

// Upsert a Setting row; encryption for the secret keys fires in the Prisma
// extension (isSensitiveSettingKey matches radarr<Slug>ApiKey/WebhookSecret).
async function writeSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

export const POST = withAdmin(async (req, _ctx, session) => {
  const parsed = await readJsonCapped<SavePayload>(req, 64 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const service = body.service;
  if (service !== "radarr" && service !== "sonarr") {
    return NextResponse.json({ error: "service must be radarr or sonarr" }, { status: 400 });
  }
  const instances = Array.isArray(body.instances) ? body.instances : [];
  for (const inst of instances) {
    if (typeof inst?.slug !== "string" || !isValidInstanceSlug(inst.slug)) {
      return NextResponse.json({ error: `invalid instance slug: ${inst?.slug}` }, { status: 400 });
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

  // Persist registry metadata (default excluded — it's synthesized).
  const registry: ArrInstanceConfig[] = instances
    .filter((i) => i.slug !== DEFAULT_ARR_INSTANCE)
    .map((i) => ({
      slug: i.slug,
      name: typeof i.name === "string" && i.name.trim() ? i.name : i.slug,
      restricted: i.restricted === true,
      serverAll: i.serverAll === true,
      skipLibraryCheck: i.skipLibraryCheck === true,
      autoRoute: i.autoRoute ?? null,
    }));
  await saveArrInstances(service, registry);

  // Write each instance's connection Setting rows. Skip a secret field left at the
  // mask sentinel (unchanged); an explicit "" clears the row.
  for (const inst of instances) {
    const set = async (field: (typeof FIELDS)[number], value: string | undefined, isSecret: boolean) => {
      if (value === undefined) return;
      if (isSecret && value === MASKED_VALUE) return;
      await writeSetting(arrSettingKey(service, inst.slug, field), value);
    };
    await set("Url", typeof inst.url === "string" ? inst.url.trim() : undefined, false);
    await set("ApiKey", inst.apiKey, true);
    await set("RootFolder", typeof inst.rootFolder === "string" ? inst.rootFolder : undefined, false);
    // null = explicit clear (the UI sends null for an emptied field); undefined = untouched.
    await set(
      "QualityProfileId",
      inst.qualityProfileId === undefined ? undefined : inst.qualityProfileId === null ? "" : String(inst.qualityProfileId),
      false,
    );
    await set("WebhookSecret", inst.webhookSecret, true);
  }

  // Clean up rows for removed named instances.
  for (const slug of beforeNamed) {
    if (!nextNamed.has(slug)) {
      await prisma.setting.deleteMany({
        where: { key: { in: FIELDS.map((f) => arrSettingKey(service, slug, f)) } },
      });
    }
  }

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
      testResults[inst.slug] = { error: `${service} connection failed` };
    }
  });

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SETTINGS_CHANGE",
    target: `arr-instances:${service}`,
    details: { service, instances: instances.map((i) => i.slug) },
    ...auditContext(req, session),
  });

  const view = await Promise.all(configured.map((i) => readInstanceView(service, i)));
  return NextResponse.json({ ok: true, instances: view, testResults });
});
