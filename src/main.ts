import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resetAdmin } from "./commands.ts";
import { loadConfig } from "./config.ts";
import { Store } from "./db/store.ts";
import { DownloadWorker } from "./download.ts";
import { ChannelSyncer } from "./syncer.ts";
import { ThumbnailStore } from "./thumbnails.ts";
import { createApp } from "./web/app.tsx";
import { downloadToCache, downloadToLibrary, listChannel, resolveUrl } from "./ytdlp.ts";

async function serve(config: ReturnType<typeof loadConfig>): Promise<void> {
  // Other users (such as a Jellyfin container) need to read the media folders.
  await Promise.all(
    [config.dataDir, config.mediaDir, config.cacheDir].map((directory) =>
      mkdir(directory, { recursive: true, mode: 0o755 }),
    ),
  );
  const mediaDir = resolve(config.mediaDir);
  const cacheDir = resolve(config.cacheDir);

  const store = new Store(join(config.dataDir, "tubestop.db"));
  const binary = config.ytdlpBin;
  const syncer = new ChannelSyncer(
    store,
    { listChannel: listChannel.bind(null, binary) },
    config.syncIntervalMs,
  );
  const downloads = new DownloadWorker(
    store,
    {
      downloadToLibrary: downloadToLibrary.bind(null, binary),
      downloadToCache: downloadToCache.bind(null, binary),
    },
    {
      mediaDir,
      cacheDir,
      keepMaxHeight: config.keepMaxHeight,
      cacheTtlMs: config.cacheTtlMs,
      cacheMaxBytes: config.cacheMaxBytes,
    },
  );
  const app = createApp({
    store,
    resolver: { resolve: resolveUrl.bind(null, binary) },
    syncer,
    downloads,
    thumbnails: new ThumbnailStore(join(config.dataDir, "thumbs")),
    mediaDir,
    cacheDir,
    sessionLifetimeMs: config.sessionLifetimeMs,
  });

  const stopping = new AbortController();
  const workers = Promise.all([syncer.run(stopping.signal), downloads.run(stopping.signal)]);
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: app.fetch,
    idleTimeout: 120, // resolving a pasted URL can take a while without sending anything
  });
  console.log(`listening on ${server.url} (media: ${mediaDir})`);

  const stopped = new Promise<void>((done) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        stopping.abort();
        done();
      });
    }
  });
  await stopped;
  await server.stop(true); // close idle keep-alive connections too, or shutdown would wait for them
  await workers; // workers stop before the database closes
  store.close();
}

async function main(): Promise<void> {
  const config = (() => {
    try {
      return loadConfig(process.env);
    } catch (error) {
      throw new Error(`invalid configuration:\n${error instanceof Error ? error.message : error}`);
    }
  })();
  const [command] = process.argv.slice(2);
  if (command === undefined) {
    return serve(config);
  }
  if (command === "reset-admin") {
    return resetAdmin(config.dataDir, console.log);
  }
  throw new Error(`unknown command "${command}" (the only command is: reset-admin)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
