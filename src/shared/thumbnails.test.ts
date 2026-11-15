import { describe, expect, spyOn, test } from "bun:test";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { testVideoId } from "../../tests/helpers.ts";
import { downloadThumbnail, removeThumbnail, thumbnailDir } from "./thumbnails.ts";

const neverAborted = new AbortController().signal;

const videoId = testVideoId("abcdefghijk");

type Handler = (request: Request) => Response | Promise<Response>;

function jpeg(): Response {
    return new Response("JPEG-BYTES", { headers: { "content-type": "image/jpeg" } });
}

/** Replaces the global fetch with a stand-in for YouTube's image server that records the URLs it was asked for. */
function imageServer(handler: Handler = jpeg) {
    const requested: string[] = [];
    spyOn(globalThis, "fetch").mockImplementation((async (input: string, init?: RequestInit) => {
        const request = new Request(input, init);
        requested.push(request.url);
        return handler(request);
    }) as typeof fetch);
    return { requested };
}

describe("downloadThumbnail", () => {
    test("fetches the thumbnail, saves it at its path and returns that path", async () => {
        const server = imageServer();

        const path = await downloadThumbnail(videoId, neverAborted);

        expect(path).toBe(join(thumbnailDir, `${videoId}.jpg`));
        expect(await Bun.file(path).text()).toBe("JPEG-BYTES");
        expect(server.requested).toHaveLength(1);
    });

    test("always fetches, even when a thumbnail is already saved", async () => {
        const server = imageServer();
        await downloadThumbnail(videoId, neverAborted);
        await downloadThumbnail(videoId, neverAborted);
        expect(server.requested).toHaveLength(2);
    });

    test("asks YouTube for the medium quality image of the right video", async () => {
        const server = imageServer();
        await downloadThumbnail(videoId, neverAborted);
        expect(server.requested).toEqual([`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`]);
    });

    test("a failure saves nothing and is retried next time", async () => {
        const outcomes: Handler[] = [() => new Response("nope", { status: 500 }), jpeg];
        imageServer((request) => (outcomes.shift() ?? jpeg)(request));

        await expect(downloadThumbnail(videoId, neverAborted)).rejects.toThrow("answered 500");
        expect(await readdir(thumbnailDir)).toEqual([]);
        expect(await Bun.file(await downloadThumbnail(videoId, neverAborted)).text()).toBe("JPEG-BYTES");
    });

    test("refuses responses that are not images", async () => {
        imageServer(() => new Response("<html>captcha</html>", { headers: { "content-type": "text/html" } }));

        await expect(downloadThumbnail(videoId, neverAborted)).rejects.toThrow("did not send an image");
        expect(await readdir(thumbnailDir)).toEqual([]);
    });

    test("stops when the signal is aborted", async () => {
        imageServer((request) => (request.signal.aborted ? Promise.reject(request.signal.reason) : jpeg()));
        await expect(downloadThumbnail(videoId, AbortSignal.abort())).rejects.toThrow();
    });

    test("creates the directory on first use", async () => {
        await rm(thumbnailDir, { recursive: true, force: true });
        imageServer();

        const path = await downloadThumbnail(videoId, neverAborted);

        expect((await stat(path)).isFile()).toBe(true);
    });
});

describe("removeThumbnail", () => {
    test("deletes the saved thumbnail and is harmless when there is none", async () => {
        imageServer();
        const path = await downloadThumbnail(videoId, neverAborted);

        await removeThumbnail(videoId);
        expect(await Bun.file(path).exists()).toBe(false);
        await removeThumbnail(videoId);
    });
});
