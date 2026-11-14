import { afterAll } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A fresh temporary directory, removed when the test file finishes. */
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

/** A random 11-character video id, as YouTube uses. */
export function randomVideoId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(9)))
    .toString("base64url")
    .slice(0, 11);
}
