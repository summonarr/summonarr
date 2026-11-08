// The Download Queue modules' shared vocabulary (arr-queue.ts, the queue
// projection; arr-queue-import.ts, Manual Import). Zero-import, so the two
// halves share it without importing each other.

export type QueueService = "radarr" | "sonarr";

export interface QueueEpisode {
  seasonNumber: number;
  episodeNumber: number;
}

// Bounds on what one row carries to the browser. A pathological import can
// report hundreds of status lines (or refusal reasons); the page needs the first few.
export const MAX_MESSAGES = 6;
export const MAX_MESSAGE_LEN = 300;
