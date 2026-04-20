

// Fingerprint captures only browser family / OS / device class — no raw UA string is stored, avoiding PII retention
export interface UaFingerprint {

  browser: string;

  os: string;

  device: "mobile" | "tablet" | "desktop";
}

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

  // Chromium-derived browsers (Edge, Opera) must be tested before Chrome because their UAs also contain "Chrome/"
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

export function isMobileUa(ua: string): boolean {
  const fp = extractUaFingerprint(ua);
  return fp.device === "mobile" || fp.device === "tablet";
}
