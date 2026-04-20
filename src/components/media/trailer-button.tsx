"use client";

import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";

interface TrailerButtonProps {
  trailerKey?: string | null;
  trailerUrl?: string | null;
}

export function TrailerButton({ trailerKey, trailerUrl }: TrailerButtonProps) {
  const href = trailerKey ? `https://www.youtube.com/watch?v=${trailerKey}` : trailerUrl;
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      <Button
        variant="outline"
        className="gap-2 border-zinc-600 text-zinc-300 hover:text-white hover:border-zinc-400"
      >
        <Play className="w-4 h-4" />
        Watch Trailer
      </Button>
    </a>
  );
}
