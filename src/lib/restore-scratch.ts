// Where a restore stages the uploaded dump and its validated statements.
//
// The shipped compose files mount /tmp as a 128 MB RAM tmpfs, which a large
// backup overflows (ENOSPC), and existing installs keep their old compose
// file. So pick the writable candidate with the most free space instead of
// assuming /tmp: RESTORE_TMP_DIR (explicit override), /data/temp (a subfolder of
// the image's writable app dir, on the container's disk), then the OS temp dir.
import { promises as fs, constants } from "node:fs";
import os from "node:os";

export async function restoreScratchDir(): Promise<string> {
  const override = process.env.RESTORE_TMP_DIR?.trim();
  if (override) return override;

  let best = os.tmpdir();
  let bestFree = -1;
  for (const dir of ["/data/temp", os.tmpdir()]) {
    try {
      if (dir !== os.tmpdir()) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.access(dir, constants.W_OK);
      const st = await fs.statfs(dir);
      const free = st.bavail * st.bsize;
      if (free > bestFree) {
        best = dir;
        bestFree = free;
      }
    } catch {
      // missing or not writable — try the next candidate
    }
  }
  return best;
}
