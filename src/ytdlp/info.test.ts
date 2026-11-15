import { describe, expect, test } from "bun:test";
import { testVideoId } from "../../tests/helpers.ts";
import { type Info, parseVideoId, toChannel, toVideo } from "./info.ts";

const videoId = testVideoId("abcdefghijk");

/** The video for yt-dlp output that has a valid id. */
function videoFrom(info: Info) {
  const video = toVideo({ id: videoId, ...info });
  if (video === undefined) {
    throw new Error("expected a video");
  }
  return video;
}

describe("toVideo", () => {
  test("copies the video's details", () => {
    expect(
      toVideo({
        id: testVideoId("abcdefghijk"),
        title: "Moonlight Sonata",
        channel: "Piano Guy",
        channel_id: "UC123",
        duration: 125,
        timestamp: 1700000000,
      }),
    ).toEqual({
      id: testVideoId("abcdefghijk"),
      title: "Moonlight Sonata",
      channel: { id: "UC123", name: "Piano Guy" },
      duration: 125,
      publishedAt: 1700000000,
    });
  });

  test("missing fields other than the id become empty or zero", () => {
    expect(videoFrom({})).toEqual({
      id: videoId,
      title: "",
      channel: { id: "", name: "" },
      duration: 0,
      publishedAt: 0,
    });
  });

  test.each([undefined, "", "short", "abcdefghijkl", "../../etc/passwd", "abcdefghij "])(
    "an id of %p is not a video",
    (id) => {
      expect(toVideo({ id, title: "Anything" })).toBeUndefined();
    },
  );

  test("the channel name falls back to the uploader", () => {
    expect(videoFrom({ uploader: "Some Uploader" }).channel.name).toBe("Some Uploader");
  });

  test("the channel name wins over the uploader", () => {
    expect(videoFrom({ channel: "Piano Guy", uploader: "Some Uploader" }).channel.name).toBe("Piano Guy");
  });

  test("a fractional duration is cut to whole seconds", () => {
    expect(videoFrom({ duration: 125.9 }).duration).toBe(125);
  });

  describe("published date", () => {
    test("comes from the timestamp, cut to whole seconds", () => {
      expect(videoFrom({ timestamp: 1700000000.7 }).publishedAt).toBe(1700000000);
    });

    test("comes from the upload date, as midnight UTC, when there is no timestamp", () => {
      expect(videoFrom({ upload_date: "20240305" }).publishedAt).toBe(Date.UTC(2024, 2, 5) / 1000);
    });

    test("the timestamp wins over the upload date", () => {
      expect(videoFrom({ timestamp: 1700000000, upload_date: "20240305" }).publishedAt).toBe(1700000000);
    });

    test("a zero timestamp falls back to the upload date", () => {
      expect(videoFrom({ timestamp: 0, upload_date: "20240305" }).publishedAt).toBe(
        Date.UTC(2024, 2, 5) / 1000,
      );
    });

    test.each(["not-a-date", "", "2024030", "20241399"])("%p means unknown", (uploadDate) => {
      expect(videoFrom({ upload_date: uploadDate }).publishedAt).toBe(0);
    });

    test("no date at all means unknown", () => {
      expect(videoFrom({}).publishedAt).toBe(0);
    });
  });
});

describe("toChannel", () => {
  test("uses the channel's own id and name", () => {
    expect(toChannel({ title: "Piano Guy - Videos", channel: "Piano Guy", channel_id: "UC123" })).toEqual({
      id: "UC123",
      name: "Piano Guy",
    });
  });

  test("falls back to the first entry's channel id", () => {
    expect(
      toChannel({ title: "Piano Guy", entries: [{ id: testVideoId("abcdefghijk"), channel_id: "UC999" }] })
        .id,
    ).toBe("UC999");
  });

  test("the channel's own id wins over its entries'", () => {
    expect(toChannel({ channel_id: "UC123", entries: [{ channel_id: "UC999" }] }).id).toBe("UC123");
  });

  test("the name falls back to the uploader", () => {
    expect(toChannel({ channel_id: "UC123", uploader: "Some Uploader", title: "Ignored" }).name).toBe(
      "Some Uploader",
    );
  });

  test("the name falls back to the title without its ' - Videos' suffix", () => {
    expect(toChannel({ channel_id: "UC123", title: "Piano Guy - Videos" }).name).toBe("Piano Guy");
  });

  test("a title that does not end in ' - Videos' is kept whole", () => {
    expect(toChannel({ channel_id: "UC123", title: "Videos - Piano Guy" }).name).toBe("Videos - Piano Guy");
  });

  test("no name anywhere gives an empty name", () => {
    expect(toChannel({ channel_id: "UC123" }).name).toBe("");
  });

  test.each([
    ["no channel id and no entries", { title: "Mix", entries: [] }],
    ["no channel id and an entry without one", { entries: [{ id: testVideoId("abcdefghijk") }] }],
    ["nothing at all", {}],
  ])("%s is rejected", (_description, info) => {
    expect(() => toChannel(info)).toThrow("could not determine channel from URL");
  });
});

describe("parseVideoId", () => {
  test.each<string>(["abcdefghijk", "ABCDEFGHIJK", "0123456789_", "-_-_-_-_-_-", "dQw4w9WgXcQ"])(
    "accepts the YouTube id %p",
    (value) => {
      expect(parseVideoId(value)).toBe(value as never);
    },
  );

  test.each([
    ["nothing", undefined],
    ["an empty string", ""],
    ["too short", "abcdefghij"],
    ["too long", "abcdefghijkl"],
    ["a space", "abcdefghij "],
    ["a slash", "a/b?c"],
    ["a path climbing out of a folder", "../../x.jpg"],
    ["a dot", "abcdefghij."],
    ["a newline at the end", "abcdefghijk\n"],
    ["a non-ASCII letter", "abcdefghijé"],
  ])("rejects %s", (_description, value) => {
    expect(parseVideoId(value)).toBeUndefined();
  });
});
