// Runs before anything else, so the app's config singleton reads these when it is first imported.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "tubestop-"));

process.env.TUBESTOP_TEST_ROOT = root;
process.env.DATA_DIR = join(root, "data");
process.env.MEDIA_DIR = join(root, "media");
process.env.CACHE_DIR = join(root, "cache");
process.env.YTDLP_BIN = "yt-dlp-not-installed";
