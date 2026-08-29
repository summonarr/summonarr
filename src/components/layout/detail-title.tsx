"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

// Lets a media detail page tell the header what it is looking at, so the
// breadcrumb can read "Movies › Blade Runner 2049" instead of the literal
// "Movies › Detail".
//
// A context is needed because the breadcrumb lives in <Header> / <MobileNav>,
// which are rendered by (app)/layout.tsx — a layout cannot read its page's
// data, and breadcrumbFor() only ever received a pathname. The page publishes
// its title on mount; both consumers read it.
//
// Both server and client start at `null` and render the "Detail" fallback, so
// hydration matches; the real title lands one effect later. Deliberately not a
// state library — this is one string (guardrail 9).

interface DetailTitleValue {
  title: string | null;
  setTitle: (title: string | null) => void;
}

const DetailTitleContext = createContext<DetailTitleValue>({
  title: null,
  setTitle: () => {},
});

export function DetailTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<string | null>(null);
  const value = useMemo(() => ({ title, setTitle }), [title]);
  return (
    <DetailTitleContext.Provider value={value}>
      {children}
    </DetailTitleContext.Provider>
  );
}

export function useDetailTitle(): string | null {
  return useContext(DetailTitleContext).title;
}

// Rendered by /movie/[id] and /tv/[id]. Renders nothing; it exists to publish
// the title and to clear it on unmount so navigating back to a list page
// doesn't leave a stale title in the breadcrumb.
export function DetailTitle({ title }: { title: string }) {
  const { setTitle } = useContext(DetailTitleContext);
  useEffect(() => {
    setTitle(title);
    return () => setTitle(null);
  }, [title, setTitle]);
  return null;
}
