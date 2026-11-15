import { mkdir } from "node:fs/promises";
import { config } from "./config.ts";
import { database } from "./db/database.ts";
import { runDownloads } from "./downloads/worker.ts";
import { logger } from "./logger.ts";
import { shutdown } from "./shutdown.ts";
import { runSync } from "./syncer.ts";
import { createApp } from "./web/app.tsx";

/** Runs the app until it is told to stop. */
export async function serve(): Promise<void> {
    // Other users (such as a Jellyfin container) need to read the media folders.
    await Promise.all(
        [config.mediaDir, config.cacheDir].map((directory) => mkdir(directory, { recursive: true, mode: 0o755 })),
    );

    const app = createApp();
    const workers = Promise.all([runSync(shutdown.signal), runDownloads(shutdown.signal)]);
    const server = Bun.serve({
        hostname: config.host,
        port: config.port,
        fetch: app.fetch,
        idleTimeout: 120, // resolving a pasted URL can take a while without sending anything
    });
    logger.info(`listening on ${server.url} (media: ${config.mediaDir})`);

    const stopped = new Promise<void>((done) => {
        for (const signal of ["SIGINT", "SIGTERM"] as const) {
            process.once(signal, () => {
                shutdown.abort();
                done();
            });
        }
    });
    await stopped;
    await server.stop(true); // close idle keep-alive connections too, or shutdown would wait for them
    await workers; // workers stop before the database closes
    database.close();
}
