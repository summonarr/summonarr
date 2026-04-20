"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PaginationBarProps {
  currentPage: number;
  totalPages: number;
}

export function PaginationBar({ currentPage, totalPages }: PaginationBarProps) {
  const searchParams = useSearchParams();

  function buildHref(page: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(page));
    return `?${params.toString()}`;
  }

  if (totalPages <= 1) return null;

  const hasPrev = currentPage > 1;
  const hasNext = currentPage < totalPages;

  const pages: number[] = [];
  const start = Math.max(1, currentPage - 2);
  const end   = Math.min(totalPages, currentPage + 2);
  for (let i = start; i <= end; i++) pages.push(i);

  const pageBase = "inline-flex h-8 w-8 items-center justify-center rounded-lg border text-sm font-medium transition-colors";
  const pageActive = "bg-indigo-600 border-indigo-600 text-white";
  const pageInactive = "border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-500";

  return (
    <div className="flex items-center justify-center gap-1 mt-8">
      {hasPrev ? (
        <Link href={buildHref(currentPage - 1)}>
          <Button variant="outline" size="sm" className="h-8 px-2 border-zinc-700 text-zinc-400 hover:text-white">
            <ChevronLeft className="w-4 h-4" />
          </Button>
        </Link>
      ) : (
        <Button variant="outline" size="sm" disabled className="h-8 px-2 border-zinc-800 text-zinc-700">
          <ChevronLeft className="w-4 h-4" />
        </Button>
      )}

      {start > 1 && (
        <>
          <Link href={buildHref(1)} className={`${pageBase} ${pageInactive}`}>1</Link>
          {start > 2 && <span className="text-zinc-600 text-sm px-1">…</span>}
        </>
      )}

      {pages.map((p) =>
        p === currentPage ? (
          <span key={p} className={`${pageBase} ${pageActive}`}>{p}</span>
        ) : (
          <Link key={p} href={buildHref(p)} className={`${pageBase} ${pageInactive}`}>{p}</Link>
        )
      )}

      {end < totalPages && (
        <>
          {end < totalPages - 1 && <span className="text-zinc-600 text-sm px-1">…</span>}
          <Link href={buildHref(totalPages)} className={`${pageBase} ${pageInactive}`}>{totalPages}</Link>
        </>
      )}

      {hasNext ? (
        <Link href={buildHref(currentPage + 1)}>
          <Button variant="outline" size="sm" className="h-8 px-2 border-zinc-700 text-zinc-400 hover:text-white">
            <ChevronRight className="w-4 h-4" />
          </Button>
        </Link>
      ) : (
        <Button variant="outline" size="sm" disabled className="h-8 px-2 border-zinc-800 text-zinc-700">
          <ChevronRight className="w-4 h-4" />
        </Button>
      )}
    </div>
  );
}
