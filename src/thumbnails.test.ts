import { describe, expect, spyOn, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory, testVideoId } from "../tests/helpers.ts";
import { downloadThumbnail, removeThumbnail } from "./thumbnails.ts";

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
        const directory = await temporaryDirectory();
        const server = imageServer();

        const path = await downloadThumbnail(directory, videoId, neverAborted);

        expect(path).toBe(join(directory, `${videoId}.jpg`));
        expect(await Bun.file(path).text()).toBe("JPEG-BYTES");
        expect(server.requested).toHaveLength(1);
    });

    test("always fetches, even when a thumbnail is already saved", async () => {
        const directory = await temporaryDirectory();
        const server = imageServer();
        await downloadThumbnail(directory, videoId, neverAborted);
        await downloadThumbnail(directory, videoId, neverAborted);
        expect(server.requested).toHaveLength(2);
    });

    test("asks YouTube for the medium quality image of the right video", async () => {
        const directory = await temporaryDirectory();
        const server = imageServer();
        await downloadThumbnail(directory, videoId, neverAborted);
        expect(server.requested).toEqual([`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`]);
    });

    test("a failure saves nothing and is retried next time", async () => {
        const directory = await temporaryDirectory();
        const outcomes: Handler[] = [() => new Response("nope", { status: 500 }), jpeg];
        imageServer((request) => (outcomes.shift() ?? jpeg)(request));

        await expect(downloadThumbnail(directory, videoId, neverAborted)).rejects.toThrow("answered 500");
        expect(await readdir(directory)).toEqual([]);
        expect(await Bun.file(await downloadThumbnail(directory, videoId, neverAborted)).text()).toBe("JPEG-BYTES");
    });

    test("refuses responses that are not images", async () => {
        const directory = await temporaryDirectory();
        imageServer(() => new Response("<html>captcha</html>", { headers: { "content-type": "text/html" } }));

        await expect(downloadThumbnail(directory, videoId, neverAborted)).rejects.toThrow("did not send an image");
        expect(await readdir(directory)).toEqual([]);
    });

    test("stops when the signal is aborted", async () => {
        const directory = await temporaryDirectory();
        imageServer((request) => (request.signal.aborted ? Promise.reject(request.signal.reason) : jpeg()));
        await expect(downloadThumbnail(directory, videoId, AbortSignal.abort())).rejects.toThrow();
    });

    test("creates the directory on first use", async () => {
        const directory = join(await temporaryDirectory(), "not", "yet", "there");
        imageServer();

        const path = await downloadThumbnail(directory, videoId, neverAborted);

        expect((await stat(path)).isFile()).toBe(true);
    });
});

describe("removeThumbnail", () => {
    test("deletes the saved thumbnail and is harmless when there is none", async () => {
        const directory = await temporaryDirectory();
        imageServer();
        const path = await downloadThumbnail(directory, videoId, neverAborted);

        await removeThumbnail(directory, videoId);
        expect(await Bun.file(path).exists()).toBe(false);
        await removeThumbnail(directory, videoId);
    });
});
