import type { Database } from "bun:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { getChannels, markChannelSynced } from "./db/channels.ts";
import type { Channel } from "./db/types.ts";
import { insertVideo } from "./db/videos.ts";
import { logger } from "./logger.ts";
import type { Video } from "./ytdlp/types.ts";

/** How many of a channel's newest videos each sync looks at. */
const recentVideos = 50;
const perChannelTimeoutMs = 3 * 60 * 1000;

/** Copies the recent videos of each allowed channel into the database, on a schedule. */
export type Syncer = {
    database: Database;
    getChannelVideos: (channelId: string, limit: number, signal: AbortSignal) => Promise<Video[]>;
    intervalMs: number;
};

/** Syncs once straight away, then on every interval, until `signal` aborts. */
export async function runSync(syncer: Syncer, signal: AbortSignal): Promise<void> {
    await syncChannels(syncer, signal);
    while (!signal.aborted) {
        await delay(syncer.intervalMs, undefined, { signal }).catch(() => undefined);
        await syncChannels(syncer, signal);
    }
}

/** Syncs every channel. It never rejects, because it also runs on its own when the admin asks for a sync. */
export async function syncChannels(syncer: Syncer, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return;
    }
    try {
        for (const channel of getChannels(syncer.database)) {
            if (signal.aborted) {
                return;
            }
            await syncChannel(syncer, channel, signal);
        }
    } catch (error) {
        logger.error(`sync: ${error.message}`);
    }
}

async function syncChannel(syncer: Syncer, channel: Channel, signal: AbortSignal): Promise<void> {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(perChannelTimeoutMs)]);
    try {
        const listed = await syncer.getChannelVideos(channel.youtubeId, recentVideos, timeout);
        for (const video of listed.toReversed()) {
            try {
                insertVideo(syncer.database, {
                    youtubeId: video.id,
                    channelYoutubeId: channel.youtubeId,
                    channelName: channel.name,
                    title: video.title || video.id,
                    duration: video.duration,
                    publishedAt: video.publishedAt,
                });
            } catch (error) {
                logger.error(`sync: insert ${video.id}: ${error.message}`);
            }
        }
        markChannelSynced(syncer.database, channel.youtubeId);
        logger.info(`sync: ${channel.name}: ${listed.length} videos`);
    } catch (error) {
        logger.error(`sync: ${channel.name}: ${error.message}`);
    }
}
