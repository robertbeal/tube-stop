import type { Database } from "bun:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { getChannels, markChannelSynced } from "./db/channels.ts";
import type { Channel } from "./db/types.ts";
import { insertVideo } from "./db/videos.ts";
import { logger } from "./logger.ts";
import { getChannelVideos } from "./ytdlp/resolve.ts";

/** How many of a channel's newest videos each sync looks at. */
const recentVideos = 50;
const perChannelTimeoutMs = 3 * 60 * 1000;

/** Syncs once straight away, then on every interval, until `signal` aborts. */
export async function runSync(
    database: Database,
    binary: string,
    intervalMs: number,
    signal: AbortSignal,
): Promise<void> {
    await syncChannels(database, binary, signal);
    while (!signal.aborted) {
        await delay(intervalMs, undefined, { signal }).catch(() => undefined);
        await syncChannels(database, binary, signal);
    }
}

/** Syncs every channel. It never rejects, because it also runs on its own when the admin asks for a sync. */
export async function syncChannels(database: Database, binary: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return;
    }

    try {
        for (const channel of getChannels(database)) {
            if (signal.aborted) {
                return;
            }
            await syncChannel(database, binary, channel, signal);
        }
    } catch (error) {
        logger.error(`sync: ${error.message}`);
    }
}

async function syncChannel(database: Database, binary: string, channel: Channel, signal: AbortSignal): Promise<void> {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(perChannelTimeoutMs)]);

    try {
        const videos = await getChannelVideos(binary, channel.youtubeId, recentVideos, timeout);

        for (const video of videos.toReversed()) {
            try {
                insertVideo(database, {
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
        markChannelSynced(database, channel.youtubeId);
        logger.info(`sync: ${channel.name}: ${videos.length} videos`);
    } catch (error) {
        logger.error(`sync: ${channel.name}: ${error.message}`);
    }
}
