import { stat } from "node:fs/promises";
import type { Video } from "./db/store.ts";
import { removeMedia } from "./storage.ts";
import { createWakeup, sleep, type Wakeup, waitForWakeup, wake } from "./wakeup.ts";
import type { Download } from "./ytdlp/types.ts";

/** Watch-once copies are always fetched at this height. */
const cacheHeight = 720;
const pollIntervalMs = 30 * 1000;
const janitorIntervalMs = 60 * 60 * 1000;

export interface DownloadStore {
  resetDownloading(): void;
  claimDownload(): string | null;
  finishDownload(youtubeId: string, path: string): boolean;
  failDownload(youtubeId: string, message: string): void;
  claimCache(): string | null;
  finishCache(youtubeId: string, path: string): boolean;
  failCache(youtubeId: string, message: string): void;
  clearCache(youtubeId: string): void;
  cacheEntries(): Video[];
}

export interface DownloadConfig {
  /** Pinned downloads, one folder per channel. */
  mediaDir: string;
  /** Temporary watch-once copies. */
  cacheDir: string;
  /** Maximum video height for pinned downloads. */
  keepMaxHeight: number;
  /** Cache entries not played for this long are evicted. */
  cacheTtlMs: number;
  /** Cache entries are evicted, least recently played first, above this size. */
  cacheMaxBytes: number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Downloads pinned videos and watch-once cache copies, and keeps the cache within its limits. */
export class DownloadWorker {
  readonly #store: DownloadStore;
  readonly #downloadToLibrary: Download;
  readonly #downloadToCache: Download;
  readonly #config: DownloadConfig;
  readonly #log: (message: string) => void;
  readonly #pinWakeup = createWakeup();
  readonly #cacheWakeup = createWakeup();

  constructor(
    store: DownloadStore,
    downloadToLibrary: Download,
    downloadToCache: Download,
    config: DownloadConfig,
    log: (message: string) => void = console.log,
  ) {
    this.#store = store;
    this.#downloadToLibrary = downloadToLibrary;
    this.#downloadToCache = downloadToCache;
    this.#config = config;
    this.#log = log;
  }

  /** Wakes the pinned-download loop. Never blocks. */
  triggerPins(): void {
    wake(this.#pinWakeup);
  }

  /** Wakes the cache-download loop. Never blocks. */
  triggerCache(): void {
    wake(this.#cacheWakeup);
  }

  /** Runs the pin and cache loops and the hourly janitor until `signal` aborts and the loops have stopped. */
  async run(signal: AbortSignal): Promise<void> {
    this.#store.resetDownloading();
    await Promise.all([
      this.#loop(this.#pinWakeup, signal, () => this.processPin(signal)),
      this.#loop(this.#cacheWakeup, signal, () => this.processCache(signal)),
      this.#janitorLoop(signal),
    ]);
  }

  /** Keeps processing while there is work, then waits for the poll interval or a wake-up. */
  async #loop(wakeup: Wakeup, signal: AbortSignal, processNext: () => Promise<boolean>): Promise<void> {
    while (!signal.aborted) {
      while (await processNext().catch((error) => this.#logFailure(error))) {
        // more work is queued
      }
      await waitForWakeup(wakeup, pollIntervalMs, signal);
    }
  }

  #logFailure(error: unknown): false {
    this.#log(`download: ${describe(error)}`);
    return false;
  }

  async #janitorLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.janitor();
      await sleep(janitorIntervalMs, signal);
    }
  }

  /** Downloads the next queued pinned video. False when there was nothing to do or the loop should pause. */
  async processPin(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) {
      return false;
    }
    const id = this.#store.claimDownload();
    if (id === null) {
      return false;
    }
    this.#log(`download: pinning ${id}`);
    try {
      const path = await this.#downloadToLibrary(
        id,
        this.#config.mediaDir,
        this.#config.keepMaxHeight,
        signal,
      );
      const kept = this.#store.finishDownload(id, path);
      if (!kept) {
        await this.#discard(this.#config.mediaDir, path); // unpinned or removed while downloading
      } else {
        this.#log(`download: pinned ${id} -> ${path}`);
      }
    } catch (error) {
      this.#log(`download: ${id} failed: ${describe(error)}`);
      if (signal.aborted) {
        return false;
      }
      this.#store.failDownload(id, describe(error));
    }
    return true;
  }

  /** Downloads the next queued watch-once copy. False when there was nothing to do or the loop should pause. */
  async processCache(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) {
      return false;
    }
    const id = this.#store.claimCache();
    if (id === null) {
      return false;
    }
    this.#log(`cache: fetching ${id}`);
    try {
      const path = await this.#downloadToCache(id, this.#config.cacheDir, cacheHeight, signal);
      const stored = this.#store.finishCache(id, path);
      if (!stored) {
        await this.#discard(this.#config.cacheDir, path); // removed while downloading
      }
    } catch (error) {
      this.#log(`cache: ${id} failed: ${describe(error)}`);
      if (signal.aborted) {
        return false;
      }
      this.#store.failCache(id, describe(error));
    }
    return true;
  }

  async #discard(root: string, path: string): Promise<void> {
    const failures = await removeMedia(root, path);
    for (const failure of failures) {
      this.#log(`download: delete ${path}: ${failure.message}`);
    }
  }

  /**
   * Evicts cached copies that are redundant (the video is pinned and downloaded), stale (not
   * played within the TTL), or over the size budget (least recently played first).
   */
  async janitor(now: number = Date.now()): Promise<void> {
    const inspected = await Promise.all(
      this.#store.cacheEntries().map(async (video) => ({ video, size: await fileSize(video.cachePath) })),
    );
    const vanished = inspected.filter(({ size }) => size === undefined);
    const present = inspected.flatMap(({ video, size }) => (size === undefined ? [] : [{ video, size }]));
    const expired = present.filter(({ video }) => this.#isRedundant(video) || this.#isStale(video, now));
    const survivors = present.filter((entry) => !expired.includes(entry));

    for (const { video } of vanished) {
      this.#store.clearCache(video.youtubeId); // the file vanished: fetch again on the next play
    }
    const toEvict = [...expired, ...overBudget(survivors, this.#config.cacheMaxBytes)];
    await Promise.all(toEvict.map(({ video }) => this.#evict(video)));
  }

  #isRedundant(video: Video): boolean {
    return video.pinned && video.downloadStatus === "ready";
  }

  #isStale(video: Video, now: number): boolean {
    return now - video.lastPlayedAt * 1000 > this.#config.cacheTtlMs;
  }

  async #evict(video: Video): Promise<void> {
    this.#log(`janitor: evicting ${video.youtubeId}`);
    await this.#discard(this.#config.cacheDir, video.cachePath);
    this.#store.clearCache(video.youtubeId);
  }
}

async function fileSize(path: string): Promise<number | undefined> {
  return stat(path).then(
    (info) => info.size,
    () => undefined,
  );
}

interface SizedEntry {
  video: Video;
  size: number;
}

/** The entries to evict, from the front of the list (least recently played), to bring the total within the budget. */
function overBudget(entries: SizedEntry[], maxBytes: number): SizedEntry[] {
  const total = entries.reduce((sum, { size }) => sum + size, 0);
  return entries.reduce<{ remaining: number; evict: SizedEntry[] }>(
    (state, entry) =>
      state.remaining > maxBytes
        ? { remaining: state.remaining - entry.size, evict: [...state.evict, entry] }
        : state,
    { remaining: total, evict: [] },
  ).evict;
}
