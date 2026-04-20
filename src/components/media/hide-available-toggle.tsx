"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

interface HideAvailableToggleProps {
  active: boolean;
}

export function HideAvailableToggle({ active }: HideAvailableToggleProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function toggle() {
    const params = new URLSearchParams(searchParams.toString());
    if (active) {
      params.delete("hideAvailable");
    } else {
      params.set("hideAvailable", "1");
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div className="mb-8">
      <button
        onClick={toggle}
        className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border transition-colors ${
          active
            ? "bg-indigo-600/20 border-indigo-500/50 text-indigo-300"
            : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-500"
        }`}
      >
        Hide Available
      </button>
    </div>
  );
}
