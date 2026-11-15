import { mkdir } from "node:fs/promises";
import { config } from "./shared/config.ts";
import { database } from "./shared/db/database.ts";
import { logger } from "./shared/logger.ts";
import { shutdown } from "./shared/shutdown.ts";
import { runSync } from "./sync/sync.ts";
import { runDownloads } from "./sync/worker.ts";
import { createApp } from "./web/app.tsx";

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
