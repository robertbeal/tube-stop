import { Database } from "bun:sqlite";
import { join } from "node:path";
import { randomVideoId, temporaryDirectory } from "../../tests/helpers.ts";
import type { VideoId } from "../ytdlp/types.ts";
import {
    claimCache,
    claimDownload,
    finishCache,
    finishDownload,
    getChannels,
    getVideo,
    type NewVideo,
    openStore,
    pinVideo,
    requestCache,
    type Store,
    type Video,
} from "./store.ts";

export const everything = { limit: 1000, offset: 0 };

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

export function videoOf(store: Store, youtubeId: VideoId): Video {
    const video = getVideo(store, youtubeId);
    if (video === null) {
        throw new Error(`video ${youtubeId} does not exist`);
    }
    return video;
}

export function idsOf(videos: readonly Pick<Video, "youtubeId">[]): VideoId[] {
    return videos.map((video) => video.youtubeId);
}

export function channelIdOf(store: Store, youtubeId: VideoId): number {
    const channel = getChannels(store).find((candidate) => candidate.youtubeId === youtubeId);
    if (channel === undefined) {
        throw new Error(`channel ${youtubeId} does not exist`);
    }
    return channel.id;
}

/** Pins a video and completes its download. */
export function keepFile(store: Store, youtubeId: VideoId, path: string): void {
    pinVideo(store, youtubeId);
    claimDownload(store);
    finishDownload(store, youtubeId, path);
}

/** Requests a watch-once copy and completes its download. */
export function cacheFile(store: Store, youtubeId: VideoId, path: string): void {
    requestCache(store, youtubeId);
    claimCache(store);
    finishCache(store, youtubeId, path);
}

export type TestDatabase = {
    path: string;
    store: Store;
    /** A second connection for arranging and inspecting state the store does not expose. */
    raw: Database;
};

export async function openTestDatabase(): Promise<TestDatabase> {
    const path = join(await temporaryDirectory(), "test.db");
    const store = openStore(path);
    return { path, store, raw: new Database(path, { strict: true }) };
}
