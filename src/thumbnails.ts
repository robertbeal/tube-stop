import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { VideoId } from "./ytdlp/types.ts";

const imageServer = "https://i.ytimg.com";

/**
 * Always fetches a video's thumbnail from YouTube and saves it as `<directory>/<video id>.jpg`, moving it
 * into place atomically so a half-written file is never served. Returns that path.
 */
export async function downloadThumbnail(
  directory: string,
  videoId: VideoId,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(`${imageServer}/vi/${videoId}/mqdefault.jpg`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });

  if (!response.ok) {
    throw new Error(`thumbnail server answered ${response.status}`);
  }

  if (!response.headers.get("content-type")?.startsWith("image/")) {
    throw new Error("thumbnail server did not send an image");
  }

  const path = join(directory, `${videoId}.jpg`);
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporary, response);
  await rename(temporary, path);
  return path;
}

/** Deletes a video's saved thumbnail. A thumbnail that is not there is not an error. */
export async function removeThumbnail(directory: string, videoId: VideoId): Promise<void> {
  await rm(join(directory, `${videoId}.jpg`), { force: true });
}
