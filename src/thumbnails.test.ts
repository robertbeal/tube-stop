import { describe, expect, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory } from "./test-helpers.ts";
import { InvalidVideoIdError, ThumbnailStore } from "./thumbnails.ts";

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
  return { directory, server, store: new ThumbnailStore(directory, baseUrl, server.fetchImplementation) };
}

describe("ThumbnailStore.path", () => {
  test("fetches the thumbnail once and then serves it from disk", async () => {
    const { store, server } = await storeFor();

    const first = await store.path(videoId);
    const second = await store.path(videoId);

    expect(await Bun.file(first).text()).toBe("JPEG-BYTES");
    expect(second).toBe(first);
    expect(server.requested).toHaveLength(1);
  });

  test("asks for the medium quality image of the right video", async () => {
    const { store, server } = await storeFor();
    await store.path(videoId);
    expect(server.requested).toEqual([`/vi/${videoId}/mqdefault.jpg`]);
  });

  test("rejects ids that are not YouTube ids without contacting the server", async () => {
    const { store, server } = await storeFor();
    const invalidIds = ["", "short", "../../etc/passwd", "abcdefghijk/../x", "abcdefghij ", "abcdefghijkl"];

    const results = await Promise.all(invalidIds.map((id) => store.path(id).catch((error) => error)));

    expect(results.every((result) => result instanceof InvalidVideoIdError)).toBe(true);
    expect(server.requested).toEqual([]);
  });

  test("a failure saves nothing and is retried next time", async () => {
    const outcomes: Handler[] = [() => new Response("nope", { status: 500 }), jpeg];
    const { store, directory } = await storeFor((request) => (outcomes.shift() ?? jpeg)(request));

    await expect(store.path(videoId)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
    expect(await Bun.file(await store.path(videoId)).text()).toBe("JPEG-BYTES");
  });

  test("refuses responses that are not images", async () => {
    const { store, directory } = await storeFor(
      () => new Response("<html>captcha</html>", { headers: { "content-type": "text/html" } }),
    );

    await expect(store.path(videoId)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  test("refuses absurdly large responses", async () => {
    const { store } = await storeFor(
      () => new Response("x".repeat(3 << 20), { headers: { "content-type": "image/jpeg" } }),
    );
    await expect(store.path(videoId)).rejects.toThrow();
  });

  test("stops when the signal is aborted", async () => {
    const abortAware: Handler = (request) =>
      request.signal.aborted ? Promise.reject(request.signal.reason) : jpeg();
    const { store } = await storeFor(abortAware);
    await expect(store.path(videoId, AbortSignal.abort())).rejects.toThrow();
  });

  test("creates the directory on first use", async () => {
    const parent = await temporaryDirectory();
    const directory = join(parent, "not", "yet", "there");
    const store = new ThumbnailStore(directory, baseUrl, imageServer().fetchImplementation);

    const path = await store.path(videoId);

    expect((await stat(path)).isFile()).toBe(true);
  });
});

describe("ThumbnailStore.remove", () => {
  test("deletes the saved thumbnail and is harmless when there is none", async () => {
    const { store } = await storeFor();
    const path = await store.path(videoId);

    await store.remove(videoId);
    expect(await Bun.file(path).exists()).toBe(false);
    await store.remove(videoId);
  });

  test("rejects an invalid id", async () => {
    const { store } = await storeFor();
    await expect(store.remove("../escape")).rejects.toBeInstanceOf(InvalidVideoIdError);
  });
});
