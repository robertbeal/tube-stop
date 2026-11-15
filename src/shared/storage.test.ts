import { describe, expect, test } from "bun:test";
import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { temporaryDirectory } from "../../tests/helpers.ts";
import { directorySize, removeMedia } from "./storage.ts";

async function writeFile(path: string, size: number): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, new Uint8Array(size));
}

async function exists(path: string): Promise<boolean> {
    return stat(path).then(
        () => true,
        () => false,
    );
}

describe("removeMedia", () => {
    test("deletes the video, its sidecars and the empty folder", async () => {
        const root = await temporaryDirectory();
        const video = join(root, "Chan", "2024-01-01 - Song [abc].mp4");
        const thumbnail = join(root, "Chan", "2024-01-01 - Song [abc].jpg");
        await writeFile(video, 10);
        await writeFile(thumbnail, 10);

        const failures = await removeMedia(root, video);

        expect(failures).toEqual([]);
        expect(await exists(video)).toBe(false);
        expect(await exists(thumbnail)).toBe(false);
        expect(await exists(join(root, "Chan"))).toBe(false);
        expect(await exists(root)).toBe(true);
    });

    test("keeps other videos in the same folder", async () => {
        const root = await temporaryDirectory();
        const target = join(root, "Chan", "Song [aaa].mp4");
        const other = join(root, "Chan", "Song [bbb].mp4");
        const otherThumbnail = join(root, "Chan", "Song [bbb].jpg");
        await Promise.all([target, other, otherThumbnail].map((path) => writeFile(path, 1)));

        await removeMedia(root, target);

        expect(await exists(target)).toBe(false);
        expect(await exists(other)).toBe(true);
        expect(await exists(otherThumbnail)).toBe(true);
    });

    test("ignores paths outside the root", async () => {
        const parent = await temporaryDirectory();
        const root = join(parent, "media");
        await mkdir(root);
        const outside = join(parent, "other", "precious.mp4");
        const lookalike = join(parent, "media-backup", "precious.mp4");
        await writeFile(outside, 1);
        await writeFile(lookalike, 1);

        const attempts = [outside, `${root}/../other/precious.mp4`, lookalike, root, ""];
        const results = await Promise.all(attempts.map((path) => removeMedia(root, path)));

        expect(results).toEqual(attempts.map(() => []));
        expect(await exists(outside)).toBe(true);
        expect(await exists(lookalike)).toBe(true);
        expect(await exists(root)).toBe(true);
    });

    test("a missing file is not a failure", async () => {
        const root = await temporaryDirectory();
        expect(await removeMedia(root, join(root, "nothing", "here.mp4"))).toEqual([]);
    });

    test.skipIf(process.getuid?.() === 0)("reports files that cannot be deleted", async () => {
        const root = await temporaryDirectory();
        const directory = join(root, "Chan");
        const video = join(directory, "Song [abc].mp4");
        await writeFile(video, 1);
        await chmod(directory, 0o500);

        const failures = await removeMedia(root, video);
        await chmod(directory, 0o755);

        expect(failures.length).toBeGreaterThan(0);
    });
});

describe("directorySize", () => {
    test("sums all files recursively", async () => {
        const root = await temporaryDirectory();
        await writeFile(join(root, "a.bin"), 100);
        await writeFile(join(root, "sub", "b.bin"), 250);
        expect(await directorySize(root)).toBe(350);
    });

    test("a missing directory has size zero", async () => {
        const root = await temporaryDirectory();
        expect(await directorySize(join(root, "missing"))).toBe(0);
    });
});
