import { describe, expect, test } from "bun:test";
import { stubYtDlp, testVideoId } from "../../../tests/helpers.ts";
import { getChannelVideos, resolveUrl } from "./resolve.ts";

const neverAborted = new AbortController().signal;

async function printing(json: string) {
    return stubYtDlp(`cat <<'EOF'\n${json}\nEOF`);
}

describe("resolve", () => {
    test("a video URL returns the video's details", async () => {
        const stub = await printing(
            '{"_type":"video","id":"abcdefghijk","title":"Moonlight Sonata","channel":"Piano Guy","channel_id":"UC123","duration":125.6}',
        );

        const resolved = await resolveUrl(stub.binary, "https://youtu.be/abcdefghijk", neverAborted);

        expect(resolved).toEqual({
            id: testVideoId("abcdefghijk"),
            title: "Moonlight Sonata",
            channel: { id: "UC123", name: "Piano Guy" },
            duration: 125,
            publishedAt: 0,
        });
    });

    test("a channel URL is reported as a channel with its identity", async () => {
        const stub = await printing(
            '{"_type":"playlist","title":"Piano Guy - Videos","channel":"Piano Guy","channel_id":"UC123","entries":[]}',
        );
        expect(await resolveUrl(stub.binary, "https://www.youtube.com/@pianoguy", neverAborted)).toEqual({
            id: "UC123",
            name: "Piano Guy",
        });
    });

    test("a channel falls back to the first entry and the playlist title", async () => {
        const stub = await printing(
            '{"_type":"playlist","title":"Piano Guy - Videos","entries":[{"id":"abcdefghijk","channel_id":"UC999"}]}',
        );
        expect(await resolveUrl(stub.binary, "https://www.youtube.com/@pianoguy/videos", neverAborted)).toEqual({
            id: "UC999",
            name: "Piano Guy",
        });
    });

    test("a playlist without a channel is rejected", async () => {
        const stub = await printing('{"_type":"playlist","title":"Mix","entries":[]}');
        await expect(resolveUrl(stub.binary, "https://example.com/list", neverAborted)).rejects.toThrow();
    });

    test("propagates a yt-dlp failure with its message", async () => {
        const stub = await stubYtDlp('echo "ERROR: Video unavailable" >&2; exit 1');
        await expect(resolveUrl(stub.binary, "https://youtu.be/gone", neverAborted)).rejects.toThrow(
            "Video unavailable",
        );
    });

    test("rejects output that is not JSON", async () => {
        const stub = await stubYtDlp('echo "not json"');
        await expect(resolveUrl(stub.binary, "x", neverAborted)).rejects.toThrow();
    });

    test("passes the URL after the end of options", async () => {
        const stub = await printing('{"_type":"video","id":"abcdefghijk"}');
        await resolveUrl(stub.binary, "--exec=evil", neverAborted);
        expect((await stub.arguments()).slice(-2)).toEqual(["--", "--exec=evil"]);
    });
});

describe("getChannelVideos", () => {
    test("returns videos in order and skips entries without an id", async () => {
        const stub = await printing(`{"_type":"playlist","entries":[
 {"id":"aaaaaaaaaaa","title":"One","duration":60},
 {"title":"No id at all"},
 {"id":"bbbbbbbbbbb","title":"Two","channel_id":"UCother"}
]}`);

        const videos = await getChannelVideos(stub.binary, "UC123", 25, neverAborted);

        expect(videos.map((video) => video.id)).toEqual([testVideoId("aaaaaaaaaaa"), testVideoId("bbbbbbbbbbb")]);
        expect(videos[0]?.channel.id).toBe("UC123");
        expect(videos[1]?.channel.id).toBe("UCother");
        const joined = (await stub.arguments()).join(" ");
        expect(joined).toContain("/channel/UC123/videos");
        expect(joined).toContain("--playlist-end 25");
    });

    test("asks for approximate dates and reads them", async () => {
        const stub = await printing(`{"_type":"playlist","entries":[
 {"id":"aaaaaaaaaaa","title":"New","timestamp":1794528000},
 {"id":"bbbbbbbbbbb","title":"No date"}]}`);

        const videos = await getChannelVideos(stub.binary, "UC123", 10, neverAborted);

        expect(videos.map((video) => video.publishedAt)).toEqual([1794528000, 0]);
        expect((await stub.arguments()).join(" ")).toContain("youtubetab:approximate_date");
    });
});
