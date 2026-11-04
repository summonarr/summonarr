// Audit fix C090: the Arr System Storage tab lends a root folder a disk's size
// only when rootDisk believes the match (free space agrees within
// max(1 GB, 1%)) — the same rule the Radarr/Sonarr monitor judges disks by
// (guardrail 7c). A root on a mount /diskspace doesn't list (mergerfs, Unraid
// shfs, rclone) is otherwise matched to "/" and shown "18 TB free of 100 GB".
import { test } from "node:test";
import assert from "node:assert/strict";

import { projectRootFolders, rootDisk } from "../src/lib/arr-system.ts";
import * as W from "../src/lib/arr-watch.ts";

const GB = 1000 ** 3;
const disk = (path: string, freeSpace: number | null, totalSpace: number | null) => ({ path, label: null, freeSpace, totalSpace });

test("a root folder on a mount /diskspace doesn't list gets no total — never the container root's size", () => {
  const disks = [disk("/", 40 * GB, 100 * GB)];
  const [root] = projectRootFolders([{ id: 1, path: "/tv/", accessible: true, freeSpace: 18_000 * GB }], disks);
  assert.equal(root.totalSpace, null, "18 TB free can't be on a 100 GB disk with 40 GB free");
  assert.equal(root.freeSpace, 18_000 * GB, "the folder's own free space is still shown");
});

test("a root folder whose free space agrees with its disk's keeps that disk's size", () => {
  const disks = [disk("/", 10 * GB, 100 * GB), disk("/mnt/media", 2_000 * GB, 8_000 * GB)];
  const exact = projectRootFolders([{ id: 1, path: "/mnt/media/movies", freeSpace: 2_000 * GB }], disks)[0];
  assert.equal(exact.totalSpace, 8_000 * GB);
  // Within 1% of 2 TB (20 GB): an import moved one reading between the two reads.
  const drift = projectRootFolders([{ id: 1, path: "/mnt/media/movies", freeSpace: 2_015 * GB }], disks)[0];
  assert.equal(drift.totalSpace, 8_000 * GB);
  // Past it: a different filesystem.
  const far = projectRootFolders([{ id: 1, path: "/mnt/media/movies", freeSpace: 2_100 * GB }], disks)[0];
  assert.equal(far.totalSpace, null);
});

test("no free space on either side to compare: the match stands, as in the monitor", () => {
  const disks = [disk("/data", 40 * GB, 1_000 * GB)];
  assert.equal(projectRootFolders([{ id: 1, path: "/data/x" }], disks)[0].totalSpace, 1_000 * GB);
  assert.equal(projectRootFolders([{ id: 1, path: "/data/x", freeSpace: 5 * GB }], [disk("/data", null, 1_000 * GB)])[0].totalSpace, 1_000 * GB);
  // A size the root folder reports itself always wins (neither arr sends one today).
  assert.equal(projectRootFolders([{ id: 1, path: "/tv", freeSpace: 18_000 * GB, totalSpace: 20_000 * GB }], [disk("/", 40 * GB, 100 * GB)])[0].totalSpace, 20_000 * GB);
});

test("the Storage tab and the monitor share ONE rootDisk (arr-watch re-exports it)", () => {
  assert.equal(W.rootDisk, rootDisk);
  // The monitor's reading of the projected root matches the Storage tab's: its own reading, no size.
  const disks = [disk("/", 40 * GB, 100 * GB)];
  const readings = W.readDisks(projectRootFolders([{ id: 1, path: "/mnt/user/media", freeSpace: 20_000 * GB }], disks), disks);
  assert.deepEqual(readings.map((r) => [r.path, r.totalBytes]), [["/mnt/user/media", null]]);
});
