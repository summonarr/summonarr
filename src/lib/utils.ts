import { twMerge } from "@/lib/tw-merge";

// Matches clsx's permissive surface: callers pass strings, numbers, arrays, or
// dictionaries. Functions and other types fall through silently — base-ui's
// state-aware className functions land here when forwarded through cn().
export type ClassValue = unknown;

function clsx(input: ClassValue): string {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (typeof input === "number") return String(input);
  if (Array.isArray(input)) return input.map(clsx).filter(Boolean).join(" ");
  if (typeof input === "object") {
    return Object.entries(input as Record<string, unknown>)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(" ");
  }
  return "";
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
