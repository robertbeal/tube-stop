import { type Channel, getChannels, insertVideo, markChannelSynced, type Store } from "./db/store.ts";
import { sleep } from "./sleep.ts";
import type { Video } from "./ytdlp/types.ts";

/** How many of a channel's newest videos each sync looks at. */
const recentVideos = 50;
const perChannelTimeoutMs = 3 * 60 * 1000;

/** Copies the recent videos of each allowed channel into the database, on a schedule. */
export interface Syncer {
  store: Store;
  getChannelVideos: (channelId: string, limit: number, signal: AbortSignal) => Promise<Video[]>;
  intervalMs: number;
  log: (message: string) => void;
}

export const createSyncer = (
  store: Store,
  getChannelVideos: Syncer["getChannelVideos"],
  intervalMs: number,
  log: (message: string) => void = console.log,
): Syncer => ({ store, getChannelVideos, intervalMs, log });

/** Syncs once straight away, then on every interval, until `signal` aborts. */
export async function runSync(syncer: Syncer, signal: AbortSignal): Promise<void> {
  await syncAll(syncer, signal);
  while (!signal.aborted) {
    await sleep(syncer.intervalMs, signal);
    await syncAll(syncer, signal);
  }
}

export async function syncAll(syncer: Syncer, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  for (const channel of listChannels(syncer)) {
    if (signal.aborted) {
      return;
    }
    await syncChannel(syncer, channel, signal);
  }
}

function listChannels(syncer: Syncer): Channel[] {
  try {
    return getChannels(syncer.store);
  } catch (error) {
    syncer.log(`sync: list channels: ${describe(error)}`);
    return [];
  }
}

async function syncChannel(syncer: Syncer, channel: Channel, signal: AbortSignal): Promise<void> {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(perChannelTimeoutMs)]);
  try {
    const listed = await syncer.getChannelVideos(channel.youtubeId, recentVideos, timeout);
    // Insert oldest first so newer videos get higher ids, and are shown first.
    for (const video of listed.toReversed()) {
      insertSyncedVideo(syncer, channel, video);
    }
    markChannelSynced(syncer.store, channel.youtubeId);
    syncer.log(`sync: ${channel.name}: ${listed.length} videos`);
  } catch (error) {
    syncer.log(`sync: ${channel.name}: ${describe(error)}`);
  }
}

function insertSyncedVideo(syncer: Syncer, channel: Channel, video: Video): void {
  try {
    insertVideo(syncer.store, {
      youtubeId: video.id,
      channelYoutubeId: channel.youtubeId,
      channelName: channel.name,
      title: video.title || video.id,
      duration: video.duration,
      publishedAt: video.publishedAt,
    });
  } catch (error) {
    syncer.log(`sync: insert ${video.id}: ${describe(error)}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
