import { afterAll, afterEach, mock } from "bun:test";
import { removeTemporaryDirectories } from "./helpers.ts";

// Hooks registered in a preload file apply to every test file. Hooks registered in an imported
// module would only apply to the first test file that imports it.

afterEach(() => {
  mock.restore();
});

afterAll(removeTemporaryDirectories);
