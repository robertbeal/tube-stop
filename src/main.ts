import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resetAdmin } from "./admin/reset.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { type DownloadWorker, runDownloads } from "./downloads/worker.ts";
import { logger } from "./logger.ts";
import { runSync } from "./syncer.ts";
import { createApp } from "./web/app.tsx";

async function serve(config: ReturnType<typeof loadConfig>): Promise<void> {
    // Other users (such as a Jellyfin container) need to read the media folders.
    await Promise.all(
        [config.dataDir, config.mediaDir, config.cacheDir].map((directory) =>
            mkdir(directory, { recursive: true, mode: 0o755 }),
        ),
    );
    const mediaDir = resolve(config.mediaDir);
    const cacheDir = resolve(config.cacheDir);

    const database = openDatabase(join(config.dataDir, "tubestop.db"));
    const binary = config.ytdlpBin;
    const downloads: DownloadWorker = {
        database,
        config: {
            ytdlpBinary: binary,
            mediaDir,
            cacheDir,
            keepMaxHeight: config.keepMaxHeight,
            cacheTtlMs: config.cacheTtlMs,
            cacheMaxBytes: config.cacheMaxBytes,
        },
    };
    const stopping = new AbortController();
    const app = createApp({
        database,
        ytdlpBinary: binary,
        shutdown: stopping.signal,
        thumbnailDir: join(config.dataDir, "thumbs"),
        mediaDir,
        cacheDir,
        sessionLifetimeMs: config.sessionLifetimeMs,
    });

    const workers = Promise.all([
        runSync(database, binary, config.syncIntervalMs, stopping.signal),
        runDownloads(downloads, stopping.signal),
    ]);
    const server = Bun.serve({
        hostname: config.host,
        port: config.port,
        fetch: app.fetch,
        idleTimeout: 120, // resolving a pasted URL can take a while without sending anything
    });
    logger.info(`listening on ${server.url} (media: ${mediaDir})`);

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
    database.close();
}

async function main(): Promise<void> {
    const config = (() => {
        try {
            return loadConfig(process.env);
        } catch (error) {
            throw new Error(`invalid configuration:\n${error.message}`);
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
    console.error(error.message);
    process.exit(1);
});
