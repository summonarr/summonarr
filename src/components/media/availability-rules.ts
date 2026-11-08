// The availability chips' rules, shared by AvailabilityBadges (detail pages),
// AvailabilityChips (cards and the Discover hero) and the cards' own "is this
// available to me" reading. Pure, so the unit suite pins it
// (tests/availability-rules.test.mts).

export interface AvailabilityFlags {
  plexAvailable?: boolean;
  jellyfinAvailable?: boolean;
  arrPending?: boolean;
  requested?: boolean;
  // 4K-instance state (the 4K Radarr/Sonarr has it / wants it).
  arr4kAvailable?: boolean;
  arr4kPending?: boolean;
}

/**
 * Available to THIS viewer: a copy on a server whose badges they see. A copy on
 * a server they don't see must not suppress the Queued / Requested chips —
 * there is no Plex chip to show for it either. These flags come from cached
 * library data, so they are as fresh as the last library sync.
 */
export function isVisiblyAvailable(
  f: Pick<AvailabilityFlags, "plexAvailable" | "jellyfinAvailable">,
  showPlex: boolean,
  showJellyfin: boolean,
): boolean {
  return !!((showPlex && f.plexAvailable) || (showJellyfin && f.jellyfinAvailable));
}

export type AvailabilityChipKind = "plex" | "jellyfin" | "fourK" | "queued" | "queued4k" | "requested";

export interface AvailabilityChipOptions {
  showPlex: boolean;
  showJellyfin: boolean;
  /** isVisiblyAvailable for this title; it suppresses Queued and Requested. */
  isAvailable: boolean;
  /** The viewer has 4K access. The card data is gated by enrichment already, so it defaults to on. */
  show4k?: boolean;
  /** Whether a Requested chip may show (the card shows request state elsewhere). */
  showRequested?: boolean;
  /** The Discover hero lists Queued before 4K; everywhere else 4K comes first. */
  queuedBefore4k?: boolean;
}

/**
 * The chips to draw, in order. 4K is tracked apart from the normal (HD) state —
 * a title can be downloading in HD while already present in 4K — so its chips
 * show alongside the others, not instead of them. Queued supersedes Requested:
 * a queued title has been requested.
 */
export function availabilityChips(f: AvailabilityFlags, o: AvailabilityChipOptions): AvailabilityChipKind[] {
  const show4k = o.show4k ?? true;
  const out: AvailabilityChipKind[] = [];
  if (o.showPlex && f.plexAvailable) out.push("plex");
  if (o.showJellyfin && f.jellyfinAvailable) out.push("jellyfin");
  const queued = !o.isAvailable && !!f.arrPending;
  const fourK = show4k && !!f.arr4kAvailable;
  if (o.queuedBefore4k) {
    if (queued) out.push("queued");
    if (fourK) out.push("fourK");
  } else {
    if (fourK) out.push("fourK");
    if (queued) out.push("queued");
  }
  if (show4k && !f.arr4kAvailable && f.arr4kPending) out.push("queued4k");
  if ((o.showRequested ?? false) && !o.isAvailable && !f.arrPending && f.requested) out.push("requested");
  return out;
}
