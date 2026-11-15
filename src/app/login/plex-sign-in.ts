// Starting a Plex sign-in from the login page: create the PIN through our
// server, stash the redirect state, and build the plex.tv approval URL. Browser
// only (document.cookie, localStorage, sessionStorage); the URL rules are the
// shared ones in plex-approval-url.ts, the stashed shape is LoginAuth
// (plex-redirect-auth.ts), which /auth/plex/done reads on return.
import { BASE_PATH, withBasePath } from "@/lib/base-path";
import { plexApprovalUrl, plexForwardUrl, plexReturnBase } from "@/lib/client/plex-approval-url";
import type { LoginAuth } from "@/lib/client/plex-redirect-auth";
import { timedFetch } from "@/lib/client/fetch-json";
import { readPlexPin } from "@/lib/client/login-answers";
import { rateLimitMessage } from "@/lib/client/rate-limit";
import type { Translator } from "@/lib/i18n/translate";
import { randomUuid } from "@/lib/random-id";
import { PLEX_CLIENT_VERSION, PLEX_PRODUCT } from "@/lib/plex-client-headers";

export function readPlexClientId(): string | null {
  // Cookie is checked first; falls back to localStorage for older sessions that predate the cookie write
  const match = document.cookie.match(/(?:^|; )plex-client-id=([^;]+)/);
  if (match) return decodeURIComponent(match[1]);
  return localStorage.getItem("plex-client-id");
}

export function writePlexClientId(id: string): void {
  // Cookie only — readPlexClientId falls back to localStorage for sessions that predate this change
  document.cookie = `plex-client-id=${encodeURIComponent(id)}; Max-Age=${60 * 60 * 24 * 365}; Path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
}

// randomUuid, never crypto.randomUUID: the latter is undefined on a plain-HTTP
// LAN origin, and calling it threw before any sign-in could start.
function getPlexClientId(): string {
  const id = readPlexClientId() ?? randomUuid();
  // Written back even when it was read (from localStorage, for a session that
  // predates the cookie): the cookie is what everything else reads, and this
  // also renews its lifetime.
  writePlexClientId(id);
  return id;
}

type PlexDeviceMeta = { platform: string; device: string; model: string; layout: string };

function getPlexDeviceMeta(): PlexDeviceMeta {
  const ua = navigator.userAgent;

  if (/android/i.test(ua)) {
    return { platform: "Android", device: "Android", model: "Android", layout: "mobile" };
  }

  // iPadOS 13+ sends a Macintosh user agent; only a touch screen gives it away.
  const isIpadOs = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  if (/iPad|iPhone|iPod/.test(ua) || isIpadOs) {
    const isIpad = /iPad/.test(ua) || isIpadOs;
    return { platform: "iOS", device: isIpad ? "iPad" : "iPhone", model: isIpad ? "iPad" : "iPhone", layout: "mobile" };
  }

  let browser = "Web";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua)) browser = "Safari";

  let os = "Linux";
  if (/Windows/.test(ua)) os = "Windows";
  else if (/Mac OS X|Macintosh/.test(ua)) os = "OSX";
  else if (/CrOS/.test(ua)) os = "Chrome OS";

  return { platform: browser, device: os, model: "bundled", layout: "desktop" };
}

// Server creates the PIN and sets a signed HttpOnly cookie binding the pinId to
// this browser. /api/auth/sign-in/plex rejects any submission whose body pinId
// doesn't match the cookie's pinId, defeating PIN-phishing attacks where an
// attacker's PIN gets approved by a victim and the resulting token is submitted
// from the attacker's browser.
async function createPin(clientId: string, meta: PlexDeviceMeta, t: Translator): Promise<{ pinId: number; code: string } | { error: string }> {
  // Bounded (the default 30s): a stalled start rejects into startPlexSignIn's
  // catch instead of leaving the button on "Waiting for Plex…".
  const res = await timedFetch(withBasePath("/api/auth/plex/start"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ clientId, platform: meta.platform, device: meta.device, model: meta.model }),
  });
  if (!res.ok) {
    // The body is not read: release it so the timeout timer stops.
    void res.body?.cancel().catch(() => {});
    return { error: rateLimitMessage(res, t) ?? t("auth.login.error.plexStart") };
  }
  return readPlexPin(await res.json().catch(() => null)) ?? { error: t("auth.login.error.plexStart") };
}

/**
 * Everything before the redirect to plex.tv. Never throws: any failure — the
 * start route refusing, a body that isn't a PIN, storage blocked, no network —
 * comes back as the message to show, so the button can't hang on "Waiting for
 * Plex…".
 */
export async function startPlexSignIn(opts: {
  rememberMe: boolean;
  callbackUrl: string;
  siteUrl: string;
  t: Translator;
}): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const { rememberMe, callbackUrl, siteUrl, t } = opts;
  let clientId: string;
  let deviceMeta: PlexDeviceMeta;
  let pin: { pinId: number; code: string } | { error: string };
  try {
    clientId = getPlexClientId();
    deviceMeta = getPlexDeviceMeta();
    pin = await createPin(clientId, deviceMeta, t);
  } catch {
    return { ok: false, error: t("auth.login.error.plexStart") };
  }
  if ("error" in pin) return { ok: false, error: pin.error };

  const state = randomUuid();
  // siteUrl is the admin site URL, else AUTH_URL (a bare origin): the return
  // base carries BASE_PATH, or a sub-path install is sent back to a 404. The
  // same base is what /auth/plex/done lands on after sign-in.
  const base = plexReturnBase(siteUrl, window.location.origin, BASE_PATH);
  const url = plexApprovalUrl({
    clientId,
    code: pin.code,
    forwardUrl: plexForwardUrl(base, state),
    device: {
      product: PLEX_PRODUCT,
      version: PLEX_CLIENT_VERSION,
      platform: deviceMeta.platform,
      platformVersion: PLEX_CLIENT_VERSION,
      device: deviceMeta.device,
      deviceName: PLEX_PRODUCT,
      model: deviceMeta.model,
      layout: deviceMeta.layout,
    },
  });

  // PIN state is stashed in sessionStorage because the page navigates away; /auth/plex/done reads it on return
  const stash: LoginAuth & { deviceMeta: PlexDeviceMeta } = {
    flow: "login", pinId: pin.pinId, clientId, rememberMe, callbackUrl, siteUrl: base, state, deviceMeta,
  };
  try {
    sessionStorage.setItem("plex-redirect-auth", JSON.stringify(stash));
  } catch {
    return { ok: false, error: t("auth.login.error.storeState") };
  }
  return { ok: true, url };
}
