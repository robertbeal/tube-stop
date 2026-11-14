import type { Channel, NewVideo } from "./db/store.ts";
import { Wakeup } from "./wakeup.ts";
import type { ListChannel, Video } from "./ytdlp.ts";

/** How many of a channel's newest videos each sync looks at. */
const recentVideos = 50;
const perChannelTimeoutMs = 3 * 60 * 1000;

export interface SyncStore {
  channels(): Channel[];
  insertSynced(video: NewVideo): void;
  markSynced(youtubeId: string): void;
}

/** Copies the recent videos of each allowed channel into the database, on a schedule and on demand. */
export class ChannelSyncer {
  readonly #store: SyncStore;
  readonly #listChannel: ListChannel;
  readonly #intervalMs: number;
  readonly #log: (message: string) => void;
  readonly #wakeup = new Wakeup();

  constructor(
    store: SyncStore,
    listChannel: ListChannel,
    intervalMs: number,
    log: (message: string) => void = console.log,
  ) {
    this.#store = store;
    this.#listChannel = listChannel;
    this.#intervalMs = intervalMs;
    this.#log = log;
  }

  /** Requests an immediate sync of all channels. Never blocks; repeated requests before the sync starts merge into one. */
  trigger(): void {
    this.#wakeup.wake();
  }

  /** Syncs once straight away, then on every interval or trigger, until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    await this.syncAll(signal);
    while (!signal.aborted) {
      await this.#wakeup.wait(this.#intervalMs, signal);
      await this.syncAll(signal);
    }
  }

  async syncAll(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return;
    }
    const channels = this.#listChannels();
    for (const channel of channels) {
      if (signal.aborted) {
        return;
      }
      await this.#syncChannel(channel, signal);
    }
  }

  #listChannels(): Channel[] {
    try {
      return this.#store.channels();
    } catch (error) {
      this.#log(`sync: list channels: ${describe(error)}`);
      return [];
    }
  }

  async #syncChannel(channel: Channel, signal: AbortSignal): Promise<void> {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(perChannelTimeoutMs)]);
    try {
      const listed = await this.#listChannel(channel.youtubeId, recentVideos, timeout);
      // Insert oldest first so newer videos get higher ids, and are shown first.
      for (const video of listed.toReversed()) {
        this.#insert(channel, video);
      }
      this.#store.markSynced(channel.youtubeId);
      this.#log(`sync: ${channel.name}: ${listed.length} videos`);
    } catch (error) {
      this.#log(`sync: ${channel.name}: ${describe(error)}`);
    }
  }

  #insert(channel: Channel, video: Video): void {
    try {
      this.#store.insertSynced({
        youtubeId: video.id,
        channelYoutubeId: channel.youtubeId,
        channelName: channel.name,
        title: video.title || video.id,
        duration: video.duration,
        publishedAt: video.publishedAt,
      });
    } catch (error) {
      this.#log(`sync: insert ${video.id}: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
