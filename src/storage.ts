import { readdir, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

function isInside(root: string, path: string): boolean {
  return path.startsWith(root + sep);
}

async function removeQuietly(path: string): Promise<Error | undefined> {
  try {
    await rm(path, { force: true });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Deletes a media file and the files that share its name apart from the extension (its
 * thumbnail, for example), then the folder it was in if that is now empty. Paths outside
 * root, including root itself, are ignored. Files that are already gone are not a failure.
 * Returns the failures, so the caller can report them without losing the rest.
 */
export async function removeMedia(root: string, path: string): Promise<Error[]> {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  if (path === "" || !isInside(absoluteRoot, absolutePath)) {
    return [];
  }
  const directory = dirname(absolutePath);
  const stem = basename(absolutePath, extname(absolutePath));
  const siblings = await readdir(directory).catch(() => [] as string[]);
  const targets = [
    absolutePath,
    ...siblings.filter((name) => name.startsWith(`${stem}.`)).map((name) => join(directory, name)),
  ];

  const failures = (await Promise.all([...new Set(targets)].map(removeQuietly))).filter(
    (failure) => failure !== undefined,
  );
  if (directory !== absoluteRoot) {
    await rmdir(directory).catch(() => undefined); // fails harmlessly when other videos remain in the folder
  }
  return failures;
}

/** Total size in bytes of the files under root. Best effort: unreadable entries count as zero. */
export async function directorySize(root: string): Promise<number> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  const sizes = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        stat(join(entry.parentPath, entry.name)).then(
          (info) => info.size,
          () => 0,
        ),
      ),
  );
  return sizes.reduce((total, size) => total + size, 0);
}
