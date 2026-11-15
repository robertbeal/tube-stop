import { Database } from "bun:sqlite";
import { join } from "node:path";
import { randomVideoId, temporaryDirectory } from "../../tests/helpers.ts";
import { claimCache, claimDownload, finishCache, finishDownload, pinVideo, requestCache } from "../downloads/queue.ts";
import type { VideoId } from "../ytdlp/types.ts";
import { getChannels } from "./channels.ts";
import { openDatabase } from "./open.ts";
import type { NewVideo, Video } from "./types.ts";
import { getVideo } from "./videos.ts";

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

export function videoOf(database: Database, youtubeId: VideoId): Video {
    const video = getVideo(database, youtubeId);
    if (video === null) {
        throw new Error(`video ${youtubeId} does not exist`);
    }
    return video;
}

export function idsOf(videos: readonly Pick<Video, "youtubeId">[]): VideoId[] {
    return videos.map((video) => video.youtubeId);
}

export function channelIdOf(database: Database, youtubeId: VideoId): number {
    const channel = getChannels(database).find((candidate) => candidate.youtubeId === youtubeId);
    if (channel === undefined) {
        throw new Error(`channel ${youtubeId} does not exist`);
    }
    return channel.id;
}

/** Pins a video and completes its download. */
export function keepFile(database: Database, youtubeId: VideoId, path: string): void {
    pinVideo(database, youtubeId);
    claimDownload(database);
    finishDownload(database, youtubeId, path);
}

/** Requests a watch-once copy and completes its download. */
export function cacheFile(database: Database, youtubeId: VideoId, path: string): void {
    requestCache(database, youtubeId);
    claimCache(database);
    finishCache(database, youtubeId, path);
}

export type TestDatabase = {
    path: string;
    database: Database;
    /** A second connection for arranging and inspecting state the database does not expose. */
    raw: Database;
};

export async function openTestDatabase(): Promise<TestDatabase> {
    const path = join(await temporaryDirectory(), "test.db");
    const database = openDatabase(path);
    return { path, database, raw: new Database(path, { strict: true }) };
}
