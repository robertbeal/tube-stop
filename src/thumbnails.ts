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

export interface Thumbnails {
  /** The file holding a video's thumbnail, fetching and saving it first if necessary. */
  path(videoId: string, signal?: AbortSignal): Promise<string>;
  /** Deletes a video's saved thumbnail. A thumbnail that is not there is not an error. */
  remove(videoId: string): Promise<void>;
}

/** Fetches each video's thumbnail from YouTube once and keeps it on disk as `<directory>/<video id>.jpg`. */
export class ThumbnailStore implements Thumbnails {
  readonly #directory: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  /** @param baseUrl the image server to fetch from, YouTube's by default. */
  constructor(
    directory: string,
    baseUrl: string = defaultBaseUrl,
    fetchImplementation: typeof fetch = fetch,
  ) {
    this.#directory = directory;
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#fetch = fetchImplementation;
  }

  #pathFor(videoId: string): string {
    return join(this.#directory, `${videoId}.jpg`);
  }

  async path(videoId: string, signal?: AbortSignal): Promise<string> {
    if (!validId.test(videoId)) {
      throw new InvalidVideoIdError();
    }
    const path = this.#pathFor(videoId);
    const saved = await stat(path).then(
      () => true,
      () => false,
    );
    if (!saved) {
      await this.#download(videoId, path, signal);
    }
    return path;
  }

  /** Downloads the thumbnail and moves it into place atomically, so a half-written file is never served. */
  async #download(videoId: string, destination: string, signal?: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(fetchTimeoutMs);
    const response = await this.#fetch(`${this.#baseUrl}/vi/${videoId}/mqdefault.jpg`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
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
    await mkdir(this.#directory, { recursive: true, mode: 0o750 });
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      await Bun.write(temporary, body);
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async remove(videoId: string): Promise<void> {
    if (!validId.test(videoId)) {
      throw new InvalidVideoIdError();
    }
    await rm(this.#pathFor(videoId), { force: true });
  }
}
