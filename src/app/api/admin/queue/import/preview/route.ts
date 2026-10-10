import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { previewImport } from "@/lib/arr-queue-data";
import { IMPORT_MAX_BODY_BYTES, importFailure, importGate, parseImportSelections } from "@/lib/arr-queue-http";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin → Download Queue → Import, a file's corrections re-checked (ADMIN):
// { service, instance, downloadId, files: [{ path, …corrections }] } → the same
// files with the corrections applied (checked against the instance's own
// catalogs — 400 otherwise) and RE-JUDGED by the arr's manual-import
// reprocess: fresh refusal reasons, and for Sonarr the episodes it resolves.
// `rechecked: false` when the arr couldn't reprocess (an older version) — the
// corrections still show, without its verdict. Imports nothing, writes nothing.
export const POST = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, IMPORT_MAX_BODY_BYTES);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const target = await importGate(body.service, body.instance, body.downloadId, t);
  if (target instanceof NextResponse) return target;
  const selections = parseImportSelections(target.service, body);
  if (!selections) return NextResponse.json({ error: t("apiAdmin.queue.importBodyInvalid") }, { status: 400 });
  try {
    return NextResponse.json(await previewImport(target.service, target.instance, target.downloadId, selections));
  } catch (err) {
    return importFailure(err, target.service, target.instance, t, "import preview");
  }
});
