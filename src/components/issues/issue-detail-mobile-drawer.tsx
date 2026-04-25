"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Film, Tv2, X } from "lucide-react";
import {
  Drawer,
  DrawerPortal,
  DrawerBackdrop,
  DrawerPopup,
  DrawerTitle,
  DrawerClose,
} from "@/components/ui/drawer";
import { Chip, type ChipTone } from "@/components/ui/design";
import { IssueThread } from "@/components/issues/issue-thread";

const STATUS_TONE: Record<string, ChipTone> = {
  OPEN: "declined",
  IN_PROGRESS: "pending",
  RESOLVED: "approved",
};

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In Progress",
  RESOLVED: "Resolved",
};

const ISSUE_TYPE_LABELS: Record<string, string> = {
  BAD_VIDEO: "Bad video quality",
  WRONG_AUDIO: "Wrong / missing audio",
  MISSING_SUBTITLES: "Missing subtitles",
  WRONG_MATCH: "Wrong match",
  OTHER: "Other",
};

export interface IssueDrawerPayload {
  id: string;
  title: string;
  posterUrl: string | null;
  mediaType: "MOVIE" | "TV" | string;
  status: string;
  issueType: string;
  scope: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  note: string | null;
  resolution: string | null;
  createdAt: string;
  messageCount: number;
}

function scopeLabel(p: IssueDrawerPayload): string | null {
  if (p.scope === "EPISODE" && p.seasonNumber != null && p.episodeNumber != null) {
    return `S${String(p.seasonNumber).padStart(2, "0")}E${String(p.episodeNumber).padStart(2, "0")}`;
  }
  if (p.scope === "SEASON" && p.seasonNumber != null) {
    return `Season ${p.seasonNumber}`;
  }
  return null;
}

interface Props {
  selectedIssue: IssueDrawerPayload | null;
  closeHref: string;
}

export function IssueDetailMobileDrawer({ selectedIssue, closeHref }: Props) {
  const router = useRouter();
  const [isMobile, setIsMobile] = useState(false);
  const [stickyIssue, setStickyIssue] = useState<IssueDrawerPayload | null>(
    selectedIssue,
  );
  const [closedId, setClosedId] = useState<string | null>(null);

  if (selectedIssue && selectedIssue !== stickyIssue) {
    setStickyIssue(selectedIssue);
  }
  if (selectedIssue === null && closedId !== null) {
    setClosedId(null);
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 1279.98px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  if (!isMobile) return null;

  const open = Boolean(selectedIssue) && selectedIssue?.id !== closedId;
  const issue = stickyIssue;
  const label = issue ? scopeLabel(issue) : null;

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next && open && selectedIssue) {
          setClosedId(selectedIssue.id);
          router.push(closeHref, { scroll: false });
        }
      }}
    >
      <DrawerPortal>
        <DrawerBackdrop />
        <DrawerPopup
          className="border-t"
          style={{
            background: "var(--ds-bg-1)",
            borderColor: "var(--ds-border)",
            maxHeight: "92dvh",
          }}
        >
          <DrawerTitle>
            {issue ? `Issue: ${issue.title}` : "Issue"}
          </DrawerTitle>
          {issue && (
            <>
              <div
                className="shrink-0"
                style={{
                  padding: "0 16px 14px",
                  borderBottom: "1px solid var(--ds-border)",
                }}
              >
                <div className="flex items-start" style={{ gap: 12 }}>
                  <div
                    className="relative shrink-0 overflow-hidden"
                    style={{
                      width: 56,
                      aspectRatio: "2 / 3",
                      borderRadius: 4,
                      background: "var(--ds-bg-3)",
                    }}
                  >
                    {issue.posterUrl ? (
                      <Image
                        src={issue.posterUrl}
                        alt={issue.title}
                        fill
                        className="object-cover"
                        sizes="56px"
                      />
                    ) : (
                      <div
                        className="absolute inset-0 flex items-center justify-center"
                        style={{ color: "var(--ds-fg-subtle)" }}
                      >
                        {issue.mediaType === "MOVIE" ? (
                          <Film style={{ width: 18, height: 18 }} />
                        ) : (
                          <Tv2 style={{ width: 18, height: 18 }} />
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p
                      className="font-semibold"
                      style={{
                        fontSize: 14,
                        color: "var(--ds-fg)",
                        margin: 0,
                        wordBreak: "break-word",
                      }}
                    >
                      {issue.title}
                    </p>
                    <div
                      className="flex items-center flex-wrap"
                      style={{ gap: 6, marginTop: 6 }}
                    >
                      <Chip tone={STATUS_TONE[issue.status]}>
                        {STATUS_LABEL[issue.status] ?? issue.status}
                      </Chip>
                      <Chip>
                        {ISSUE_TYPE_LABELS[issue.issueType] ?? issue.issueType}
                      </Chip>
                      {label && <Chip>{label}</Chip>}
                    </div>
                    <p
                      className="ds-mono"
                      style={{
                        marginTop: 6,
                        fontSize: 10.5,
                        color: "var(--ds-fg-subtle)",
                      }}
                    >
                      Reported {new Date(issue.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <DrawerClose
                    className="shrink-0 inline-flex items-center justify-center"
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 6,
                      border: "1px solid var(--ds-border)",
                      background: "var(--ds-bg-2)",
                      color: "var(--ds-fg-muted)",
                    }}
                    aria-label="Close issue"
                  >
                    <X style={{ width: 16, height: 16 }} />
                  </DrawerClose>
                </div>
                {issue.note && (
                  <p
                    className="whitespace-pre-wrap"
                    style={{
                      marginTop: 12,
                      padding: "8px 12px",
                      borderRadius: 4,
                      background: "var(--ds-bg-2)",
                      borderLeft:
                        "2px solid color-mix(in oklab, var(--ds-warning) 40%, transparent)",
                      fontSize: 12,
                      color: "var(--ds-fg-muted)",
                    }}
                  >
                    {issue.note}
                  </p>
                )}
                {issue.resolution && (
                  <p
                    className="italic"
                    style={{
                      marginTop: 8,
                      fontSize: 12,
                      color:
                        "color-mix(in oklab, var(--ds-success) 85%, var(--ds-fg))",
                    }}
                  >
                    Resolution: {issue.resolution}
                  </p>
                )}
              </div>
              <IssueThread
                issueId={issue.id}
                initialCount={issue.messageCount}
                variant="panel"
              />
            </>
          )}
        </DrawerPopup>
      </DrawerPortal>
    </Drawer>
  );
}
