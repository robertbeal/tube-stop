import { describe, expect, test } from "bun:test";
import { toChannel, toVideo } from "./info.ts";

describe("toVideo", () => {
  test("copies the video's details", () => {
    expect(
      toVideo({
        id: "abcdefghijk",
        title: "Moonlight Sonata",
        channel: "Piano Guy",
        channel_id: "UC123",
        duration: 125,
        timestamp: 1700000000,
      }),
    ).toEqual({
      id: "abcdefghijk",
      title: "Moonlight Sonata",
      channel: { id: "UC123", name: "Piano Guy" },
      duration: 125,
      publishedAt: 1700000000,
    });
  });

  test("missing fields become empty or zero", () => {
    expect(toVideo({})).toEqual({
      id: "",
      title: "",
      channel: { id: "", name: "" },
      duration: 0,
      publishedAt: 0,
    });
  });

  test("the channel name falls back to the uploader", () => {
    expect(toVideo({ uploader: "Some Uploader" }).channel.name).toBe("Some Uploader");
  });

  test("the channel name wins over the uploader", () => {
    expect(toVideo({ channel: "Piano Guy", uploader: "Some Uploader" }).channel.name).toBe("Piano Guy");
  });

  test("a fractional duration is cut to whole seconds", () => {
    expect(toVideo({ duration: 125.9 }).duration).toBe(125);
  });

  describe("published date", () => {
    test("comes from the timestamp, cut to whole seconds", () => {
      expect(toVideo({ timestamp: 1700000000.7 }).publishedAt).toBe(1700000000);
    });

    test("comes from the upload date, as midnight UTC, when there is no timestamp", () => {
      expect(toVideo({ upload_date: "20240305" }).publishedAt).toBe(Date.UTC(2024, 2, 5) / 1000);
    });

    test("the timestamp wins over the upload date", () => {
      expect(toVideo({ timestamp: 1700000000, upload_date: "20240305" }).publishedAt).toBe(1700000000);
    });

    test("a zero timestamp falls back to the upload date", () => {
      expect(toVideo({ timestamp: 0, upload_date: "20240305" }).publishedAt).toBe(
        Date.UTC(2024, 2, 5) / 1000,
      );
    });

    test.each(["not-a-date", "", "2024030", "20241399"])("%p means unknown", (uploadDate) => {
      expect(toVideo({ upload_date: uploadDate }).publishedAt).toBe(0);
    });

    test("no date at all means unknown", () => {
      expect(toVideo({ id: "abcdefghijk" }).publishedAt).toBe(0);
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
    expect(toChannel({ title: "Piano Guy", entries: [{ id: "abcdefghijk", channel_id: "UC999" }] }).id).toBe(
      "UC999",
    );
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
    ["no channel id and an entry without one", { entries: [{ id: "abcdefghijk" }] }],
    ["nothing at all", {}],
  ])("%s is rejected", (_description, info) => {
    expect(() => toChannel(info)).toThrow("could not determine channel from URL");
  });
});
