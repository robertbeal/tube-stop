import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import type { VideoId } from "./ytdlp/types.ts";

const imageServer = "https://i.ytimg.com";

/** Where thumbnails are saved, as `<video id>.jpg`. */
export const thumbnailDir = join(config.dataDir, "thumbs");

/**
 * Always fetches a video's thumbnail from YouTube and saves it in `thumbnailDir`, moving it
 * into place atomically so a half-written file is never served. Returns that path.
 */
export async function downloadThumbnail(videoId: VideoId, signal: AbortSignal): Promise<string> {
    const response = await fetch(`${imageServer}/vi/${videoId}/mqdefault.jpg`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });

    if (!response.ok) {
        throw new Error(`thumbnail server answered ${response.status}`);
    }

    if (!response.headers.get("content-type")?.startsWith("image/")) {
        throw new Error("thumbnail server did not send an image");
    }

    const path = join(thumbnailDir, `${videoId}.jpg`);
    await mkdir(thumbnailDir, { recursive: true, mode: 0o750 });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await Bun.write(temporary, response);
    await rename(temporary, path);
    return path;
}

/** Deletes a video's saved thumbnail. A thumbnail that is not there is not an error. */
export async function removeThumbnail(videoId: VideoId): Promise<void> {
    await rm(join(thumbnailDir, `${videoId}.jpg`), { force: true });
}
