// A coarse summary of a User-Agent: browser family, OS and device class only.
// The raw UA string is never stored, so no identifying detail is kept. Used for
// the device label and mobile/desktop session length — never for authorization.
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
  // Safari for the same reason (Chrome's UA also contains "Safari/"). The iOS
  // builds of Chrome, Firefox and Edge name themselves CriOS/, FxiOS/ and EdgiOS/
  // (Edge on Android: EdgA/) and still carry "Safari/", so they go first too.
  const browser =
    /Edg(?:e|A|iOS)?\//i.test(ua)  ? "edge"
    : /CriOS\//i.test(ua)          ? "chrome"
    : /FxiOS\//i.test(ua)          ? "firefox"
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

// There is deliberately NO "does this request's UA match the session's
// fingerprint" check (guardrail 6h). It used to gate every cookie request, but
// the User-Agent is written by the client: anyone replaying a stolen cookie
// sends the victim's browser family with it, so the comparison stopped no
// attacker and only signed real users out when a browser's UA changed class.
// The fingerprint now feeds the device label (fingerprintToLabel) and the
// informational fingerprint claim on the session, and nothing else.

const BROWSER_LABELS: Readonly<Record<string, string>> = {
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

function osLabel(os: string, device: UaFingerprint["device"]): string | undefined {
  switch (os) {
    case "windows": return "Windows";
    case "macos": return "macOS";
    case "linux": return "Linux";
    case "chromeos": return "Chrome OS";
    case "ios": return device === "tablet" ? "iPad" : "iPhone";
    case "android": return device === "tablet" ? "Android Tablet" : "Android";
    case "unknown": return "Unknown OS";
    default: return undefined;
  }
}

// The English text stored in AuthSession.deviceLabel. It stays English on
// purpose: native clients read it from /api/sessions as-is. The web renders it
// through localizeDeviceLabel instead.
export function fingerprintToLabel(fp: UaFingerprint): string {
  return `${BROWSER_LABELS[fp.browser] ?? "Browser"} on ${osLabel(fp.os, fp.device) ?? "Unknown"}`;
}

// The label the machine-session route stores for its API-only sessions.
const MACHINE_SESSION_LABEL = "Machine (API)";

type LabelParts = { browser: string; os: string; tablet: boolean };

// Every label fingerprintToLabel can write, mapped back to its parts. Built
// from the same tables, so the two can't drift.
const LABEL_PARTS: ReadonlyMap<string, LabelParts> = (() => {
  const out = new Map<string, LabelParts>();
  for (const browser of Object.keys(BROWSER_LABELS)) {
    for (const os of ["windows", "macos", "linux", "chromeos", "ios", "android", "unknown"]) {
      for (const device of ["desktop", "tablet"] as const) {
        const tablet = device === "tablet" && (os === "ios" || os === "android");
        out.set(fingerprintToLabel({ browser, os, device }), { browser, os, tablet });
      }
    }
  }
  return out;
})();

// Minimal translator shape (i18n/translate.ts's Translator), kept local so this
// module stays import-free.
type Translate = (key: string, vars?: Readonly<Record<string, string | number>>) => string;

// A stored device label in the viewer's language. Browser and OS names are
// product names and stay as they are; the joining phrase and the "unknown" and
// "tablet" words are translated. A label this module did not write (or null)
// comes back unchanged, so nothing is ever shown worse than it is stored.
export function localizeDeviceLabel(label: string | null, t: Translate): string | null {
  if (label === null) return null;
  if (label === MACHINE_SESSION_LABEL) return t("profile.sessions.label.machine");
  const parts = LABEL_PARTS.get(label);
  if (!parts) return label;
  const browser = parts.browser === "unknown"
    ? t("profile.sessions.label.unknownBrowser")
    : BROWSER_LABELS[parts.browser];
  const os = parts.os === "unknown"
    ? t("profile.sessions.label.unknownOs")
    : parts.os === "android" && parts.tablet
      ? t("profile.sessions.label.androidTablet")
      : osLabel(parts.os, parts.tablet ? "tablet" : "desktop") ?? label;
  return t("profile.sessions.label.browserOnOs", { browser, os });
}
