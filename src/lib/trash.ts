// TRaSH-Guides sync: the entry every route and the cron import. The work lives
// in phase modules beside this one:
//   trash-github.ts         GitHub tree + raw file access
//   trash-refresh.ts        catalog refresh into TrashSpec, upstream retirement
//   trash-apply-common.ts   instance config, arr shapes, PUT-or-POST, bookkeeping
//   trash-apply-cf.ts       custom formats and CF-Groups
//   trash-apply-profile.ts  quality profiles (items in trash-profile-items.ts)
//   trash-apply-config.ts   naming and quality sizes
//   trash-sync.ts           applySpecs and the runTrashSync cron entry
//   trash-query.ts          the admin page's catalog reads
export { describeSchemaError } from "./trash-schema-error";
export { fetchTrashTree, __resetGithubTokenCacheForTests, type GhTreeEntry, type TrashTree } from "./trash-github";
export { refreshCatalog, type RefreshResult } from "./trash-refresh";
export { resolveRemoteId } from "./trash-apply-common";
export { applyCustomFormats, applyCustomFormatGroups, applyCustomFormatGroupsWithMembers, type GroupApplyResults } from "./trash-apply-cf";
export { applyQualityProfiles } from "./trash-apply-profile";
export { applyNaming, applyQualitySizes } from "./trash-apply-config";
export { applySpecs, runTrashSync, type TrashSyncResult } from "./trash-sync";
export { listSpecs, getSpecDetail, type SpecApplicationStatus, type SpecStatus, type SpecDetail } from "./trash-query";
export type {
  ApplyResult,
  TrashCustomFormat,
  TrashCustomFormatGroup,
  TrashCustomFormatGroupMember,
  TrashQualityProfile,
  TrashQualitySize,
} from "./trash-types";
