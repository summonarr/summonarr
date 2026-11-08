import { LocalDateText } from "@/components/local-date";
import { Chip } from "@/components/ui/design";
import { formatBitrate, parsePlaybackContext } from "@/lib/issue-playback-context";
import { translateTranscodeReason } from "@/lib/transcode-reasons";
import type { Translator } from "@/lib/i18n/translate";

const METHOD_KEYS: Record<string, string> = {
  DirectPlay: "adminActivity.method.directPlay",
  DirectStream: "adminActivity.method.directStream",
  Transcode: "adminActivity.method.transcode",
};

// What the reporter's last play of the title looked like, for the admin triaging
// the issue (server component). `value` is the stored Json column, parsed
// defensively; absent or unreadable renders nothing.
export function IssuePlaybackContext({ value, t }: { value: unknown; t: Translator }) {
  const ctx = parsePlaybackContext(value);
  if (!ctx) return null;
  const client = [ctx.player ?? ctx.platform, ctx.device].filter(Boolean).join(" · ");
  const method = ctx.playMethod ? (METHOD_KEYS[ctx.playMethod] ? t(METHOD_KEYS[ctx.playMethod]) : ctx.playMethod) : null;
  const media = [ctx.videoCodec, ctx.resolution, ctx.audioCodec, ctx.container].filter(Boolean).join(" ");
  // lan/wan are shown as the server reported them; a relayed play is named in
  // the viewer's language.
  const where = ctx.relayed ? t("adminActivity.field.relay") : ctx.location;
  return (
    <div style={{ marginTop: 6, fontSize: 11, color: "var(--ds-fg-subtle)" }}>
      <p className="ds-mono" style={{ margin: 0 }}>
        {t("adminQueue.issues.playback.lastPlay")}
        {" · "}
        <LocalDateText iso={ctx.playedAt} />
        {!ctx.exact && ` · ${t("adminQueue.issues.playback.otherEpisode")}`}
      </p>
      <div className="flex items-center flex-wrap" style={{ gap: 4, marginTop: 4 }}>
        <Chip>{ctx.source === "plex" ? "Plex" : ctx.source === "jellyfin" ? "Jellyfin" : ctx.source}</Chip>
        {client && <Chip>{client}</Chip>}
        {method && <Chip tone={ctx.playMethod === "Transcode" ? "pending" : undefined}>{method}</Chip>}
        {media && <Chip>{media}</Chip>}
        {ctx.bitrateKbps != null && <Chip>{formatBitrate(ctx.bitrateKbps)}</Chip>}
        {where && <Chip>{where}</Chip>}
      </div>
      {ctx.transcodeReason && (
        <p style={{ margin: "4px 0 0" }}>
          {t("adminQueue.issues.playback.why", { reason: translateTranscodeReason(ctx.transcodeReason, t) })}
        </p>
      )}
    </div>
  );
}
