import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { readJsonCapped } from "@/lib/body-size";
import { logAudit, auditContext } from "@/lib/audit";
import { pingPlexToken } from "@/lib/plex";
import { getJellyfinUserCount } from "@/lib/jellyfin";
import { type MediaServerService, DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug, plexSettingKey, jellyfinSettingKey } from "@/lib/media-instances";
import { settleLimit } from "@/lib/concurrency";
import { getMediaInstances, saveMediaInstances } from "@/lib/media-instance-registry";

// Admin management surface for the full Plex/Jellyfin instance list (multi-
// server support): the registry metadata (slug/name — deliberately thin, see
// media-instance-registry.ts) AND each instance's connection Setting rows. The
// default ("") instance is managed here too — its connection keys are the same
// plexServerUrl/jellyfinUrl rows the legacy settings surface uses, so
// back-compat is preserved; PlexConnectForm/JellyfinSyncForm keep working
// unmodified.
//
// Phase 0 scope: only the core connection fields needed for sync/sign-in
// (Plex: ServerUrl/AdminToken/AdminEmail; Jellyfin: Url/ApiKey). Library
// pickers and path-strip-prefix fields need a live per-server library-sections
// fetch and are a deliberately later UI sub-step — their Setting keys already
// exist (media-instances.ts's field types), just not written from here yet.
//
// Secrets are never returned; the UI receives a hasSecret flag and sends the
// sentinel MASKED_VALUE back unchanged for a field it didn't edit.

const MASKED_VALUE = "••••••••";

interface InstancePayload {
  slug: string;
  name?: string;
  serverUrl?: string; // Plex
  adminToken?: string; // Plex, secret
  adminEmail?: string; // Plex
  url?: string; // Jellyfin
  apiKey?: string; // Jellyfin, secret
}

interface SavePayload {
  service?: string;
  instances?: InstancePayload[];
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
  const keys = [jellyfinSettingKey(slug, "Url"), jellyfinSettingKey(slug, "ApiKey")];
  const rows = await prisma.setting.findMany({ where: { key: { in: keys } } });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    slug,
    name,
    url: map[jellyfinSettingKey(slug, "Url")] ?? "",
    hasApiKey: !!map[jellyfinSettingKey(slug, "ApiKey")],
  };
}

export const GET = withAdmin(async (_req, _ctx, _session) => {
  const [plex, jellyfin] = await Promise.all([
    getMediaInstances("plex").then((list) => Promise.all(list.map((i) => readInstanceView("plex", i.slug, i.name)))),
    getMediaInstances("jellyfin").then((list) => Promise.all(list.map((i) => readInstanceView("jellyfin", i.slug, i.name)))),
  ]);
  return NextResponse.json({ plex, jellyfin });
});

// Upsert a Setting row; encryption for the secret keys fires in the Prisma
// extension (isSensitiveSettingKey matches plex<Slug>AdminToken/jellyfin<Slug>ApiKey).
async function writeSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

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
  // Setting rows, including an unrecoverable encrypted token/key.
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
  // its Setting rows. The default ("") is never a cleanup candidate: it's
  // synthesized (not registry-backed) and the manager UI omits it from its
  // POST — treating its absence as "removed" would wipe the base
  // plexServerUrl/jellyfinUrl connection Settings.
  const isNamedSlug = (slug: string) => slug !== DEFAULT_MEDIA_INSTANCE;
  const before = await getMediaInstances(service);
  const beforeNamed = new Set(before.filter((i) => isNamedSlug(i.slug)).map((i) => i.slug));
  const nextNamed = new Set(instances.filter((i) => isNamedSlug(i.slug)).map((i) => i.slug));

  // Persist registry metadata (built-in default excluded — synthesized in
  // getMediaInstances, never registry-backed; a "" entry here would shadow it).
  const registry = instances
    .filter((i) => i.slug !== DEFAULT_MEDIA_INSTANCE)
    .map((i) => ({ slug: i.slug, name: typeof i.name === "string" && i.name.trim() ? i.name : i.slug }));
  await saveMediaInstances(service, registry);

  // Write each instance's connection Setting rows. Skip a secret field left at
  // the mask sentinel (unchanged); an explicit "" clears the row.
  for (const inst of instances) {
    const set = async (key: string, value: string | undefined, isSecret: boolean) => {
      if (value === undefined) return;
      if (isSecret && value === MASKED_VALUE) return;
      await writeSetting(key, value);
    };
    if (service === "plex") {
      await set(plexSettingKey(inst.slug, "ServerUrl"), typeof inst.serverUrl === "string" ? inst.serverUrl.trim() : undefined, false);
      await set(plexSettingKey(inst.slug, "AdminToken"), inst.adminToken, true);
      await set(plexSettingKey(inst.slug, "AdminEmail"), typeof inst.adminEmail === "string" ? inst.adminEmail.trim() : undefined, false);
    } else {
      await set(jellyfinSettingKey(inst.slug, "Url"), typeof inst.url === "string" ? inst.url.trim() : undefined, false);
      await set(jellyfinSettingKey(inst.slug, "ApiKey"), inst.apiKey, true);
    }
  }

  // Clean up rows for removed named instances.
  for (const slug of beforeNamed) {
    if (!nextNamed.has(slug)) {
      const keys =
        service === "plex"
          ? [plexSettingKey(slug, "ServerUrl"), plexSettingKey(slug, "AdminToken"), plexSettingKey(slug, "AdminEmail")]
          : [jellyfinSettingKey(slug, "Url"), jellyfinSettingKey(slug, "ApiKey")];
      await prisma.setting.deleteMany({ where: { key: { in: keys } } });
    }
  }

  // Connection tests for every instance that now has its required fields.
  // Bounded — the instance list is admin-sized but still input-scaled (guardrail 31).
  const testResults: Record<string, { ok?: boolean; error?: string }> = {};
  const configured = await getMediaInstances(service);
  await settleLimit(configured, 4, async (inst) => {
    if (service === "plex") {
      const rows = await prisma.setting.findMany({
        where: { key: { in: [plexSettingKey(inst.slug, "ServerUrl"), plexSettingKey(inst.slug, "AdminToken")] } },
      });
      const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      const token = map[plexSettingKey(inst.slug, "AdminToken")];
      if (!map[plexSettingKey(inst.slug, "ServerUrl")] || !token) return;
      try {
        const ok = await pingPlexToken(token);
        testResults[inst.slug] = ok ? { ok: true } : { error: "Plex token check failed" };
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

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SETTINGS_CHANGE",
    target: `media-instances:${service}`,
    details: { service, instances: instances.map((i) => i.slug) },
    ...auditContext(req, session),
  });

  const view = await Promise.all(configured.map((i) => readInstanceView(service, i.slug, i.name)));
  return NextResponse.json({ ok: true, instances: view, testResults });
});
