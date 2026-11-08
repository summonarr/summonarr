import { withAdmin } from "@/lib/api-auth";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { getJellyfinMediaFolders } from "@/lib/jellyfin";
import { listServerLibraries } from "@/lib/server-library-picker";

// One Jellyfin server's media folders, for the instance (?instance=) the picker
// is choosing for (server-library-picker.ts). Jellyfin ids are GUIDs so they do
// not collide, but listing the wrong server still offers libraries the target
// does not have.
export const GET = withAdmin(async (req) =>
  listServerLibraries(req, {
    load: async (instance) => {
      const { url, apiKey } = await getJellyfinConfig(instance);
      return url && apiKey ? { url, credential: apiKey } : null;
    },
    list: getJellyfinMediaFolders,
    notConfiguredKey: "apiAdmin.common.jellyfinNotConfiguredShort",
    failedKey: "apiAdmin.settings.jellyfinConnectFailed",
    scope: "settings/jellyfin/libraries",
  }),
);
