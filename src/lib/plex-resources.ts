// Pure parsing + ordering of plex.tv's /api/v2/resources answer, so the admin
// can pick a server instead of typing its address. The answer also carries a
// per-server access token — it is deliberately NEVER copied into the result.

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
