// Subtree-wide loading skeleton for the admin panel. Next renders this for any
// admin route that doesn't define its own loading.tsx, so every slow admin page
// (library, audit-log, stats, users, backup, …) gets a skeleton instead of a
// blocked navigation.
import { AdminSkeleton } from "@/components/loading/admin-skeleton";

export default function Loading() {
  return <AdminSkeleton />;
}
