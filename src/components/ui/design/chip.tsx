import { cn } from "@/lib/utils";

export type ChipTone =
  | "neutral"
  | "plex"
  | "jellyfin"
  | "pending"
  | "approved"
  | "declined"
  | "accent";

const toneClass: Record<ChipTone, string> = {
  neutral: "",
  plex: "ds-chip-plex",
  jellyfin: "ds-chip-jellyfin",
  pending: "ds-chip-pending",
  approved: "ds-chip-approved",
  declined: "ds-chip-declined",
  accent: "ds-chip-accent",
};

export function Chip({
  tone = "neutral",
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: ChipTone }) {
  return (
    <span className={cn("ds-chip", toneClass[tone], className)} {...props}>
      {children}
    </span>
  );
}
