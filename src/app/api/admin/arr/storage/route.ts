import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { snapshotted } from "@/lib/arr-snapshot";
import { loadStorage } from "@/lib/arr-system-data";

// Admin → Arr System → Storage (ADMIN): every configured instance's root
// folders (free space, whether the arr can reach them, and the folders in
// them it has no title for) and the disks it reports.
//   GET → { instances, errors, results: [{ service, instance, rootFolders, disks }] }.
// Read live; nothing written. The last answer is kept for display only
// (`?cached=1`, src/lib/arr-snapshot.ts).
export const GET = withAdmin(snapshotted(async () => {
  return NextResponse.json(await loadStorage());
}));
