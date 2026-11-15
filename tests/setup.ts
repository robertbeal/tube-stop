import { afterAll, afterEach, beforeEach, mock, spyOn } from "bun:test";
import { logger } from "../src/logger.ts";
import { removeTemporaryDirectories } from "./helpers.ts";

// Hooks registered in a preload file apply to every test file. Hooks registered in an imported
// module would only apply to the first test file that imports it.

// Logging is silent unless a test captures it by spying on the logger itself.
beforeEach(() => {
    spyOn(logger, "info").mockImplementation(() => undefined);
    spyOn(logger, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    mock.restore();
});

afterAll(removeTemporaryDirectories);
