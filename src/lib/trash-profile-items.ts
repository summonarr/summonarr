// A quality profile's `items` list, rebuilt from the TRaSH profile against the
// arr's own profile schema. Pure: no I/O, so the whole tree reconstruction is
// testable on plain data.
import { v, type Infer } from "./validate";
import type { TrashQualityProfile } from "./trash-types";

const QualityRefSchema = v.object({ id: v.int(), name: v.string() });

// The fields buildProfileItems reads. The arr may omit or null any of them, and
// leaves carry an empty `items` list. Only the shape is checked: the body sent
// back spreads the arr's own items, every field it sent kept.
const SchemaQualitySubSchema = v.object({
  id: v.optional(v.nullable(v.int())),
  name: v.optional(v.nullable(v.string())),
  quality: v.optional(v.nullable(QualityRefSchema)),
  items: v.optional(v.nullable(v.array(v.unknown()))),
});
export const SchemaQualityItemsSchema = v.array(v.object({
  id: v.optional(v.nullable(v.int())),
  name: v.optional(v.nullable(v.string())),
  quality: v.optional(v.nullable(QualityRefSchema)),
  items: v.optional(v.nullable(v.array(SchemaQualitySubSchema))),
}));

export type QualityRef = Infer<typeof QualityRefSchema>;
export type SchemaQualityItem = Infer<typeof SchemaQualityItemsSchema>[number];
type SchemaQualitySub = Infer<typeof SchemaQualitySubSchema>;
// A single quality, at the top level or inside a schema group.
type QualityLeaf = SchemaQualitySub & { quality: QualityRef };

export interface ProfileQualityItem {
  id?: number | null;
  name?: string | null;
  quality?: QualityRef | null;
  items?: readonly unknown[] | null;
  allowed: boolean;
}

type TrashProfileItem = NonNullable<TrashQualityProfile["items"]>[number];

// The schema read once: every quality by name (first wins), every group by name.
interface SchemaIndex {
  leafByName: Map<string, QualityLeaf>;
  groupByName: Map<string, SchemaQualityItem>;
  maxGroupId: number;
}

// What the rebuild has used so far.
interface BuildState {
  placed: Set<string>;
  usedGroupIds: Set<number>;
  // Each top-level item's name → its id, first name wins: the cutoff lookup.
  idByName: Map<string, number>;
  nextGroupId: number;
}

function isLeaf(item: SchemaQualitySub): item is QualityLeaf {
  return item.quality != null;
}

function indexSchema(schemaItems: readonly SchemaQualityItem[]): SchemaIndex {
  const leafByName = new Map<string, QualityLeaf>();
  const groupByName = new Map<string, SchemaQualityItem>();
  let maxGroupId = 999;
  for (const item of schemaItems) {
    if (item.items?.length) {
      if (item.name && !groupByName.has(item.name)) groupByName.set(item.name, item);
      if (typeof item.id === "number" && item.id > maxGroupId) maxGroupId = item.id;
      for (const sub of item.items) {
        if (isLeaf(sub) && !leafByName.has(sub.quality.name)) leafByName.set(sub.quality.name, sub);
      }
    } else if (isLeaf(item) && !leafByName.has(item.quality.name)) {
      leafByName.set(item.quality.name, item);
    }
  }
  return { leafByName, groupByName, maxGroupId };
}

function nameId(state: BuildState, name: string, id: number): void {
  if (!state.idByName.has(name)) state.idByName.set(name, id);
}

// Takes a schema quality for the profile, once.
function take(index: SchemaIndex, state: BuildState, name: string, allowed: boolean): (QualityLeaf & { allowed: boolean }) | null {
  const leaf = index.leafByName.get(name);
  if (!leaf || state.placed.has(name)) return null;
  state.placed.add(name);
  return { ...leaf, allowed };
}

// The qualities a TRaSH entry groups: its own members, or — for an entry
// without members that names a schema GROUP — that group's. Null for a single quality.
function memberNamesOf(index: SchemaIndex, entry: TrashProfileItem): readonly string[] | null {
  if (entry.items?.length) return entry.items;
  const schemaGroup = index.groupByName.get(entry.name);
  if (index.leafByName.has(entry.name) || !schemaGroup) return null;
  return (schemaGroup.items ?? []).flatMap((sub) => (sub.quality ? [sub.quality.name] : []));
}

// One TRaSH entry as a profile item, or null when none of its qualities is left.
function rankEntry(index: SchemaIndex, state: BuildState, entry: TrashProfileItem): ProfileQualityItem | null {
  const memberNames = memberNamesOf(index, entry);
  if (memberNames === null) {
    const leaf = take(index, state, entry.name, entry.allowed);
    if (leaf) nameId(state, entry.name, leaf.quality.id);
    return leaf;
  }
  const members: Array<QualityLeaf & { allowed: boolean }> = [];
  for (const n of memberNames) {
    const leaf = take(index, state, n, entry.allowed);
    if (leaf) members.push(leaf);
  }
  if (members.length === 0) return null;
  // The arr refuses a one-member group: send the quality itself.
  if (members.length === 1) {
    const [only] = members;
    nameId(state, entry.name, only.quality.id);
    nameId(state, only.quality.name, only.quality.id);
    return only;
  }
  const schemaGroup = index.groupByName.get(entry.name);
  const id = schemaGroup && typeof schemaGroup.id === "number" && !state.usedGroupIds.has(schemaGroup.id)
    ? schemaGroup.id
    : state.nextGroupId++;
  state.usedGroupIds.add(id);
  nameId(state, entry.name, id);
  return { ...(schemaGroup ?? {}), id, name: entry.name, allowed: entry.allowed, items: members };
}

// Every schema quality the TRaSH profile didn't place, disallowed, in schema
// order; a schema group none of whose qualities was taken stays a group.
function remainingSchemaItems(schemaItems: readonly SchemaQualityItem[], state: BuildState): ProfileQualityItem[] {
  const rest: ProfileQualityItem[] = [];
  for (const item of schemaItems) {
    if (item.items?.length) {
      const subs = item.items.filter((sub): sub is QualityLeaf => isLeaf(sub) && !state.placed.has(sub.quality.name));
      const untouched = subs.length === item.items.length;
      if (untouched && typeof item.id === "number" && !state.usedGroupIds.has(item.id)) {
        for (const sub of subs) state.placed.add(sub.quality.name);
        state.usedGroupIds.add(item.id);
        rest.push({ ...item, allowed: false, items: subs.map((sub) => ({ ...sub, allowed: false })) });
        if (item.name) nameId(state, item.name, item.id);
        continue;
      }
      for (const sub of subs) {
        if (state.placed.has(sub.quality.name)) continue;
        state.placed.add(sub.quality.name);
        rest.push({ ...sub, allowed: false });
        nameId(state, sub.quality.name, sub.quality.id);
      }
    } else if (isLeaf(item) && !state.placed.has(item.quality.name)) {
      state.placed.add(item.quality.name);
      rest.push({ ...item, allowed: false });
      nameId(state, item.quality.name, item.quality.id);
    }
  }
  return rest;
}

// Builds a profile's quality list from the TRaSH profile, keeping TRaSH's
// grouping and ranking rather than the schema's:
//   - TRaSH lists items best first; the Radarr/Sonarr API lists them worst
//     first (a higher index is a better quality), so TRaSH's order is reversed.
//   - A TRaSH group takes the id of the schema group with its name, else a
//     fresh id above every schema group id. Its members are pulled out of
//     wherever the schema put them. A group left with one known quality is sent
//     as that quality: the arr refuses a one-member group.
//   - Every schema quality appears exactly once. Those TRaSH doesn't name go
//     first (lowest), disallowed, in schema order; an untouched schema group
//     stays a group. A name the schema doesn't know is skipped.
// `idByName` maps each top-level item's name to its id, for the cutoff.
export function buildProfileItems(
  schemaItems: readonly SchemaQualityItem[],
  profileItems: readonly TrashProfileItem[],
): { items: ProfileQualityItem[]; idByName: Map<string, number> } {
  const index = indexSchema(schemaItems);
  const state: BuildState = {
    placed: new Set(),
    usedGroupIds: new Set(),
    idByName: new Map(),
    nextGroupId: index.maxGroupId + 1,
  };
  const ranked: ProfileQualityItem[] = [];
  for (const entry of profileItems) {
    const item = rankEntry(index, state, entry);
    if (item) ranked.push(item);
  }
  const rest = remainingSchemaItems(schemaItems, state);
  return { items: [...rest, ...ranked.reverse()], idByName: state.idByName };
}
