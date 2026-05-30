import "server-only";

export interface TmdbAuth {
  headers: Record<string, string>;
  query: Record<string, string>;
}

// TMDB_READ_TOKEN (v4 bearer) is the only supported credential — sent as a bearer
// header so the key never appears in upstream access logs or the Referer header.
// Callers inject the returned headers/query into every TMDB request so auth strategy is centralised here.
export function tmdbAuth(): TmdbAuth | null {
  const readToken = process.env.TMDB_READ_TOKEN;
  if (readToken) {
    return { headers: { Authorization: `Bearer ${readToken}` }, query: {} };
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
