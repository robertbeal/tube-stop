import { describe, expect, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory } from "./test-helpers.ts";
import { createThumbnail, InvalidVideoIdError, removeThumbnail, thumbnailPath } from "./thumbnails.ts";

const neverAborted = new AbortController().signal;

const videoId = "abcdefghijk";
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
  test("fetches the thumbnail once and then serves it from disk", async () => {
    const { store, server } = await storeFor();

    const first = await thumbnailPath(store, videoId, neverAborted);
    const second = await thumbnailPath(store, videoId, neverAborted);

    expect(await Bun.file(first).text()).toBe("JPEG-BYTES");
    expect(second).toBe(first);
    expect(server.requested).toHaveLength(1);
  });

  test("asks for the medium quality image of the right video", async () => {
    const { store, server } = await storeFor();
    await thumbnailPath(store, videoId, neverAborted);
    expect(server.requested).toEqual([`/vi/${videoId}/mqdefault.jpg`]);
  });

  test("rejects ids that are not YouTube ids without contacting the server", async () => {
    const { store, server } = await storeFor();
    const invalidIds = ["", "short", "../../etc/passwd", "abcdefghijk/../x", "abcdefghij ", "abcdefghijkl"];

    const results = await Promise.all(
      invalidIds.map((id) => thumbnailPath(store, id, neverAborted).catch((error) => error)),
    );

    expect(results.every((result) => result instanceof InvalidVideoIdError)).toBe(true);
    expect(server.requested).toEqual([]);
  });

  test("a failure saves nothing and is retried next time", async () => {
    const outcomes: Handler[] = [() => new Response("nope", { status: 500 }), jpeg];
    const { store, directory } = await storeFor((request) => (outcomes.shift() ?? jpeg)(request));

    await expect(thumbnailPath(store, videoId, neverAborted)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
    expect(await Bun.file(await thumbnailPath(store, videoId, neverAborted)).text()).toBe("JPEG-BYTES");
  });

  test("refuses responses that are not images", async () => {
    const { store, directory } = await storeFor(
      () => new Response("<html>captcha</html>", { headers: { "content-type": "text/html" } }),
    );

    await expect(thumbnailPath(store, videoId, neverAborted)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  test("refuses absurdly large responses", async () => {
    const { store } = await storeFor(
      () => new Response("x".repeat(3 << 20), { headers: { "content-type": "image/jpeg" } }),
    );
    await expect(thumbnailPath(store, videoId, neverAborted)).rejects.toThrow();
  });

  test("stops when the signal is aborted", async () => {
    const abortAware: Handler = (request) =>
      request.signal.aborted ? Promise.reject(request.signal.reason) : jpeg();
    const { store } = await storeFor(abortAware);
    await expect(thumbnailPath(store, videoId, AbortSignal.abort())).rejects.toThrow();
  });

  test("creates the directory on first use", async () => {
    const parent = await temporaryDirectory();
    const directory = join(parent, "not", "yet", "there");
    const store = createThumbnail(directory, baseUrl, imageServer().fetchImplementation);

    const path = await thumbnailPath(store, videoId, neverAborted);

    expect((await stat(path)).isFile()).toBe(true);
  });
});

describe("removeThumbnail", () => {
  test("deletes the saved thumbnail and is harmless when there is none", async () => {
    const { store } = await storeFor();
    const path = await thumbnailPath(store, videoId, neverAborted);

    await removeThumbnail(store, videoId);
    expect(await Bun.file(path).exists()).toBe(false);
    await removeThumbnail(store, videoId);
  });

  test("rejects an invalid id", async () => {
    const { store } = await storeFor();
    await expect(removeThumbnail(store, "../escape")).rejects.toBeInstanceOf(InvalidVideoIdError);
  });
});
