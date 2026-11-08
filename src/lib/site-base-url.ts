import { plexReturnBase } from "@/lib/client/plex-approval-url";
import { warnOnChange } from "@/lib/log-dedup";

const LOCAL_FALLBACK = "http://localhost:3000";

/**
 * The app's public root for a URL an admin copies into another service (the
 * Radarr/Sonarr webhook URLs on the settings page): the Site URL setting, else
 * AUTH_URL, else localhost — with BASE_PATH on the end, no trailing slash.
 *
 * Blank falls through with `||`, not `??`: clearing Site URL stores "" (the
 * settings route's clearable keys), and "" must not become a relative URL.
 * The base path follows plexReturnBase's rule (also email.ts's for AUTH_URL):
 * appended unless the URL already ends with it, because AUTH_URL is a bare
 * origin and the app is served only under BASE_PATH.
 */
export function siteBaseUrl(
  siteUrl: string | null | undefined,
  authUrl: string | null | undefined,
  basePath: string | null | undefined,
): string {
  const configured = siteUrl?.trim() || authUrl?.trim() || "";
  // Every link built on the fallback points at localhost, which works only on
  // the server itself. Said once (guardrail 7b), and not in development, where
  // localhost is the right answer.
  if (!configured && process.env.NODE_ENV !== "development") {
    warnOnChange(
      "site-base-url:fallback",
      "localhost",
      `[site-base-url] neither the Site URL setting nor AUTH_URL is set; copied links use ${LOCAL_FALLBACK}`,
    );
  }
  return plexReturnBase(configured, LOCAL_FALLBACK, basePath ?? "");
}
