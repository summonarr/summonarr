import { NextResponse } from "next/server";
import { isFeatureEnabled } from "./features";
import { CLEANUP_FEATURE_KEY } from "./library-cleanup-data";
import type { Translator } from "./i18n/translate";

/**
 * The 404 every /api/admin/cleanup route answers while Library cleanup
 * (`feature.admin.cleanup`) is switched off; null when it is on.
 */
export async function cleanupDisabledResponse(t: Translator): Promise<NextResponse | null> {
  return (await isFeatureEnabled(CLEANUP_FEATURE_KEY))
    ? null
    : NextResponse.json({ error: t("apiAdmin.cleanup.disabled") }, { status: 404 });
}
