import { hasPermission, Permission } from "@/lib/permissions";

// The on-disk path of a library item as a caller may see it. Mount layout is
// ADMIN data everywhere else (library-sample-paths, issues/[id]/files are
// withAdmin), but the fix-match routes admit a MANAGE_ISSUES delegate — and
// their dialogs only ever show the file NAME (the full path was a tooltip). So
// an ADMIN gets the path, and a delegate the name alone: enough to tell two
// copies apart, nothing about bind-mount roots or the naming scheme of every
// configured server.
export function libraryFileName(filePath: string): string {
  let end = filePath.length;
  while (end > 0 && (filePath[end - 1] === "/" || filePath[end - 1] === "\\")) end--;
  let start = end;
  while (start > 0 && filePath[start - 1] !== "/" && filePath[start - 1] !== "\\") start--;
  return filePath.slice(start, end);
}

export function libraryPathFor(permissions: bigint, filePath: string | null | undefined): string | null {
  if (filePath == null) return null;
  return hasPermission(permissions, Permission.ADMIN) ? filePath : libraryFileName(filePath);
}
