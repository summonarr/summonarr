// Saving a fetched body as a file, and reading the file name the server chose.

/** The `filename` of a Content-Disposition header, else `fallback`. A path in it is reduced to its last segment. */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  const match = header ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header) : null;
  if (!match) return fallback;
  let name: string;
  try {
    name = decodeURIComponent(match[1]);
  } catch {
    name = match[1];
  }
  const last = name.split(/[\\/]/).pop()?.trim();
  return last ? last : fallback;
}

// The anchor is attached while it is clicked and the URL outlives the click:
// some browsers (Safari, older Firefox) start the download after click()
// returns, and a revoked URL there saves nothing.
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
