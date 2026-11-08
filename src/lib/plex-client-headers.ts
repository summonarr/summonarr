// The X-Plex-* identification headers a plex.tv call sends, in one zero-import
// module so the browser (the /auth/plex/done PIN poll) and the server can share
// one copy — the product name and version can't drift between callers.
export const PLEX_PRODUCT = "Summonarr";
export const PLEX_CLIENT_VERSION = "1.0";

/** What a request says about the device asking. Defaults: the hosted web app. */
export interface PlexClientDevice {
  platform: string;
  device: string;
  model: string;
}

export const WEB_PLEX_CLIENT_DEVICE: PlexClientDevice = { platform: "Web", device: "Web", model: "hosted" };

/** The three headers that name the client: identifier, product and version. */
export function plexClientIdentity(clientId: string): Record<string, string> {
  return {
    "X-Plex-Client-Identifier": clientId,
    "X-Plex-Product": PLEX_PRODUCT,
    "X-Plex-Version": PLEX_CLIENT_VERSION,
  };
}

/** The client-identification headers for `clientId`, plus `Accept: application/json`. */
export function plexClientHeaders(
  clientId: string,
  device: PlexClientDevice = WEB_PLEX_CLIENT_DEVICE,
): Record<string, string> {
  return {
    ...plexClientIdentity(clientId),
    "X-Plex-Model": device.model,
    "X-Plex-Device": device.device,
    "X-Plex-Device-Name": PLEX_PRODUCT,
    "X-Plex-Platform": device.platform,
    Accept: "application/json",
  };
}
