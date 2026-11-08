import { withAdmin } from "@/lib/api-auth";
import { getPlexConfig } from "@/lib/plex-config";
import { getPlexLibrarySections } from "@/lib/plex";
import { listServerLibraries } from "@/lib/server-library-picker";

// One Plex server's library sections, for the instance (?instance=) the picker
// is choosing for (server-library-picker.ts).
export const GET = withAdmin(async (req) =>
  listServerLibraries(req, {
    load: async (instance) => {
      const { url, token } = await getPlexConfig(instance);
      return url && token ? { url, credential: token } : null;
    },
    list: getPlexLibrarySections,
    notConfiguredKey: "apiAdmin.common.plexNotConfiguredShort",
    failedKey: "apiAdmin.settings.plexConnectFailed",
    scope: "settings/plex/libraries",
  }),
);
