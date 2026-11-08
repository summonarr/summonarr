import { NextResponse, type NextRequest } from "next/server";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug, type MediaInstanceKey } from "@/lib/media-instances";
import { trimServerBase } from "@/lib/server-url";

// The settings page's library pickers (/api/settings/plex/libraries and
// /api/settings/jellyfin/libraries): one server's libraries, for the instance the
// picker is choosing for. Section keys are per-server, so listing the default
// server would offer keys that mean something else on the target.
export interface LibraryPickerSource {
  /** The instance's base URL and credential, or null when it isn't configured. */
  load(instance: MediaInstanceKey): Promise<{ url: string; credential: string } | null>;
  /** The server's libraries, from its trimmed base URL. */
  list(url: string, credential: string): Promise<unknown>;
  notConfiguredKey: string;
  failedKey: string;
  /** The log prefix, e.g. "settings/plex/libraries". */
  scope: string;
}

export async function listServerLibraries(req: NextRequest, source: LibraryPickerSource): Promise<NextResponse> {
  const t = translatorForRequest(req);
  const instance = req.nextUrl.searchParams.get("instance") ?? DEFAULT_MEDIA_INSTANCE;
  if (instance !== DEFAULT_MEDIA_INSTANCE && !isValidMediaInstanceSlug(instance)) {
    return NextResponse.json({ error: t("apiAdmin.common.invalidInstance") }, { status: 400 });
  }
  const cfg = await source.load(instance);
  if (!cfg) {
    // 422, not 400: "not configured yet" is server state, not a bad request —
    // the same status arr-options uses, so the three pickers agree.
    return NextResponse.json({ error: t(source.notConfiguredKey) }, { status: 422 });
  }
  try {
    return NextResponse.json(await source.list(trimServerBase(cfg.url), cfg.credential));
  } catch (err) {
    console.error(`[${source.scope}] Failed to fetch libraries:`, err instanceof Error ? err.message : err);
    return NextResponse.json({ error: t(source.failedKey) }, { status: 502 });
  }
}
