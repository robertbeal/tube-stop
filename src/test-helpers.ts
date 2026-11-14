import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVideoId } from "./ytdlp/info.ts";
import type { VideoId } from "./ytdlp/types.ts";

const directories: string[] = [];

/** Removes every directory made by `temporaryDirectory`. The test setup runs this once, after all tests. */
export async function removeTemporaryDirectories(): Promise<void> {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
}

/** A fresh temporary directory, removed after the test run. */
export async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tubestop-"));
  directories.push(directory);
  return directory;
}

export interface Stub {
  /** Path of the fake yt-dlp executable. */
  binary: string;
  /** Reads the arguments of the most recent call, one per element. */
  arguments(): Promise<string[]>;
}

/**
 * Writes a fake yt-dlp: a shell script that records its arguments (one per line) and then
 * runs `body`, which can print JSON or a file path, or exit non-zero.
 */
export async function stubYtDlp(body: string): Promise<Stub> {
  const directory = await temporaryDirectory();
  const binary = join(directory, "yt-dlp");
  const argumentsFile = join(directory, "arguments.txt");
  await Bun.write(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argumentsFile}'\n${body}\n`);
  await chmod(binary, 0o755);
  return {
    binary,
    arguments: async () => (await Bun.file(argumentsFile).text()).trimEnd().split("\n"),
  };
}

/** A video id for a test: a literal that must be a valid YouTube video id. */
export function testVideoId(value: string): VideoId {
  const id = parseVideoId(value);
  if (id === undefined) {
    throw new Error(`"${value}" is not a valid video id`);
  }
  return id;
}

/** A random 11-character video id, as YouTube uses. */
export function randomVideoId(): VideoId {
  return testVideoId(
    Buffer.from(crypto.getRandomValues(new Uint8Array(9)))
      .toString("base64url")
      .slice(0, 11),
  );
}
