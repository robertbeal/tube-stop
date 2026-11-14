import { describe, expect, test } from "bun:test";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory } from "../test-helpers.ts";
import { parseRange, serveFile } from "./files.ts";

describe("parseRange", () => {
  test.each([
    ["bytes=2-5", { start: 2, end: 5 }],
    ["bytes=0-0", { start: 0, end: 0 }],
    ["bytes=4-", { start: 4, end: 9 }],
    ["bytes=-3", { start: 7, end: 9 }],
    ["bytes=-100", { start: 0, end: 9 }],
    ["bytes=5-100", { start: 5, end: 9 }],
  ])("%s of a 10 byte file is %p", (header, expected) => {
    expect(parseRange(header, 10)).toEqual(expected);
  });

  test.each([["bytes=10-"], ["bytes=20-30"], ["bytes=5-2"]])("%s is unsatisfiable for 10 bytes", (header) => {
    expect(parseRange(header, 10)).toBe("unsatisfiable");
  });

  test.each([[null], [""], ["bytes=-"], ["items=1-2"], ["bytes=1-2,4-5"], ["bytes=a-b"]])(
    "%p is ignored, so the whole file is served",
    (header) => {
      expect(parseRange(header, 10)).toBeUndefined();
    },
  );
});

async function fileWithContents(name: string, contents: string): Promise<string> {
  const path = join(await temporaryDirectory(), name);
  await Bun.write(path, contents);
  return path;
}

const requestWith = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/file", { headers });

describe("serveFile", () => {
  test("serves the whole file with its type, length and range support", async () => {
    const path = await fileWithContents("clip.mp4", "0123456789");

    const response = await serveFile(requestWith(), path);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("0123456789");
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-type")).toStartWith("video/mp4");
  });

  test("serves the requested bytes as 206 partial content", async () => {
    const path = await fileWithContents("clip.mp4", "0123456789");

    const response = await serveFile(requestWith({ Range: "bytes=2-5" }), path);

    expect(response.status).toBe(206);
    expect(await response.text()).toBe("2345");
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("content-length")).toBe("4");
  });

  test("serves the end of the file for an open-ended range", async () => {
    const path = await fileWithContents("clip.mp4", "0123456789");

    const response = await serveFile(requestWith({ Range: "bytes=7-" }), path);

    expect(await response.text()).toBe("789");
  });

  test("answers a range past the end with 416 and the file size", async () => {
    const path = await fileWithContents("clip.mp4", "0123456789");

    const response = await serveFile(requestWith({ Range: "bytes=50-60" }), path);

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
  });

  test("sends Last-Modified from the file's modification time", async () => {
    const path = await fileWithContents("clip.mp4", "0123456789");
    const modified = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    await utimes(path, modified, modified);

    const response = await serveFile(requestWith(), path);

    expect(response.headers.get("last-modified")).toBe(modified.toUTCString());
  });

  test("answers 304 with no body when the file is not newer than If-Modified-Since", async () => {
    const path = await fileWithContents("clip.mp4", "0123456789");
    const modified = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    await utimes(path, modified, modified);

    const response = await serveFile(requestWith({ "If-Modified-Since": modified.toUTCString() }), path);

    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("last-modified")).toBe(modified.toUTCString());
  });

  test("serves the file again when it changed after If-Modified-Since", async () => {
    const path = await fileWithContents("clip.mp4", "0123456789");
    const modified = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    await utimes(path, modified, modified);
    const earlier = new Date(modified.getTime() - 60_000);

    const response = await serveFile(requestWith({ "If-Modified-Since": earlier.toUTCString() }), path);

    expect(response.status).toBe(200);
  });

  test("includes the extra headers the caller asks for", async () => {
    const path = await fileWithContents("pic.jpg", "x");

    const response = await serveFile(requestWith(), path, { "Cache-Control": "public, max-age=86400" });

    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
  });

  test("a missing file or a folder is not found", async () => {
    const directory = await temporaryDirectory();
    expect((await serveFile(requestWith(), join(directory, "missing.mp4"))).status).toBe(404);
    expect((await serveFile(requestWith(), directory)).status).toBe(404);
  });
});
