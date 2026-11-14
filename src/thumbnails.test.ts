import { describe, expect, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory, testVideoId } from "./test-helpers.ts";
import { createThumbnail, downloadThumbnail, removeThumbnail, thumbnailPath } from "./thumbnails.ts";

const neverAborted = new AbortController().signal;

const videoId = testVideoId("abcdefghijk");
const baseUrl = "http://images.test";

type Handler = (request: Request) => Response | Promise<Response>;

function jpeg(): Response {
  return new Response("JPEG-BYTES", { headers: { "content-type": "image/jpeg" } });
}

/** A stand-in for YouTube's image server that records the URLs it was asked for. */
function imageServer(handler: Handler = jpeg) {
  const requested: string[] = [];
  const fetchImplementation = (async (input: string, init?: RequestInit) => {
    const request = new Request(input, init);
    requested.push(new URL(request.url).pathname);
    return handler(request);
  }) as typeof fetch;
  return { requested, fetchImplementation };
}

async function storeFor(handler?: Handler) {
  const directory = await temporaryDirectory();
  const server = imageServer(handler);
  return { directory, server, store: createThumbnail(directory, baseUrl, server.fetchImplementation) };
}

describe("thumbnailPath", () => {
  test("is where the thumbnail is saved, named by the video id", async () => {
    const { store, directory } = await storeFor();
    expect(thumbnailPath(store, videoId)).toBe(join(directory, `${videoId}.jpg`));
  });

  test("does not fetch or create anything", async () => {
    const { store, directory, server } = await storeFor();
    thumbnailPath(store, videoId);
    expect(server.requested).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });
});

describe("downloadThumbnail", () => {
  test("fetches the thumbnail, saves it at its path and returns that path", async () => {
    const { store, server } = await storeFor();

    const path = await downloadThumbnail(store, videoId, neverAborted);

    expect(path).toBe(thumbnailPath(store, videoId));
    expect(await Bun.file(path).text()).toBe("JPEG-BYTES");
    expect(server.requested).toHaveLength(1);
  });

  test("always fetches, even when a thumbnail is already saved", async () => {
    const { store, server } = await storeFor();
    await downloadThumbnail(store, videoId, neverAborted);
    await downloadThumbnail(store, videoId, neverAborted);
    expect(server.requested).toHaveLength(2);
  });

  test("asks for the medium quality image of the right video", async () => {
    const { store, server } = await storeFor();
    await downloadThumbnail(store, videoId, neverAborted);
    expect(server.requested).toEqual([`/vi/${videoId}/mqdefault.jpg`]);
  });

  test("a failure saves nothing and is retried next time", async () => {
    const outcomes: Handler[] = [() => new Response("nope", { status: 500 }), jpeg];
    const { store, directory } = await storeFor((request) => (outcomes.shift() ?? jpeg)(request));

    await expect(downloadThumbnail(store, videoId, neverAborted)).rejects.toThrow("answered 500");
    expect(await readdir(directory)).toEqual([]);
    expect(await Bun.file(await downloadThumbnail(store, videoId, neverAborted)).text()).toBe("JPEG-BYTES");
  });

  test("refuses responses that are not images", async () => {
    const { store, directory } = await storeFor(
      () => new Response("<html>captcha</html>", { headers: { "content-type": "text/html" } }),
    );

    await expect(downloadThumbnail(store, videoId, neverAborted)).rejects.toThrow("did not send an image");
    expect(await readdir(directory)).toEqual([]);
  });

  test("stops when the signal is aborted", async () => {
    const abortAware: Handler = (request) =>
      request.signal.aborted ? Promise.reject(request.signal.reason) : jpeg();
    const { store } = await storeFor(abortAware);
    await expect(downloadThumbnail(store, videoId, AbortSignal.abort())).rejects.toThrow();
  });

  test("creates the directory on first use", async () => {
    const parent = await temporaryDirectory();
    const directory = join(parent, "not", "yet", "there");
    const store = createThumbnail(directory, baseUrl, imageServer().fetchImplementation);

    const path = await downloadThumbnail(store, videoId, neverAborted);

    expect((await stat(path)).isFile()).toBe(true);
  });
});

describe("removeThumbnail", () => {
  test("deletes the saved thumbnail and is harmless when there is none", async () => {
    const { store } = await storeFor();
    const path = await downloadThumbnail(store, videoId, neverAborted);

    await removeThumbnail(store, videoId);
    expect(await Bun.file(path).exists()).toBe(false);
    await removeThumbnail(store, videoId);
  });
});
