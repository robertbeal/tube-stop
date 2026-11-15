import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { allow, type Environment } from "../../tests/harness.ts";
import { testVideoId } from "../../tests/helpers.ts";
import { insertChannel } from "../shared/db/channels.ts";
import { claimCache, claimDownload, finishCache, finishDownload, pinVideo, requestCache } from "../shared/db/queue.ts";
import type { Video } from "../shared/db/types.ts";
import { getVideo, insertVideo } from "../shared/db/videos.ts";
import type { VideoId } from "../shared/ytdlp/types.ts";

export const videoId = testVideoId("abcdefghijk");
export const unknownVideoId = testVideoId("zzzzzzzzzzz");

/** Allows a video of the channel "Piano Guy" (UC1). */
export function allowPianoVideo(youtubeId: VideoId, title: string): void {
    allow({ youtubeId, title, channelYoutubeId: "UC1", channelName: "Piano Guy" });
}

/** Gives a video a playable watch-once copy with known contents, and returns its path. */
export async function makeCacheReady(environment: Environment, youtubeId: VideoId, contents: string): Promise<string> {
    const path = join(environment.cacheDir, `${youtubeId}.mp4`);
    await writeFileWithFolders(path, contents);
    requestCache(youtubeId);
    claimCache();
    finishCache(youtubeId, path);
    return path;
}

/** Pins a video and records a finished download at `path`, which is created with `contents`. */
export async function makePinnedFile(youtubeId: VideoId, path: string, contents: string): Promise<void> {
    await writeFileWithFolders(path, contents);
    pinVideo(youtubeId);
    claimDownload();
    finishDownload(youtubeId, path);
}

export async function writeFileWithFolders(path: string, contents: string | Uint8Array): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, contents);
}

export function loadVideo(youtubeId: VideoId): Video {
    const video = getVideo(youtubeId);
    if (video === null) {
        throw new Error(`no video ${youtubeId}`);
    }
    return video;
}

/** The `msg` a redirect to the admin page carries; fails the test's expectations if it is not a redirect. */
export function redirectMessage(response: Response): string {
    if (response.status !== 303) {
        throw new Error(`status ${response.status}, want a 303 redirect`);
    }
    const location = response.headers.get("location") ?? "";
    return new URL(location, "http://localhost").searchParams.get("msg") ?? "";
}

/** A distinct, valid 11-character video id. */
export function numberedId(number: number): VideoId {
    return testVideoId(`video${String(number).padStart(6, "0")}`);
}

/** Adds `count` watchable videos to channel UC1; a higher number is a newer video. */
export function addPublished(count: number): void {
    insertChannel("UC1", "Piano Guy");
    for (const number of Array.from({ length: count }, (_, index) => index + 1)) {
        insertVideo({
            youtubeId: numberedId(number),
            channelYoutubeId: "UC1",
            channelName: "Piano Guy",
            title: `Song ${String(number).padStart(3, "0")}`,
            duration: 0,
            publishedAt: 1_000_000 + number,
        });
    }
}

export function cardCount(body: string): number {
    return body.split("card video-card ").length - 1;
}

export function countOccurrences(text: string, part: string): number {
    return text.split(part).length - 1;
}
