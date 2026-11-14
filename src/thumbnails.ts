import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { VideoId } from "./ytdlp/types.ts";

const defaultBaseUrl = "https://i.ytimg.com";
const fetchTimeoutMs = 10_000;

/** Where video thumbnails are kept on disk, as `<directory>/<video id>.jpg`, and the image server they come from. */
export type Thumbnail = {
  directory: string;
  baseUrl: string;
  fetch: typeof fetch;
};

/** @param baseUrl the image server to fetch from, YouTube's by default. */
export function createThumbnail(
  directory: string,
  baseUrl: string = defaultBaseUrl,
  fetchImplementation: typeof fetch = fetch,
): Thumbnail {
  return { directory, baseUrl: baseUrl.replace(/\/$/, ""), fetch: fetchImplementation };
}

/** Where a video's thumbnail is saved, whether or not it has been downloaded yet. */
export const thumbnailPath = (thumbnail: Thumbnail, videoId: VideoId): string =>
  join(thumbnail.directory, `${videoId}.jpg`);

/**
 * Always fetches a video's thumbnail from the image server and saves it at `thumbnailPath`,
 * moving it into place atomically so a half-written file is never served. Returns that path.
 */
export async function downloadThumbnail(
  thumbnail: Thumbnail,
  videoId: VideoId,
  signal: AbortSignal,
): Promise<string> {
  const response = await thumbnail.fetch(`${thumbnail.baseUrl}/vi/${videoId}/mqdefault.jpg`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(fetchTimeoutMs)]),
  });

  if (!response.ok) {
    throw new Error(`thumbnail server answered ${response.status}`);
  }

  if (!response.headers.get("content-type")?.startsWith("image/")) {
    throw new Error("thumbnail server did not send an image");
  }

  const path = thumbnailPath(thumbnail, videoId);
  await mkdir(thumbnail.directory, { recursive: true, mode: 0o750 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporary, response);
  await rename(temporary, path);
  return path;
}

/** Deletes a video's saved thumbnail. A thumbnail that is not there is not an error. */
export async function removeThumbnail(thumbnail: Thumbnail, videoId: VideoId): Promise<void> {
  await rm(thumbnailPath(thumbnail, videoId), { force: true });
}
