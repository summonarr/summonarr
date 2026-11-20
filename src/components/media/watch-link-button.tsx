"use client";

import { ExternalLink, MonitorPlay } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { mediaServerName } from "@/lib/media-server-name";
import type { WatchLink } from "@/lib/watch-links";
import { DETAIL_ACTION_CLASS, detailActionStyle } from "./detail-action-button";

// How long the server's own app gets to take over before the web page opens.
const APP_HANDOFF_MS = 1500;

// An iPhone or iPad, the only place the app link is known to work. Read on
// click, never during render (guardrail 16). iPadOS reports a Mac with touch.
function isAppleMobile(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

// "Watch on Plex" / "Watch on Jellyfin": opens the title on the media server.
// A plain link to the server's web client; on an iPhone or iPad a link with an
// app address (Plex, or Swiftfin for Jellyfin) is handed to the app first, and
// the web page opens only when no app took over.
export function WatchLinkButton({ link }: { link: WatchLink }) {
  const t = useT();
  const server = mediaServerName(link.server);
  const label = link.name ? t("detail.watchOnNamed", { server, name: link.name }) : t("detail.watchOn", { server });

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (!link.appUrl || !isAppleMobile()) return;
    e.preventDefault();
    const { webUrl } = link;
    window.setTimeout(() => {
      // Still looking at this page: no app answered the link.
      if (document.visibilityState === "visible") window.location.assign(webUrl);
    }, APP_HANDOFF_MS);
    window.location.assign(link.appUrl);
  }

  return (
    <a
      href={link.webUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      className={DETAIL_ACTION_CLASS}
      style={detailActionStyle("secondary")}
    >
      <MonitorPlay style={{ width: 14, height: 14 }} />
      {label}
      <ExternalLink style={{ width: 12, height: 12, opacity: 0.6 }} />
    </a>
  );
}
