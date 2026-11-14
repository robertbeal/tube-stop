import { describe, expect, test } from "bun:test";
import type { Page, VideoPage } from "../../src/db/store.ts";
import { listLink, loadPage, paginate, requestedPage } from "../../src/web/paging.ts";

const pageUrl = (page: number) => `/list?page=${page}`;

describe("requestedPage", () => {
  test.each([
    ["3", 3],
    ["1", 1],
    ["0", 1],
    ["-3", 1],
    ["abc", 1],
    ["", 1],
    ["2.5", 1],
    [" 2", 1],
    ["99999999999999999999", 1_000_000],
    [undefined, 1],
  ])("%p is page %p", (raw, expected) => {
    expect(requestedPage(raw)).toBe(expected);
  });
});

describe("paginate", () => {
  test("the first of several pages links only forward", () => {
    expect(paginate(1, 10, 25, pageUrl)).toEqual({
      number: 1,
      from: 1,
      to: 10,
      total: 25,
      previousUrl: "",
      nextUrl: "/list?page=2",
    });
  });

  test("a middle page links both ways", () => {
    const pages = paginate(2, 10, 25, pageUrl);
    expect(pages.previousUrl).toBe("/list?page=1");
    expect(pages.nextUrl).toBe("/list?page=3");
    expect([pages.from, pages.to]).toEqual([11, 20]);
  });

  test("the last page ends at the total and links only back", () => {
    const pages = paginate(3, 10, 25, pageUrl);
    expect([pages.from, pages.to]).toEqual([21, 25]);
    expect(pages.previousUrl).toBe("/list?page=2");
    expect(pages.nextUrl).toBe("");
  });

  test("a page past the end is clamped to the last page", () => {
    expect(paginate(99, 10, 25, pageUrl).number).toBe(3);
  });

  test("a page below one is clamped to the first page", () => {
    expect(paginate(-4, 10, 25, pageUrl).number).toBe(1);
  });

  test("an empty list is one empty page with no links", () => {
    expect(paginate(5, 10, 0, pageUrl)).toEqual({
      number: 1,
      from: 0,
      to: 0,
      total: 0,
      previousUrl: "",
      nextUrl: "",
    });
  });

  test("exactly one full page has no next link", () => {
    expect(paginate(1, 10, 10, pageUrl).nextUrl).toBe("");
  });
});

describe("listLink", () => {
  test("the first page without a filter is the bare path", () => {
    expect(listLink("/", "")(1)).toBe("/");
  });

  test("later pages add the page number", () => {
    expect(listLink("/admin", "")(3)).toBe("/admin?page=3");
  });

  test("a channel filter is kept, ahead of the page number", () => {
    expect(listLink("/", "UC1")(1)).toBe("/?channel=UC1");
    expect(listLink("/", "UC1")(2)).toBe("/?channel=UC1&page=2");
  });

  test("the channel is URL-encoded", () => {
    expect(listLink("/", "a&b c")(1)).toBe("/?channel=a%26b+c");
  });
});

describe("loadPage", () => {
  const allVideos = Array.from({ length: 25 }, (_, index) => ({ youtubeId: `video${index}` }));
  const fetchPage = (page: Page): VideoPage => {
    return {
      videos: allVideos.slice(page.offset, page.offset + page.limit) as unknown as VideoPage["videos"],
      total: allVideos.length,
    };
  };

  test("fetches the requested page once when it exists", () => {
    const requests: Page[] = [];
    const { videos, pages } = loadPage(
      (page) => {
        requests.push(page);
        return fetchPage(page);
      },
      2,
      10,
      pageUrl,
    );
    expect(requests).toEqual([{ limit: 10, offset: 10 }]);
    expect(videos).toHaveLength(10);
    expect(pages.number).toBe(2);
  });

  test("fetches again when the page asked for is past the end", () => {
    const requests: Page[] = [];
    const { videos, pages } = loadPage(
      (page) => {
        requests.push(page);
        return fetchPage(page);
      },
      9,
      10,
      pageUrl,
    );
    expect(requests).toEqual([
      { limit: 10, offset: 80 },
      { limit: 10, offset: 20 },
    ]);
    expect(videos).toHaveLength(5);
    expect(pages.number).toBe(3);
  });
});
