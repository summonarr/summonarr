

// A coarse summary of a User-Agent: browser family, OS and device class only.
// The raw UA string is never stored, so no identifying detail is kept.
export interface UaFingerprint {

  browser: string;

  os: string;

  device: "mobile" | "tablet" | "desktop";
}

// Classifies a raw UA string into browser family / OS / device class.
export function extractUaFingerprint(ua: string): UaFingerprint {

  const isTablet =
    /iPad/i.test(ua) ||
    (/Android/i.test(ua) && !/Mobile/i.test(ua));
  const isMobile =
    !isTablet &&
    /iPhone|iPod|Android.*Mobile|Mobile.*Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const device: UaFingerprint["device"] = isTablet
    ? "tablet"
    : isMobile
      ? "mobile"
      : "desktop";

  // Chromium-based browsers (Edge, Opera, Yandex, Samsung) are tested before
  // Chrome because their UAs also contain "Chrome/". Chrome is tested before
  // Safari for the same reason (Chrome's UA also contains "Safari/").
  const browser =
    /Edg\//i.test(ua)              ? "edge"
    : /OPR\//i.test(ua)            ? "opera"
    : /YaBrowser\//i.test(ua)      ? "yandex"
    : /SamsungBrowser\//i.test(ua) ? "samsung"
    : /Chrome\//i.test(ua)         ? "chrome"
    : /Firefox\//i.test(ua)        ? "firefox"
    : /Safari\//i.test(ua)         ? "safari"
    : /MSIE |Trident\//i.test(ua)  ? "ie"
    : "unknown";

  const os =
    /Windows NT/i.test(ua)                  ? "windows"
    : /iPhone|iPad|iPod/i.test(ua)           ? "ios"
    : /Android/i.test(ua)                    ? "android"
    : /CrOS/i.test(ua)                       ? "chromeos"
    : /Mac OS X/i.test(ua)                   ? "macos"
    : /Linux/i.test(ua)                      ? "linux"
    : "unknown";

  return { browser, os, device };
}

export function serializeFingerprint(fp: UaFingerprint): string {
  return `${fp.browser}:${fp.os}:${fp.device}`;
}

// Checks whether this request's UA matches the fingerprint saved in the session.
// Returns false on a mismatch (the caller should deny) and true on a match or
// when the session has no fingerprint. "machine:" fingerprints (from
// /api/auth/machine-session) are tied to CRON_SECRET, not a browser, so they
// always pass. Bearer (native app) sessions are skipped by the CALLER, not here:
// their token lives in the app's secure storage, not in a cookie the browser
// sends automatically (guardrail 6b).
export function matchesStoredFingerprint(
  storedFp: string | undefined,
  currentUa: string | null,
): boolean {
  if (!storedFp || storedFp.startsWith("machine:")) return true;
  const currentFp = serializeFingerprint(extractUaFingerprint(currentUa ?? ""));
  return currentFp === storedFp;
}

export function fingerprintToLabel(fp: UaFingerprint): string {
  const browserLabel: Record<string, string> = {
    chrome: "Chrome",
    firefox: "Firefox",
    safari: "Safari",
    edge: "Edge",
    opera: "Opera",
    yandex: "Yandex Browser",
    samsung: "Samsung Internet",
    ie: "Internet Explorer",
    unknown: "Unknown Browser",
  };

  const osLabel: Record<string, string> = {
    windows: "Windows",
    macos: "macOS",
    linux: "Linux",
    chromeos: "Chrome OS",
    ios: fp.device === "tablet" ? "iPad" : "iPhone",
    android: fp.device === "tablet" ? "Android Tablet" : "Android",
    unknown: "Unknown OS",
  };

  return `${browserLabel[fp.browser] ?? "Browser"} on ${osLabel[fp.os] ?? "Unknown"}`;
}
