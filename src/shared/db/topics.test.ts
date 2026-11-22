import { describe, expect, test } from "bun:test";
import { getChannels, insertChannel } from "./channels.ts";
import { everything, idsOf, newVideo, raw } from "./test-helpers.ts";
import {
    createTopic,
    deleteTopic,
    getChannelTopicIds,
    getShelves,
    getTopicSlugsOf,
    getTopics,
    getVideoTopicIds,
    getWatchableVideosInTopic,
    getWatchableVideosWithoutTopic,
    moveTopic,
    setChannelTopics,
    setVideoTopics,
    TopicRuleError,
    updateTopic,
} from "./topics.ts";
import { type ChannelId, NotFoundError, type TopicId } from "./types.ts";
import { allowVideo, blockVideo, deleteVideo, insertVideo } from "./videos.ts";

const channelRowId = (youtubeId: string) =>
    getChannels().find((channel) => channel.youtubeId === youtubeId)?.id as ChannelId;

describe("topics", () => {
    test("topics are added at the end, with an address made from the name", () => {
        createTopic("Art & Making", "🎨", "success");
        const nature = createTopic("Nature", "🌿", "nonsense");
        expect(getTopics().map((topic) => topic.slug)).toEqual(["art-and-making", "nature"]);
        expect(nature.color).toBe("primary");
    });

    test("a name that makes an address already in use gets a different one", () => {
        createTopic("Music", "", "primary");
        const second = createTopic("music", "", "primary");
        const reserved = createTopic("Other", "", "primary");
        expect(second.slug).toBe("music-2");
        expect(reserved.slug).toBe("other-2");
    });

    test("a topic needs a name", () => {
        expect(() => createTopic("  ", "", "primary")).toThrow(TopicRuleError);
    });

    test("editing keeps the address", () => {
        const topic = createTopic("Music", "", "primary");
        updateTopic(topic.id, "Songs", "🎵", "danger");
        expect(getTopics()).toEqual([{ ...topic, name: "Songs", emoji: "🎵", color: "danger" }]);
        expect(() => updateTopic(999 as TopicId, "x", "", "primary")).toThrow(NotFoundError);
    });

    test("topics can be moved up and down", () => {
        const [a, b, c] = ["A", "B", "C"].map((name) => createTopic(name, "", "primary"));
        moveTopic(c?.id as TopicId, "up");
        moveTopic(a?.id as TopicId, "up");
        expect(getTopics().map((topic) => topic.name)).toEqual(["A", "C", "B"]);
        moveTopic(b?.id as TopicId, "down");
        expect(getTopics().map((topic) => topic.name)).toEqual(["A", "C", "B"]);
    });
});

describe("tagging", () => {
    test("a channel can have several topics, and setting replaces them", () => {
        const [nature, science] = [createTopic("Nature", "", "primary"), createTopic("Science", "", "primary")];
        insertChannel("UC1", "Chan");
        const channel = channelRowId("UC1");
        setChannelTopics(channel, [nature.id, science.id, nature.id]);
        expect(getChannelTopicIds().get(channel)).toEqual([nature.id, science.id]);
        setChannelTopics(channel, [science.id]);
        expect(getChannelTopicIds().get(channel)).toEqual([science.id]);
    });

    test("unknown topics, channels and videos are refused", () => {
        const topic = createTopic("Nature", "", "primary");
        insertChannel("UC1", "Chan");
        const video = newVideo("UC1");
        insertVideo(video);
        expect(() => setChannelTopics(channelRowId("UC1"), [999 as TopicId])).toThrow(NotFoundError);
        expect(() => setChannelTopics(999 as never, [topic.id])).toThrow(NotFoundError);
        expect(() => setVideoTopics(video.youtubeId, [999 as TopicId])).toThrow(NotFoundError);
        expect(() => setVideoTopics(newVideo("UC1").youtubeId, [topic.id])).toThrow(NotFoundError);
    });

    test("deleting a topic removes its tags but not the channels or videos", () => {
        const topic = createTopic("Nature", "", "primary");
        insertChannel("UC1", "Chan");
        const video = newVideo("UC1");
        insertVideo(video);
        setChannelTopics(channelRowId("UC1"), [topic.id]);
        setVideoTopics(video.youtubeId, [topic.id]);
        deleteTopic(topic.id);
        expect(getChannelTopicIds().size).toBe(0);
        expect(getVideoTopicIds([video.youtubeId]).size).toBe(0);
        expect(idsOf(getWatchableVideosWithoutTopic(everything).videos)).toEqual([video.youtubeId]);
    });

    test("removing a video that is not kept deletes its tags", () => {
        const topic = createTopic("Nature", "", "primary");
        const video = newVideo("loose");
        allowVideo(video);
        setVideoTopics(video.youtubeId, [topic.id]);
        deleteVideo(video.youtubeId);
        expect(raw.query("SELECT COUNT(*) AS n FROM video_topics").get()).toEqual({ n: 0 });
    });
});

describe("videos under a topic", () => {
    test("a video is in the topics of its channel and its own", () => {
        const [nature, music] = [createTopic("Nature", "", "primary"), createTopic("Music", "", "primary")];
        insertChannel("UC1", "Chan");
        const fromChannel = newVideo("UC1");
        const own = newVideo("loose");
        const untagged = newVideo("loose");
        insertVideo(fromChannel);
        allowVideo(own);
        allowVideo(untagged);
        setChannelTopics(channelRowId("UC1"), [nature.id]);
        setVideoTopics(own.youtubeId, [nature.id, music.id]);

        expect(idsOf(getWatchableVideosInTopic(nature.id, everything).videos).sort()).toEqual(
            [fromChannel.youtubeId, own.youtubeId].sort(),
        );
        expect(idsOf(getWatchableVideosInTopic(music.id, everything).videos)).toEqual([own.youtubeId]);
        expect(idsOf(getWatchableVideosWithoutTopic(everything).videos)).toEqual([untagged.youtubeId]);
    });

    test("names a video's topics by slug: those of its channel plus any it was given itself", () => {
        const [nature, music] = [createTopic("Nature", "", "primary"), createTopic("Music", "", "primary")];
        insertChannel("UC1", "Chan");
        const channelOnly = newVideo("UC1");
        const channelAndOwn = newVideo("UC1");
        insertVideo(channelOnly);
        insertVideo(channelAndOwn);
        setChannelTopics(channelRowId("UC1"), [nature.id]);
        setVideoTopics(channelAndOwn.youtubeId, [music.id]);

        const slugs = getTopicSlugsOf([channelOnly.youtubeId, channelAndOwn.youtubeId]);

        expect(slugs.get(channelOnly.youtubeId)).toEqual([nature.slug]);
        expect(slugs.get(channelAndOwn.youtubeId)).toEqual([nature.slug, music.slug]);
    });

    test("a video with no topic has no slugs, and asking about no videos gives nothing", () => {
        createTopic("Nature", "", "primary");
        const untagged = newVideo("loose");
        allowVideo(untagged);

        expect(getTopicSlugsOf([untagged.youtubeId]).has(untagged.youtubeId)).toBe(false);
        expect(getTopicSlugsOf([]).size).toBe(0);
    });

    test("a blocked video is in no topic", () => {
        const topic = createTopic("Nature", "", "primary");
        insertChannel("UC1", "Chan");
        const video = newVideo("UC1");
        insertVideo(video);
        setChannelTopics(channelRowId("UC1"), [topic.id]);
        blockVideo(video.youtubeId);
        expect(getWatchableVideosInTopic(topic.id, everything).total).toBe(0);
        expect(getWatchableVideosWithoutTopic(everything).total).toBe(0);
    });

    test("a video in two topics is listed once in each", () => {
        const [a, b] = [createTopic("A", "", "primary"), createTopic("B", "", "primary")];
        const video = newVideo("loose");
        allowVideo(video);
        setVideoTopics(video.youtubeId, [a.id, b.id]);
        expect(getWatchableVideosInTopic(a.id, everything).total).toBe(1);
        expect(getWatchableVideosInTopic(b.id, everything).total).toBe(1);
    });

    test("shelves skip empty topics and limit each row, but count them all", () => {
        const [full, empty] = [createTopic("Full", "", "primary"), createTopic("Empty", "", "primary")];
        for (let count = 0; count < 3; count += 1) {
            const video = newVideo("loose");
            allowVideo(video);
            setVideoTopics(video.youtubeId, [full.id]);
        }
        allowVideo(newVideo("loose"));
        const { shelves, other } = getShelves(2);
        expect(shelves.map((shelf) => [shelf.topic.id, shelf.videos.length, shelf.total])).toEqual([[full.id, 2, 3]]);
        expect(shelves.some((shelf) => shelf.topic.id === empty.id)).toBe(false);
        expect(other.total).toBe(1);
    });
});
