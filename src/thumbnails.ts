import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const defaultBaseUrl = "https://i.ytimg.com";
/** A thumbnail is tens of kilobytes; anything near this is wrong. */
const maxBytes = 2 * 1024 * 1024;
const fetchTimeoutMs = 10_000;
const validId = /^[A-Za-z0-9_-]{11}$/;

export class InvalidVideoIdError extends Error {
  constructor() {
    super("not a valid video id");
  }
}

/** Fetches each video's thumbnail from YouTube once and keeps it on disk as `<directory>/<video id>.jpg`. */
export interface ThumbnailStore {
  directory: string;
  baseUrl: string;
  fetch: typeof fetch;
}

/** @param baseUrl the image server to fetch from, YouTube's by default. */
export function createThumbnailStore(
  directory: string,
  baseUrl: string = defaultBaseUrl,
  fetchImplementation: typeof fetch = fetch,
): ThumbnailStore {
  return { directory, baseUrl: baseUrl.replace(/\/$/, ""), fetch: fetchImplementation };
}

const pathFor = (thumbnails: ThumbnailStore, videoId: string): string =>
  join(thumbnails.directory, `${videoId}.jpg`);

/** The file holding a video's thumbnail, fetching and saving it first if necessary. */
export async function thumbnailPath(
  thumbnails: ThumbnailStore,
  videoId: string,
  signal: AbortSignal,
): Promise<string> {
  if (!validId.test(videoId)) {
    throw new InvalidVideoIdError();
  }
  const path = pathFor(thumbnails, videoId);
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
  thumbnails: ThumbnailStore,
  videoId: string,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  const timeout = AbortSignal.timeout(fetchTimeoutMs);
  const response = await thumbnails.fetch(`${thumbnails.baseUrl}/vi/${videoId}/mqdefault.jpg`, {
    signal: AbortSignal.any([signal, timeout]),
  });
  if (response.status !== 200) {
    throw new Error(`thumbnail server answered ${response.status} ${response.statusText}`.trim());
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    throw new Error(`thumbnail server sent "${contentType}", not an image`);
  }
  const body = await response.bytes();
  if (body.length > maxBytes) {
    throw new Error("thumbnail is unreasonably large");
  }
  await mkdir(thumbnails.directory, { recursive: true, mode: 0o750 });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporary, body);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Deletes a video's saved thumbnail. A thumbnail that is not there is not an error. */
export async function removeThumbnail(thumbnails: ThumbnailStore, videoId: string): Promise<void> {
  if (!validId.test(videoId)) {
    throw new InvalidVideoIdError();
  }
  await rm(pathFor(thumbnails, videoId), { force: true });
}
