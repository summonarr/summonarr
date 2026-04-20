"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2 } from "lucide-react";

export function DeletePlayButton({ id }: { id: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/play-history/${id}`, { method: "DELETE" });
      if (res.ok) {
        router.push("/admin/activity?tab=history");
        router.refresh();
      }
    } finally {
      setDeleting(false);
    }
  }

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-500 hover:text-red-400 border border-zinc-700 hover:border-red-500/50 rounded-lg transition-colors"
      >
        <Trash2 className="w-3.5 h-3.5" />
        Delete record
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-zinc-400">Delete this play record?</span>
      <button
        onClick={() => setConfirming(false)}
        disabled={deleting}
        className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
      >
        Cancel
      </button>
      <button
        onClick={handleDelete}
        disabled={deleting}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-red-600 text-white hover:bg-red-500 transition-colors disabled:opacity-50"
      >
        {deleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        Delete
      </button>
    </div>
  );
}
