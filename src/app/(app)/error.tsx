"use client";

import { useEffect } from "react";

export default function AppError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("[app/error]", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-8">
      <h2 className="text-xl font-semibold text-white">Something went wrong</h2>
      <p className="text-zinc-400 text-sm max-w-sm">
        An unexpected error occurred. Try refreshing the page.
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
