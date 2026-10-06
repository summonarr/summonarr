"use client";

// Subtree-wide loading skeleton for the admin panel. Next renders this for any
// admin route that doesn't define its own loading.tsx (loading.js wraps page.js
// AND every child segment — see node_modules/next/dist/docs/01-app/
// 03-api-reference/03-file-conventions/loading.md), so every slow admin page
// (library, audit-log, users, backup, …) gets a skeleton instead of a blocked
// navigation.
//
// The request QUEUE lives at this segment's own page.tsx, so the only way to
// give it a shape of its own without also handing that shape to every child
// route is to pick here, by pathname (loading.tsx may be a Client Component).
// usePathname updates in the same router commit that renders the fallback, so
// a navigation to /admin reads "/admin" and gets the stat row + filter bar +
// 110px cards the queue renders; anything else keeps the neutral AdminSkeleton.
import { usePathname } from "next/navigation";
import { AdminQueueSkeleton, AdminSkeleton } from "@/components/loading/admin-skeleton";
import { withBasePath } from "@/lib/base-path";

export default function Loading() {
  const pathname = usePathname().replace(/\/+$/, "");
  // usePathname is app-relative, but accept the base-path-prefixed form too so
  // a BASE_PATH deployment can never fall through to the generic shape.
  const isQueue = pathname === "/admin" || pathname === withBasePath("/admin");
  return isQueue ? <AdminQueueSkeleton /> : <AdminSkeleton />;
}
