import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { loadStorage } from "@/lib/arr-system-data";

// Admin → Arr System → Storage (ADMIN): every configured instance's root
// folders (free space, whether the arr can reach them, and the folders in
// them it has no title for) and the disks it reports.
//   GET → { instances, errors, results: [{ service, instance, rootFolders, disks }] }.
// Read live; nothing cached or written.
export const GET = withAdmin(async () => {
  return NextResponse.json(await loadStorage());
});
