import { readdir, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

/**
 * Deletes a media file and the files that share its name apart from the extension (its
 * thumbnail, for example), then the folder it was in if that is now empty. Paths outside
 * root, including root itself, are ignored. Files that are already gone are not a failure.
 * Returns the failures, so the caller can report them without losing the rest.
 */
export async function removeMedia(root: string, path: string): Promise<Error[]> {
    const absoluteRoot = resolve(root);
    const absolutePath = resolve(absoluteRoot, path); // an empty path gives the root itself, which is ignored
    if (!absolutePath.startsWith(absoluteRoot + sep)) {
        return [];
    }
    const directory = dirname(absolutePath);
    const stem = basename(absolutePath, extname(absolutePath));
    const siblings = await readdir(directory).catch(() => []);
    const targets = [
        absolutePath,
        ...siblings.filter((name) => name.startsWith(`${stem}.`)).map((name) => join(directory, name)),
    ];

    const results = await Promise.allSettled(targets.map((target) => rm(target, { force: true })));
    if (directory !== absoluteRoot) {
        await rmdir(directory).catch(() => undefined); // fails harmlessly when other videos remain in the folder
    }
    return results.filter((result) => result.status === "rejected").map((result) => result.reason);
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
