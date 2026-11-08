// The title manager's Settings form, the pure half (settings-tab.tsx renders
// it): what the form shows, and the PATCH a save sends.
//
// The form holds the admin's EDITS, not a copy of the title: a field they
// haven't touched always shows the title as the arr last reported it (the
// `base`), so a background re-read can never be saved back over the arr as if
// the admin had chosen it. Tags are edited as the ones turned on and off
// (TagDelta), never a whole list. Only the changed fields are sent, and a value
// outside the arr's vocabulary (one it reported, kept selectable) never is.
//
// Zero runtime imports beyond its siblings, so the unit suite loads it
// (tests/arr-title-settings-draft.test.mts).
import { MINIMUM_AVAILABILITIES, MONITOR_NEW_ITEMS, SERIES_TYPES, type ArrTitle, type TitleEdit } from "@/lib/arr-title";
import { oneOf } from "./labels";
import { applyTagDelta, NO_TAG_DELTA, tagDeltaChange, type TagDelta } from "./snapshot-rules";

export type Draft = {
  monitored: boolean;
  qualityProfileId: number | null;
  rootFolderPath: string | null;
  tags: number[];
  minimumAvailability: string | null;
  seriesType: string | null;
  seasonFolder: boolean | null;
  monitorNewItems: string | null;
};
export type Edits = Partial<Omit<Draft, "tags">> & { tags?: TagDelta };
// The PATCH's fields, as the server's own edit type: a misspelt key or a value
// outside the arr's vocabulary fails to compile instead of being ignored there.
export type TitleChanges = Omit<TitleEdit, "moveFiles" | "seasons">;

export function draftOf(title: ArrTitle): Draft {
  return {
    monitored: title.monitored,
    qualityProfileId: title.qualityProfileId,
    rootFolderPath: title.rootFolderPath,
    tags: [...title.tags].sort((a, b) => a - b),
    minimumAvailability: title.minimumAvailability,
    seriesType: title.seriesType,
    seasonFolder: title.seasonFolder,
    monitorNewItems: title.monitorNewItems,
  };
}

/** What the form shows: the base with the admin's edits over it. */
export function applyEdits(base: Draft, edits: Edits): Draft {
  const { tags: tagDelta = NO_TAG_DELTA, ...fieldEdits } = edits;
  return { ...base, ...fieldEdits, tags: applyTagDelta(base.tags, tagDelta) };
}

/** What changed, as the PATCH body's fields. */
export function titleChanges(base: Draft, edits: Edits, isMovie: boolean): TitleChanges {
  const draft = applyEdits(base, edits);
  const c: TitleChanges = {};
  if (draft.monitored !== base.monitored) c.monitored = draft.monitored;
  if (draft.qualityProfileId !== base.qualityProfileId && draft.qualityProfileId !== null) c.qualityProfileId = draft.qualityProfileId;
  if (draft.rootFolderPath !== base.rootFolderPath && draft.rootFolderPath !== null) c.rootFolderPath = draft.rootFolderPath;
  const tagsChange = tagDeltaChange(base.tags, edits.tags ?? NO_TAG_DELTA);
  if (tagsChange) c.tags = tagsChange;
  // A value outside the arr's vocabulary (one it reported, kept selectable)
  // is never sent: the server would refuse the whole edit.
  if (isMovie) {
    if (draft.minimumAvailability !== base.minimumAvailability && oneOf(MINIMUM_AVAILABILITIES, draft.minimumAvailability)) c.minimumAvailability = draft.minimumAvailability;
  } else {
    if (draft.seriesType !== base.seriesType && oneOf(SERIES_TYPES, draft.seriesType)) c.seriesType = draft.seriesType;
    if (draft.seasonFolder !== base.seasonFolder && draft.seasonFolder !== null) c.seasonFolder = draft.seasonFolder;
    if (draft.monitorNewItems !== base.monitorNewItems && oneOf(MONITOR_NEW_ITEMS, draft.monitorNewItems)) c.monitorNewItems = draft.monitorNewItems;
  }
  return c;
}

/**
 * The base the form edits over. A save the arr took whose re-read failed
 * (`title: null`) leaves `landed`: what that save sent, on the title it was
 * sent over — shown as the title (the arr has it) until the manager's re-read
 * hands in a new `title`. Without it the form flipped back to the pre-save
 * values beside "Saved", and kept them if that re-read failed too.
 */
export function formBase(title: ArrTitle, reported: Draft, landed: { on: ArrTitle; draft: Draft } | null): Draft {
  return landed !== null && landed.on === title ? landed.draft : reported;
}
