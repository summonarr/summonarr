import { Fragment } from "react";
import { RequestButton } from "@/components/media/request-button";
import { Request4kButton } from "@/components/media/request-4k-button";
import { RequestInstanceButton } from "@/components/media/request-instance-button";
import { WatchlistButton } from "@/components/media/watchlist-button";
import { HideButton } from "@/components/media/hide-button";
import { ReportIssueButton } from "@/components/media/report-issue-button";
import { TrailerButton } from "@/components/media/trailer-button";
import { VoteDeleteButton } from "@/components/votes/vote-delete-button";
import { OpenInArrLink, arrInstanceLabel } from "@/components/admin/open-in-arr";
import { ArrManageButton } from "@/components/admin/arr-title/title-manager";
import { ArrAddButton } from "@/components/admin/arr-title/add-dialog";
import type { parseManageLink } from "@/lib/arr-links-data";
import type { DetailMediaType, DetailPageState } from "@/lib/detail-page-data";
import type { Translator } from "@/lib/i18n/translate";

// The action row of a movie or TV detail page: Request (default, 4K, each
// named instance), Watchlist, Hide, Report issue, Vote to delete, Trailer, and
// an admin's Radarr/Sonarr controls. One copy for both pages; the state comes
// from loadDetailPageState.
//
// Every action button is keyed on the title: client navigation from one title
// to another reuses this row, and a button must not carry the previous title's
// client state across.
export function DetailActions({
  media,
  mediaType,
  state,
  canRequest,
  tvdbId,
  manageLink,
  t,
}: {
  media: {
    id: number;
    title: string;
    posterPath: string | null;
    trailerKey?: string | null;
    trailerUrl?: string | null;
  };
  mediaType: DetailMediaType;
  state: DetailPageState;
  // The viewer can request this media type on the default instance.
  canRequest: boolean;
  // TV only: the series' TVDB id for the issue report.
  tvdbId?: number | null;
  manageLink: ReturnType<typeof parseManageLink>;
  t: Translator;
}) {
  const service = mediaType === "MOVIE" ? "radarr" : "sonarr";
  // The Report-issue and Vote-to-delete actions need the title in a library this viewer sees.
  const inVisibleLibrary = (state.showPlex && state.plexAvailable) || (state.showJellyfin && state.jellyfinAvailable);
  return (
    /* items-end, not items-center: RequestButton is a flex-col block
       (availability/queue status line above its CTA), so centering
       floated the sibling buttons above the CTA whenever a status
       line rendered. */
    <div
      className="flex items-end flex-wrap"
      style={{ gap: 10, marginTop: 6 }}
    >
      <RequestActions media={media} mediaType={mediaType} state={state} canRequest={canRequest} />
      <WatchlistButton key={`watchlist-${media.id}`} tmdbId={media.id} mediaType={mediaType} initialOnWatchlist={state.onWatchlist} />
      <HideButton
        key={`hide-${media.id}`}
        tmdbId={media.id}
        mediaType={mediaType}
        title={media.title}
        posterPath={media.posterPath}
        initialHidden={state.onHidden}
      />
      {state.issuesEnabled && inVisibleLibrary && (
        <ReportIssueButton
          tmdbId={media.id}
          tvdbId={tvdbId}
          mediaType={mediaType}
          title={media.title}
          posterPath={media.posterPath}
        />
      )}
      {state.votesEnabled && inVisibleLibrary && (
        <VoteDeleteButton
          key={`vote-${media.id}`}
          tmdbId={media.id}
          mediaType={mediaType}
          requestToken={state.requestToken}
          alreadyVoted={state.alreadyVoted}
        />
      )}
      {(media.trailerKey || media.trailerUrl) && (
        <TrailerButton trailerKey={media.trailerKey} trailerUrl={media.trailerUrl} />
      )}
      <ArrInstanceActions mediaId={media.id} service={service} arrLinks={state.arrLinks} manageLink={manageLink} t={t} />
    </div>
  );
}

// Request on the default instance, on the 4K one when the viewer has it, and on
// each named instance this title can go to.
function RequestActions({
  media,
  mediaType,
  state,
  canRequest,
}: {
  media: { id: number; title: string };
  mediaType: DetailMediaType;
  state: DetailPageState;
  canRequest: boolean;
}) {
  return (
    <>
    <RequestButton
      key={media.id}
      tmdbId={media.id}
      mediaType={mediaType}
      title={media.title}
      plexAvailable={state.plexAvailable}
      jellyfinAvailable={state.jellyfinAvailable}
      arrPending={state.arrPending}
      requested={state.requested}
      showPlex={state.showPlex}
      showJellyfin={state.showJellyfin}
      requestToken={state.requestToken}
      canRequestOnBehalf={state.canOnBehalf}
      canChooseProfile={state.canChooseProfile}
      blacklisted={state.blacklisted}
      canRequest={canRequest}
    />
    {state.show4k && (
      <Request4kButton
        key={`4k-${media.id}`}
        tmdbId={media.id}
        mediaType={mediaType}
        requestToken={state.requestToken}
        requested={state.requested4k}
        available={state.arr4kAvailable}
        blacklisted={state.blacklisted}
      />
    )}
    {state.namedTargets.map((target) => (
      <RequestInstanceButton
        key={`${media.id}:${target.slug}`}
        tmdbId={media.id}
        mediaType={mediaType}
        instance={target.slug}
        instanceName={target.name}
        requestToken={state.requestToken}
        requested={target.requested}
        available={target.available}
        blacklisted={state.blacklisted}
      />
    ))}
    </>
  );
}

// An admin's Radarr/Sonarr controls, one set per configured instance.
function ArrInstanceActions({
  mediaId,
  service,
  arrLinks,
  manageLink,
  t,
}: {
  mediaId: number;
  service: "radarr" | "sonarr";
  arrLinks: DetailPageState["arrLinks"];
  manageLink: ReturnType<typeof parseManageLink>;
  t: Translator;
}) {
  return (
    <>
    {arrLinks.map((inst) => {
      const label = arrInstanceLabel(service, inst.name, inst.slug);
      const deep = manageLink !== null && manageLink.instance === inst.slug;
      // An instance holding the title: manage it there. Any other
      // configured one: add it there, with the arr's own choices. A
      // ?manage= deep link (an external/bookmarked URL — nothing in the
      // app emits one) opens the manager even on a non-holder: `holds`
      // is the synced cache, and the manager resolves the title live, so
      // a title added since the last sync still opens; a true non-holder
      // gets the dialog's own not-found state.
      return inst.holds || deep ? (
        <Fragment key={inst.slug || "default"}>
          <ArrManageButton
            service={service}
            instance={inst.slug}
            tmdbId={mediaId}
            instanceLabel={label}
            autoOpen={deep}
            initialTab={deep ? manageLink.tab : undefined}
          />
          {inst.holds && (
            <OpenInArrLink
              service={service}
              instance={inst.slug}
              target={{ tmdbId: mediaId }}
              label={t("adminManage.openIn", { name: label })}
            />
          )}
        </Fragment>
      ) : (
        <ArrAddButton key={inst.slug || "default"} service={service} instance={inst.slug} tmdbId={mediaId} instanceLabel={label} />
      );
    })}
    </>
  );
}
