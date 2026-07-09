"use client";

import { useEffect } from "react";

// Section-scoped error boundary for the admin subtree. Without it, a render
// error in any admin page bubbles to the (app)-root boundary and unmounts the
// whole authenticated shell; scoping it here keeps a failing admin panel from
// taking down navigation. Mirrors src/app/(app)/error.tsx (Next 16 passes
// `unstable_retry`, not `reset`).
export default function AdminError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("[admin/error]", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-8">
      <h2 className="text-xl font-semibold text-white">Admin panel error</h2>
      <p className="text-zinc-400 text-sm max-w-sm">
        Something went wrong loading this admin section. The rest of the app is unaffected.
      </p>
      <button
        onClick={() => unstable_retry()}
        className="px-4 py-2 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
      >
        Try again
      </button>
    </div>
  );
}
