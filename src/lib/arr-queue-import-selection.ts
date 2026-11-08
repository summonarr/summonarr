// The Manual Import dialog's selection rules — the only part of the import
// half a client component needs. Pure; re-exported by arr-queue.ts.
import type { ImportCandidate } from "./arr-queue-import";

/**
 * What the Import dialog pre-selects: the matched files the arr had no
 * objection to; when every matched file was refused (the usual blocked
 * import), all of them — the admin opened Import to override exactly those
 * refusals. An unmatched file is never pre-selected (it can't be imported).
 */
export function defaultImportSelection(files: readonly ImportCandidate[]): Set<string> {
  const matched = files.filter((f) => f.importable);
  const clean = matched.filter((f) => f.rejections.length === 0);
  return new Set((clean.length > 0 ? clean : matched).map((f) => f.path));
}

/**
 * The import dialog's selection once a file's verdict changes (a correction
 * applied or reset): an importable file is ticked, one that can't be imported
 * any more is unticked — its checkbox is disabled, so it could never be
 * unticked by hand and would still be counted and sent.
 */
export function nextImportSelection(selected: ReadonlySet<string>, path: string, importable: boolean): Set<string> {
  const next = new Set(selected);
  if (importable) next.add(path);
  else next.delete(path);
  return next;
}
