import { Database } from "bun:sqlite";
import { join } from "node:path";
import { type NewVideo, Store, type Video } from "../../src/db/store.ts";
import { randomVideoId, temporaryDirectory } from "../helpers.ts";

export const everything = { limit: 1000, offset: 0 };

export const fixedNow = 1_700_000_000;

export function newVideo(channelYoutubeId: string, overrides: Partial<NewVideo> = {}): NewVideo {
  return {
    youtubeId: randomVideoId(),
    channelYoutubeId,
    channelName: `Channel ${channelYoutubeId}`,
    title: `Title ${randomVideoId()}`,
    duration: 120,
    publishedAt: 0,
    ...overrides,
  };
}

export function videoOf(store: Store, youtubeId: string): Video {
  const video = store.video(youtubeId);
  if (video === null) {
    throw new Error(`video ${youtubeId} does not exist`);
  }
  return video;
}

export function idsOf(videos: readonly Pick<Video, "youtubeId">[]): string[] {
  return videos.map((video) => video.youtubeId);
}

export function channelIdOf(store: Store, youtubeId: string): number {
  const channel = store.channels().find((candidate) => candidate.youtubeId === youtubeId);
  if (channel === undefined) {
    throw new Error(`channel ${youtubeId} does not exist`);
  }
  return channel.id;
}

/** Pins a video and completes its download. */
export function keepFile(store: Store, youtubeId: string, path: string): void {
  store.pin(youtubeId);
  store.claimDownload();
  store.finishDownload(youtubeId, path);
}

/** Requests a watch-once copy and completes its download. */
export function cacheFile(store: Store, youtubeId: string, path: string): void {
  store.requestCache(youtubeId);
  store.claimCache();
  store.finishCache(youtubeId, path);
}

export interface TestDatabase {
  path: string;
  store: Store;
  /** A second connection for arranging and inspecting state the store does not expose. */
  raw: Database;
}

export async function openTestDatabase(now?: () => number): Promise<TestDatabase> {
  const path = join(await temporaryDirectory(), "test.db");
  const store = new Store(path, now ?? (() => fixedNow));
  return { path, store, raw: new Database(path, { strict: true }) };
}
