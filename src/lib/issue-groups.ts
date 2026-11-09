// The admin Issues list's grouping of duplicate reports. Pure
// (tests/issue-groups.test.mts).
import { nameOrEmail } from "./display-name";

export interface GroupableIssue {
  id: string;
  tmdbId: number;
  mediaType: string;
  issueType: string;
  scope: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  status: string;
  createdAt: Date;
  user: { name: string | null; email: string };
}

export interface IssueGroup<T> {
  // The newest report: the card's link, actions, note and thread are its own.
  representative: T;
  // Every report in the group, newest first, the representative included.
  members: T[];
  count: number;
  reporterNames: string[];
}

/**
 * Collapses duplicate reports (same tmdbId + mediaType + type + scope + season +
 * episode + STATUS) into one group, keeping the newest as representative;
 * ordered by report count desc, then newest. TMDB ids are namespaced per type,
 * so mediaType is part of the key. Status is too: under "All" a newer RESOLVED
 * report used to stand for older OPEN ones, so the card read "Resolved" while
 * open reports sat hidden under it, and its actions changed only the newest.
 */
export function groupIssues<T extends GroupableIssue>(issues: readonly T[]): IssueGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const issue of issues) {
    const key = [
      issue.tmdbId,
      issue.mediaType,
      issue.issueType,
      issue.scope,
      issue.seasonNumber ?? "",
      issue.episodeNumber ?? "",
      issue.status,
    ].join("::");
    const group = map.get(key);
    if (group) group.push(issue);
    else map.set(key, [issue]);
  }
  return Array.from(map.values())
    .map((group) => {
      group.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return {
        representative: group[0],
        members: group,
        count: group.length,
        reporterNames: [...new Set(group.map((i) => nameOrEmail(i.user)))],
      };
    })
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.representative.createdAt.getTime() - a.representative.createdAt.getTime();
    });
}
