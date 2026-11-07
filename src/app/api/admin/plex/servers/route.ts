import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { getPlexConfig } from "@/lib/plex-config";
import { getPlexResources, getPlexMachineId } from "@/lib/plex";
import { parsePlexResources, connectionsToTry, firstMatchInOrder } from "@/lib/plex-resources";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";

// Addresses probed at once on a fallback pick (plex-resources caps a server at
// 20). Serially, 20 dead addresses at 5 s each held the request for 100 s; the
// pick is still the most preferred address that answers (firstMatchInOrder).
const PROBE_CONCURRENCY = 4;
const PROBE_TIMEOUT_MS = 5_000;

async function accountServers(t: Translator) {
  const { token } = await getPlexConfig();
  if (!token) return { error: t("apiAdmin.plexServers.connectFirst"), status: 400 as const };
  try {
    return { servers: parsePlexResources(await getPlexResources(token)), token };
  } catch (err) {
    console.error("[plex-servers] plex.tv resources failed:", err);
    return { error: t("apiAdmin.plexServers.loadFailed"), status: 502 as const };
  }
}

// The servers on the connected Plex account (owned ones). Addresses only — the
// per-server access tokens plex.tv sends never leave the server.
export const GET = withAdmin(async (req) => {
  const r = await accountServers(translatorForRequest(req));
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ servers: r.servers });
});

// Resolves ONE server to an address that answers from here. The browser names
// the server by machine id only; the addresses come from plex.tv, never the body.
// fallback=false tries only the most preferred address; true tries them in order
// of preference (LAN, remote, then relay).
export const POST = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<{ machineId?: unknown; fallback?: unknown }>(req, 4 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  if (typeof parsed.machineId !== "string" || !parsed.machineId) {
    return NextResponse.json({ error: t("apiAdmin.plexServers.machineIdRequired") }, { status: 400 });
  }
  const r = await accountServers(t);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  const server = r.servers.find((s) => s.machineId === parsed.machineId);
  if (!server) return NextResponse.json({ error: t("apiAdmin.plexServers.notFound") }, { status: 404 });

  const tried = connectionsToTry(server, parsed.fallback === true);
  // getPlexMachineId never throws: a dead address is a "no".
  const hit = await firstMatchInOrder(
    tried,
    async (c) => (await getPlexMachineId(c.uri, r.token, PROBE_TIMEOUT_MS)) === server.machineId,
    PROBE_CONCURRENCY,
  );
  if (hit >= 0) {
    const c = tried[hit];
    return NextResponse.json({ url: c.uri, relay: c.relay, local: c.local });
  }
  return NextResponse.json(
    {
      error: parsed.fallback === true ? t("apiAdmin.plexServers.noneAnswered") : t("apiAdmin.plexServers.preferredNoAnswer"),
      tried: tried.length,
    },
    { status: 502 },
  );
});
