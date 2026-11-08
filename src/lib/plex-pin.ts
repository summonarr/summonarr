// Creating a plex.tv PIN — shared by the sign-in flow (/api/auth/plex/start)
// and the admin "Connect Plex" flow (/api/auth/plex/pin), which differ only in
// whose client identifier and device strings they send.
import { safeFetchTrusted } from "@/lib/safe-fetch";
import { check, v } from "@/lib/validate";
import { plexClientHeaders, WEB_PLEX_CLIENT_DEVICE, type PlexClientDevice } from "@/lib/plex-client-headers";

const PLEX_TV_HOSTS = ["plex.tv"];
const PIN_TIMEOUT_MS = 15_000;

/** What a PIN request says about the device asking. Defaults: the hosted web app. */
export type PlexDeviceHeaders = PlexClientDevice;

export const WEB_PLEX_DEVICE: PlexDeviceHeaders = WEB_PLEX_CLIENT_DEVICE;

// The X-Plex-* header set every plex.tv PIN call sends: the shared client headers.
export const plexPinHeaders = plexClientHeaders;

const DEVICE_VALUE_MAX = 32;
const NOT_HEADER_SAFE = /[^\x20-\x7e]/g;

// A caller-supplied device string as a header value: printable ASCII only,
// bounded, else the fallback. A header value is a ByteString, so a localized
// device name ("Chris’s iPhone") made fetch throw before plex.tv was ever
// asked, and the sign-in failed as if plex.tv had.
export function plexDeviceValue(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw.replace(NOT_HEADER_SAFE, "").trim().slice(0, DEVICE_VALUE_MAX).trim();
  return cleaned || fallback;
}

const PinBody = v.object({ id: v.int(), code: v.string() });

export type PlexPinResult =
  | { kind: "ok"; id: number; code: string }
  /** plex.tv didn't answer, or answered non-2xx. Logged under `logScope`. */
  | { kind: "failed" }
  /** A 2xx that isn't a PIN (a proxy page, an empty body, a JSON null). */
  | { kind: "malformed" };

export async function createPlexPin(clientId: string, device: PlexDeviceHeaders, logScope: string): Promise<PlexPinResult> {
  const res = await safeFetchTrusted("https://plex.tv/api/v2/pins", {
    allowedHosts: PLEX_TV_HOSTS,
    method: "POST",
    headers: { ...plexPinHeaders(clientId, device), "Content-Type": "application/x-www-form-urlencoded" },
    body: "strong=true",
    timeoutMs: PIN_TIMEOUT_MS,
  }).catch((err: unknown) => {
    // A thrown SafeFetchError (DNS failure, non-public resolved address,
    // timeout) is an operator-side egress problem, the same "plex.tv didn't
    // answer" as a refusal; logged so it can be diagnosed from the server log.
    console.error(`[${logScope}] PIN create failed:`, err instanceof Error ? err.message : String(err));
    return null;
  });
  if (!res) return { kind: "failed" };
  if (!res.ok) {
    console.error(`[${logScope}] plex.tv returned`, res.status);
    return { kind: "failed" };
  }
  const parsed = check(PinBody, await res.json().catch(() => null));
  if (!parsed.ok || parsed.value.id <= 0) return { kind: "malformed" };
  return { kind: "ok", id: parsed.value.id, code: parsed.value.code };
}

/** Poll a PIN with the client identifier that created it. Null when plex.tv didn't answer. */
export function fetchPlexPin(pinId: number, clientId: string, logScope: string): Promise<Response | null> {
  return safeFetchTrusted(`https://plex.tv/api/v2/pins/${pinId}`, {
    allowedHosts: PLEX_TV_HOSTS,
    headers: plexPinHeaders(clientId),
    timeoutMs: PIN_TIMEOUT_MS,
  }).catch((err: unknown) => {
    console.error(`[${logScope}] PIN poll failed:`, err instanceof Error ? err.message : String(err));
    return null;
  });
}
