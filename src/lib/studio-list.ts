// Pure, zero-import: the studios and networks a title page links to.
//
// TMDB's /discover takes a production company (`with_companies`, movies and TV)
// and a TV network (`with_networks`) by ID, so a name alone cannot be browsed.
// Both detail mappers (tmdb.ts normalize and tmdb-prewarm.ts) build the list
// here so the cached :details payloads agree. Titles cached before this existed
// carry no `studioList` and simply render no links until their cache row
// refreshes.

export interface StudioRef {
  id: number;
  name: string;
  kind: "company" | "network";
}

/** More than this is noise on a detail page (some titles list 15+ companies). */
export const MAX_STUDIO_LINKS = 8;

interface Named {
  id?: number | null;
  name?: string | null;
}

function usable(c: Named): c is { id: number; name: string } {
  return typeof c.id === "number" && Number.isInteger(c.id) && c.id > 0 && typeof c.name === "string" && c.name.trim() !== "";
}

/**
 * TV: networks first (the thing people actually browse by), then companies.
 * Movies: companies only. An id appears once per kind.
 */
export function buildStudioList(
  mediaType: "MOVIE" | "TV",
  networks: readonly Named[] | null | undefined,
  companies: readonly Named[] | null | undefined,
): StudioRef[] {
  const out: StudioRef[] = [];
  const seen = new Set<string>();
  const add = (list: readonly Named[] | null | undefined, kind: StudioRef["kind"]) => {
    for (const c of list ?? []) {
      if (!usable(c)) continue;
      const key = `${kind}:${c.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: c.id, name: c.name.trim().slice(0, 100), kind });
      if (out.length >= MAX_STUDIO_LINKS) return;
    }
  };
  if (mediaType === "TV") add(networks, "network");
  if (out.length < MAX_STUDIO_LINKS) add(companies, "company");
  return out;
}

/** US certifications TMDB's discover can cap at, strictest first. */
export const CERTIFICATION_CAPS = ["G", "PG", "PG-13", "R", "NC-17"] as const;
export type CertificationCap = (typeof CERTIFICATION_CAPS)[number];

export function isCertificationCap(v: unknown): v is CertificationCap {
  return typeof v === "string" && (CERTIFICATION_CAPS as readonly string[]).includes(v);
}
