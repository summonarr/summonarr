// API contract version — a protocol-negotiation constant, deliberately SEPARATE
// from the marketing/release version (package.json + git tag are the source of
// truth for that). This number changes only when the client/server wire
// contract changes in a way a native client must know about — NOT on every
// release. Do not auto-derive it from package.json.
//
// Why this doesn't violate the CLAUDE.md "no version constant in src/" rule:
// that rule forbids a *third copy of the marketing version*. This is a
// different concept — a capability/contract version used purely for native
// client negotiation — and it intentionally lives here as the single source.

// Current contract version the server speaks. Advertised via X-Summonarr-Api
// and GET /api/config/compat. Bump on a breaking contract change.
// v2: APNs push registration (POST/DELETE /api/push/apns) + iOS relay push.
export const API_VERSION = 2;

// Oldest contract version the server still answers. Bump only when you drop
// backward-compatible support for an old client contract.
export const MIN_API_VERSION = 1;

// Lowest native client *build number* the server accepts for MUTATING requests,
// per platform. A request from a parseable build below this gets 426 Upgrade
// Required (see proxy.ts). This is the force-upgrade kill-switch: raise it to
// lock out a build with a known client-side defect.
//
// SAFETY: keep this at (or below) the lowest build still in the wild, or you
// brick existing installs. It starts at 1 — the first App Store build — which
// means the gate ships DORMANT (no install is below 1) and only arms when this
// is raised in a future release.
export const MIN_CLIENT: Record<string, number> = {
  ios: 1,
};

export interface NativeClientInfo {
  platform: string; // e.g. "ios"
  build: number | null; // null when absent/unparseable — never used to block
  api: number | null; // contract version the client was built against
}

// Parses the X-Summonarr-Client header. The web flow sends nothing; a native
// client sends "ios; build=42; api=1". Legacy native builds sent a bare "ios"
// with no fields. Tolerant by design: an unrecognized shape yields null fields
// so the caller fails SOFT (must not 426 a client we can't positively identify
// as stale — the gate is for honest stale installs, never a security control).
export function parseNativeClient(value: string | null): NativeClientInfo | null {
  if (!value) return null;
  const parts = value
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const platform = parts[0].toLowerCase();
  let build: number | null = null;
  let api: number | null = null;
  for (const seg of parts.slice(1)) {
    const eq = seg.indexOf("=");
    if (eq === -1) continue;
    const key = seg.slice(0, eq).trim().toLowerCase();
    const n = Number.parseInt(seg.slice(eq + 1).trim(), 10);
    if (!Number.isFinite(n)) continue;
    if (key === "build") build = n;
    else if (key === "api") api = n;
  }
  return { platform, build, api };
}

// True only when the client positively identifies a build BELOW its platform
// minimum. Unknown platform, missing/unparseable build, or no native header all
// return false — never block on uncertainty.
export function isClientBelowMinimum(info: NativeClientInfo | null): boolean {
  if (!info) return false;
  const min = MIN_CLIENT[info.platform];
  if (min == null) return false; // platform not gated
  if (info.build == null) return false; // can't identify build → don't block
  return info.build < min;
}
