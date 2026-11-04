import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { getPlexConfig } from "@/lib/plex-config";
import { getPlexResources, getPlexMachineId } from "@/lib/plex";
import { parsePlexResources, connectionsToTry } from "@/lib/plex-resources";
import { readJsonCapped } from "@/lib/body-size";

async function accountServers() {
  const { token } = await getPlexConfig();
  if (!token) return { error: "Connect your Plex account first", status: 400 as const };
  try {
    return { servers: parsePlexResources(await getPlexResources(token)), token };
  } catch (err) {
    console.error("[plex-servers] plex.tv resources failed:", err);
    return { error: "Could not load servers from plex.tv", status: 502 as const };
  }
}

// The servers on the connected Plex account (owned ones). Addresses only — the
// per-server access tokens plex.tv sends never leave the server.
export const GET = withAdmin(async () => {
  const r = await accountServers();
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ servers: r.servers });
});

// Resolves ONE server to an address that answers from here. The browser names
// the server by machine id only; the addresses come from plex.tv, never the body.
// fallback=false tries only the most preferred address; true tries them in order
// (LAN, remote, then relay).
export const POST = withAdmin(async (req) => {
  const parsed = await readJsonCapped<{ machineId?: unknown; fallback?: unknown }>(req, 4 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  if (typeof parsed.machineId !== "string" || !parsed.machineId) {
    return NextResponse.json({ error: "machineId is required" }, { status: 400 });
  }
  const r = await accountServers();
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  const server = r.servers.find((s) => s.machineId === parsed.machineId);
  if (!server) return NextResponse.json({ error: "Server not found on this Plex account" }, { status: 404 });

  const tried = connectionsToTry(server, parsed.fallback === true);
  for (const c of tried) {
    const id = await getPlexMachineId(c.uri, r.token, 5_000);
    if (id === server.machineId) {
      return NextResponse.json({ url: c.uri, relay: c.relay, local: c.local });
    }
  }
  return NextResponse.json(
    { error: parsed.fallback === true ? "None of this server's addresses answered" : "The preferred address did not answer", tried: tried.length },
    { status: 502 },
  );
});
