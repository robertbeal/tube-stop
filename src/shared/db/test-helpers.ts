import { Database } from "bun:sqlite";
import { join } from "node:path";
import { randomVideoId } from "../../../tests/helpers.ts";
import { config } from "../config.ts";
import type { VideoId } from "../ytdlp/types.ts";
import { getChannels } from "./channels.ts";
import { claimCache, claimDownload, finishCache, finishDownload, pinVideo, requestCache } from "./queue.ts";
import type { ChannelId, NewVideo, Video } from "./types.ts";
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

export function videoOf(youtubeId: VideoId): Video {
    const video = getVideo(youtubeId);
    if (video === null) {
        throw new Error(`video ${youtubeId} does not exist`);
    }
    return video;
}

export function idsOf(videos: readonly Pick<Video, "youtubeId">[]): VideoId[] {
    return videos.map((video) => video.youtubeId);
}

export function channelIdOf(youtubeId: VideoId): ChannelId {
    const channel = getChannels().find((candidate) => candidate.youtubeId === youtubeId);
    if (channel === undefined) {
        throw new Error(`channel ${youtubeId} does not exist`);
    }
    return channel.id;
}

/** Pins a video and completes its download. */
export function keepFile(youtubeId: VideoId, path: string): void {
    pinVideo(youtubeId);
    claimDownload();
    finishDownload(youtubeId, path);
}

/** Requests a watch-once copy and completes its download. */
export function cacheFile(youtubeId: VideoId, path: string): void {
    requestCache(youtubeId);
    claimCache();
    finishCache(youtubeId, path);
}

/** A second connection to the app's database, for arranging and inspecting state its functions do not expose. */
export const raw = new Database(join(config.dataDir, "tubestop.db"), { strict: true });
