import { type Info, toChannel, toVideo } from "./info.ts";
import { ytdlp } from "./run.ts";
import type { Resolved, Video } from "./types.ts";

/** Inspects a user-supplied URL: a single video, or a channel or playlist. */
export async function resolveUrl(binary: string, url: string, signal: AbortSignal): Promise<Resolved> {
    const output = await ytdlp(
        binary,
        ["-J", "--flat-playlist", "--playlist-items", "1", "--no-warnings", "--", url],
        signal,
    );

    const info: Info = JSON.parse(output);

    if (info._type === "playlist") {
        return toChannel(info);
    }

    const video = toVideo(info);
    if (video === undefined) {
        throw new Error("could not determine video from URL");
    }

    return video;
}

export async function getChannelVideos(
    binary: string,
    channelId: string,
    limit: number,
    signal: AbortSignal,
): Promise<Video[]> {
    const output = await ytdlp(
        binary,
        [
            "-J",
            "--flat-playlist",
            "--no-warnings",
            "--extractor-args",
            "youtubetab:approximate_date",
            "--playlist-end",
            String(limit),
            `https://www.youtube.com/channel/${channelId}/videos`,
        ],
        signal,
    );
    const response: Info = JSON.parse(output);
    return (response.entries ?? [])
        .map(toVideo)
        .filter((video) => video !== undefined)
        .map((video) => ({ ...video, channel: { ...video.channel, id: video.channel.id || channelId } }));
}
