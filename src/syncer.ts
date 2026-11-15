import { setTimeout as delay } from "node:timers/promises";
import { config } from "./config.ts";
import { getChannels, markChannelSynced } from "./db/channels.ts";
import type { Channel } from "./db/types.ts";
import { insertVideo } from "./db/videos.ts";
import { logger } from "./util/logger.ts";
import { getChannelVideos } from "./ytdlp/resolve.ts";

/** How many of a channel's newest videos each sync looks at. */
const recentVideos = 50;
const perChannelTimeoutMs = 3 * 60 * 1000;

/** Syncs once straight away, then on every interval, until `signal` aborts. */
export async function runSync(signal: AbortSignal): Promise<void> {
    await syncChannels(signal);
    while (!signal.aborted) {
        await delay(config.syncIntervalMs, undefined, { signal }).catch(() => undefined);
        await syncChannels(signal);
    }
}

/** Syncs every channel. It never rejects, because it also runs on its own when the admin asks for a sync. */
export async function syncChannels(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return;
    }

    try {
        for (const channel of getChannels()) {
            if (signal.aborted) {
                return;
            }
            await syncChannel(channel, signal);
        }
    } catch (error) {
        logger.error(`sync: ${error.message}`);
    }
}

async function syncChannel(channel: Channel, signal: AbortSignal): Promise<void> {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(perChannelTimeoutMs)]);

    try {
        const videos = await getChannelVideos(config.ytdlpBin, channel.youtubeId, recentVideos, timeout);

        for (const video of videos.toReversed()) {
            try {
                insertVideo({
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
        markChannelSynced(channel.youtubeId);
        logger.info(`sync: ${channel.name}: ${videos.length} videos`);
    } catch (error) {
        logger.error(`sync: ${channel.name}: ${error.message}`);
    }
}
