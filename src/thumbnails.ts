import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { VideoId } from "./ytdlp/types.ts";

const defaultBaseUrl = "https://i.ytimg.com";
const fetchTimeoutMs = 10_000;

/** Fetches each video's thumbnail from YouTube once and keeps it on disk as `<directory>/<video id>.jpg`. */
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

/** The file holding a video's thumbnail, fetching and saving it first if necessary. */
export async function thumbnailPath(
  thumbnails: Thumbnail,
  videoId: VideoId,
  signal: AbortSignal,
): Promise<string> {
  const path = join(thumbnails.directory, `${videoId}.jpg`);
  const saved = await stat(path).then(
    () => true,
    () => false,
  );
  if (!saved) {
    await downloadThumbnail(thumbnails, videoId, path, signal);
  }
  return path;
}

/** Downloads the thumbnail and moves it into place atomically, so a half-written file is never served. */
async function downloadThumbnail(
  thumbnails: Thumbnail,
  videoId: VideoId,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await thumbnails.fetch(`${thumbnails.baseUrl}/vi/${videoId}/mqdefault.jpg`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(fetchTimeoutMs)]),
  });

  if (!response.ok) {
    throw new Error(`thumbnail server answered ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.startsWith("image/")) {
    throw new Error(`thumbnail server sent "${contentType}", not an image`);
  }

  await mkdir(thumbnails.directory, { recursive: true, mode: 0o750 });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporary, response);
  await rename(temporary, destination);
}

/** Deletes a video's saved thumbnail. A thumbnail that is not there is not an error. */
export async function removeThumbnail(thumbnails: Thumbnail, videoId: VideoId): Promise<void> {
  await rm(join(thumbnails.directory, `${videoId}.jpg`), { force: true });
}
