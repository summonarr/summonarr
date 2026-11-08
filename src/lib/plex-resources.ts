// Parsing + ordering of plex.tv's /api/v2/resources answer, so the admin can
// pick a server instead of typing its address, and the ordered probe the pick
// runs over a server's addresses. The answer also carries a per-server access
// token — it is deliberately NEVER copied into the result.

import { mapLimit } from "./concurrency";

export interface PlexServerConnection {
  uri: string;
  local: boolean;
  relay: boolean;
}

export interface PlexAccountServer {
  machineId: string;
  name: string;
  connections: PlexServerConnection[];
}

const MAX_SERVERS = 50;
const MAX_CONNECTIONS = 20;

// Most preferred first: a LAN address (fastest, no plex.tv hop), then the
// remote address, and the relay (bandwidth-capped) last.
function rank(c: PlexServerConnection): number {
  return c.relay ? 2 : c.local ? 0 : 1;
}

export function orderConnections(list: readonly PlexServerConnection[]): PlexServerConnection[] {
  return list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map((x) => x.c);
}

function isHttpUri(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Owned servers only — the stored admin token is the owner's, so a server shared WITH the account would need another token. */
export function parsePlexResources(body: unknown): PlexAccountServer[] {
  if (!Array.isArray(body)) return [];
  const out: PlexAccountServer[] = [];
  const seen = new Set<string>();
  for (const raw of body.slice(0, MAX_SERVERS * 4)) {
    if (out.length >= MAX_SERVERS) break;
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.provides !== "string" || !r.provides.split(",").includes("server")) continue;
    if (r.owned !== true) continue;
    const machineId = typeof r.clientIdentifier === "string" ? r.clientIdentifier : "";
    if (!machineId || seen.has(machineId)) continue;
    const conns: PlexServerConnection[] = [];
    const uris = new Set<string>();
    if (Array.isArray(r.connections)) {
      for (const c of r.connections.slice(0, MAX_CONNECTIONS * 2)) {
        if (conns.length >= MAX_CONNECTIONS) break;
        if (!c || typeof c !== "object") continue;
        const cc = c as Record<string, unknown>;
        if (cc.IPv6 === true || !isHttpUri(cc.uri)) continue;
        const uri = cc.uri.replace(/\/+$/, "");
        if (uris.has(uri)) continue;
        uris.add(uri);
        conns.push({ uri, local: cc.local === true, relay: cc.relay === true });
      }
    }
    if (conns.length === 0) continue;
    seen.add(machineId);
    out.push({ machineId, name: typeof r.name === "string" && r.name ? r.name : machineId, connections: orderConnections(conns) });
  }
  return out;
}

/** What to try for a pick: with fallback off ONLY the most preferred address; on, every address in order. */
export function connectionsToTry(server: PlexAccountServer, fallback: boolean): PlexServerConnection[] {
  return fallback ? server.connections : server.connections.slice(0, 1);
}

/**
 * The index of the first item, in the given (preference) order, that `probe`
 * accepts; -1 when none does. Up to `concurrency` probes run at once
 * (mapLimit, guardrail 31), but the answer is always the earliest-RANKED
 * match, never merely the first to reply: it resolves once every item ranked
 * above the match has answered no, and no probe starts after that. A probe
 * that throws counts as no.
 */
export async function firstMatchInOrder<T>(
  items: readonly T[],
  probe: (item: T) => Promise<boolean>,
  concurrency: number,
): Promise<number> {
  const settle: Array<(matched: boolean) => void> = [];
  const results = items.map(() => new Promise<boolean>((resolve) => { settle.push(resolve); }));
  let decided = false;
  // Every slot settles exactly once: a probe that throws counts as "no" (it
  // used to leave its slot pending, so the walk never returned), and a slot
  // skipped after the answer settles "no" too.
  void mapLimit(items, concurrency, async (item, i) => {
    if (decided) {
      settle[i](false);
      return;
    }
    let matched = false;
    try {
      matched = await probe(item);
    } catch {
      matched = false;
    }
    settle[i](matched);
  });
  for (let i = 0; i < results.length; i++) {
    if (await results[i]) {
      decided = true;
      return i;
    }
  }
  return -1;
}
