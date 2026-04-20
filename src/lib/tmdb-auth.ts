import "server-only";

let legacyTmdbAuthWarned = false;

export interface TmdbAuth {
  headers: Record<string, string>;
  query: Record<string, string>;
}

// TMDB_READ_TOKEN (v4 bearer) is preferred; TMDB_API_KEY (v3 query-string) is the legacy fallback.
// Callers inject the returned headers/query into every TMDB request so auth strategy is centralised here.
export function tmdbAuth(): TmdbAuth | null {
  const readToken = process.env.TMDB_READ_TOKEN;
  if (readToken) {
    return { headers: { Authorization: `Bearer ${readToken}` }, query: {} };
  }
  const apiKey = process.env.TMDB_API_KEY;
  if (apiKey) {
    if (!legacyTmdbAuthWarned) {
      legacyTmdbAuthWarned = true;
      console.warn(
        "[tmdb] Using legacy TMDB_API_KEY query-string auth. The key will appear in upstream " +
        "access logs and the local Referer header. Set TMDB_READ_TOKEN (v4 read access token) " +
        "instead to use the bearer header. See SECURITY_AUDIT.md M-10."
      );
    }
    return { headers: {}, query: { api_key: apiKey } };
  }
  return null;
}

export function buildTmdbUrl(path: string): { url: string; headers: Record<string, string> } | null {
  const auth = tmdbAuth();
  if (!auth) return null;
  const url = new URL(path.startsWith("http") ? path : `https://api.themoviedb.org/3${path}`);
  for (const [k, v] of Object.entries(auth.query)) url.searchParams.set(k, v);
  return { url: url.toString(), headers: auth.headers };
}
