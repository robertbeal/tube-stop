import { afterAll, afterEach, beforeEach, mock, setSystemTime, spyOn } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { config } from "../src/config.ts";
import { database } from "../src/db/database.ts";
import { logger } from "../src/logger.ts";
import { thumbnailDir } from "../src/thumbnails.ts";
import { removeTemporaryDirectories, testStart } from "./helpers.ts";

// Hooks registered in a preload file apply to every test file. Hooks registered in an imported
// module would only apply to the first test file that imports it.

const originalConfig = { ...config };

// Every test starts with empty tables and folders, the same settings, and the same fake time,
// which does not move on its own.
beforeEach(async () => {
    for (const table of ["videos", "channels", "users", "sqlite_sequence"]) {
        database.run(`DELETE FROM ${table}`);
    }
    await Promise.all(
        [config.mediaDir, config.cacheDir, thumbnailDir].map(async (directory) => {
            await rm(directory, { recursive: true, force: true });
            await mkdir(directory, { recursive: true });
        }),
    );
    setSystemTime(testStart);
});

// Logging is silent unless a test captures it by spying on the logger itself.
beforeEach(() => {
    spyOn(logger, "info").mockImplementation(() => undefined);
    spyOn(logger, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    mock.restore();
    setSystemTime();
    Object.assign(config, originalConfig);
});

afterAll(async () => {
    await removeTemporaryDirectories();
    await rm(process.env.TUBESTOP_TEST_ROOT ?? "", { recursive: true, force: true });
});
