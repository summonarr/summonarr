import "server-only";
import { isIP } from "node:net";
import { prisma } from "./prisma";
import { safeFetchTrusted, SafeFetchError } from "./safe-fetch";

const IPINFO_BASE = "https://ipinfo.io";
const IPINFO_TIMEOUT_MS = 8_000;

const FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NOT_FOUND_TTL_MS = 24 * 60 * 60 * 1000;

function sanitizeForLog(value: string): string {
  return value.replace(/[\r\n\x00-\x1F\x7F]/g, "");
}

export interface IpLookup {
  ip: string;
  hostname: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  postal: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  org: string | null;
  /** True for RFC1918/loopback/etc or upstream "bogon": true. UI should label as LAN. */
  bogon: boolean;
}

interface IpinfoResponse {
  ip?: string;
  hostname?: string;
  city?: string;
  region?: string;
  country?: string;
  loc?: string;
  org?: string;
  postal?: string;
  timezone?: string;
  bogon?: boolean;
}

async function getToken(): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: "ipinfoToken" } });
  return row?.value || null;
}

/** Detect IPs that ipinfo would mark as bogon, without round-tripping. */
function isPrivateOrReserved(ip: string): boolean {
  const v = isIP(ip);
  if (v === 0) return true;
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    return false;
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 0) return true;
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function rowToLookup(row: {
  ip: string;
  hostname: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  postal: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  org: string | null;
  notFound: boolean;
}): IpLookup {
  return {
    ip: row.ip,
    hostname: row.hostname,
    city: row.city,
    region: row.region,
    country: row.country,
    postal: row.postal,
    latitude: row.latitude,
    longitude: row.longitude,
    timezone: row.timezone,
    org: row.org,
    bogon: row.notFound,
  };
}

function parseIpinfo(ip: string, data: IpinfoResponse): {
  hostname: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  postal: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  org: string | null;
} {
  let latitude: number | null = null;
  let longitude: number | null = null;
  if (data.loc) {
    const [latStr, lonStr] = data.loc.split(",");
    const lat = Number(latStr);
    const lon = Number(lonStr);
    if (Number.isFinite(lat)) latitude = lat;
    if (Number.isFinite(lon)) longitude = lon;
  }
  return {
    hostname: data.hostname ?? null,
    city: data.city ?? null,
    region: data.region ?? null,
    country: data.country ?? null,
    postal: data.postal ?? null,
    latitude,
    longitude,
    timezone: data.timezone ?? null,
    org: data.org ?? null,
  };
}

export async function getIpLookup(rawIp: string): Promise<IpLookup | null> {
  const ip = rawIp.trim();
  if (!ip || isIP(ip) === 0) return null;

  if (isPrivateOrReserved(ip)) {
    return {
      ip,
      hostname: null,
      city: null,
      region: null,
      country: null,
      postal: null,
      latitude: null,
      longitude: null,
      timezone: null,
      org: null,
      bogon: true,
    };
  }

  const cached = await prisma.ipLookupCache.findUnique({ where: { ip } });
  if (cached) {
    const age = Date.now() - cached.fetchedAt.getTime();
    const ttl = cached.notFound ? NOT_FOUND_TTL_MS : FOUND_TTL_MS;
    if (age < ttl) return rowToLookup(cached);
  }

  const token = await getToken();
  if (!token) return cached ? rowToLookup(cached) : null;

  try {
    const url = `${IPINFO_BASE}/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(token)}`;
    const res = await safeFetchTrusted(url, { allowedHosts: ["ipinfo.io"], timeoutMs: IPINFO_TIMEOUT_MS });
    if (!res.ok) {
      console.error(`[ip-lookup] ipinfo returned HTTP ${res.status} for ${sanitizeForLog(ip)}`);
      return cached ? rowToLookup(cached) : null;
    }
    const data = (await res.json()) as IpinfoResponse;

    if (data.bogon) {
      const row = await prisma.ipLookupCache.upsert({
        where: { ip },
        create: { ip, notFound: true },
        update: {
          hostname: null,
          city: null,
          region: null,
          country: null,
          postal: null,
          latitude: null,
          longitude: null,
          timezone: null,
          org: null,
          notFound: true,
          fetchedAt: new Date(),
        },
      });
      return rowToLookup(row);
    }

    const parsed = parseIpinfo(ip, data);
    const row = await prisma.ipLookupCache.upsert({
      where: { ip },
      create: { ip, ...parsed, notFound: false },
      update: { ...parsed, notFound: false, fetchedAt: new Date() },
    });
    return rowToLookup(row);
  } catch (err) {
    const reason = err instanceof SafeFetchError ? err.reason : err instanceof Error ? err.message : String(err);
    console.error(`[ip-lookup] fetch failed for ${sanitizeForLog(ip)}: ${sanitizeForLog(reason)}`);
    return cached ? rowToLookup(cached) : null;
  }
}

export async function testIpinfoConnection(): Promise<string> {
  const token = await getToken();
  if (!token) throw new Error("No ipinfo token configured");
  const url = `${IPINFO_BASE}/8.8.8.8/json?token=${encodeURIComponent(token)}`;
  const res = await safeFetchTrusted(url, { allowedHosts: ["ipinfo.io"], timeoutMs: IPINFO_TIMEOUT_MS });
  if (!res.ok) throw new Error(`ipinfo returned HTTP ${res.status}`);
  const data = (await res.json()) as IpinfoResponse;
  if (!data.ip) throw new Error("ipinfo returned malformed response");
  return data.org ?? data.ip;
}
