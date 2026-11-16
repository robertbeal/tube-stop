import type { VideoId } from "../ytdlp/types.ts";
import { database } from "./database.ts";
import {
    type ChannelId,
    NotFoundError,
    type Page,
    type Shelf,
    type Topic,
    type TopicId,
    type VideoPage,
} from "./types.ts";
import { queryPage, watchableExpression } from "./videos.ts";

type TopicRow = { id: number; slug: string; name: string; emoji: string; color: string };

export const topicColors = ["primary", "success", "info", "warning", "danger", "secondary"] as const;

/** Slugs the child's pages use for something else. */
const reservedSlugs = new Set(["other"]);

export class TopicRuleError extends Error {}

function toTopic(row: TopicRow): Topic {
    return { id: row.id as TopicId, slug: row.slug, name: row.name, emoji: row.emoji, color: row.color };
}

/** The one way to make a `TopicId` from text: anything that is not a whole number gives undefined. */
export function parseTopicId(value: string | undefined): TopicId | undefined {
    return value !== undefined && /^\d+$/.test(value) ? (Number(value) as TopicId) : undefined;
}

/** Topics in the order the admin arranged them. */
export function getTopics(): Topic[] {
    return database
        .query<TopicRow, []>("SELECT id, slug, name, emoji, color FROM topics ORDER BY position, id")
        .all()
        .map(toTopic);
}

export function getTopicBySlug(slug: string): Topic | null {
    const row = database
        .query<TopicRow, [string]>("SELECT id, slug, name, emoji, color FROM topics WHERE slug = ?")
        .get(slug);
    return row === null ? null : toTopic(row);
}

function slugify(name: string): string {
    return name
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function checkedDetails(name: string, emoji: string, color: string): { name: string; emoji: string; color: string } {
    const trimmed = name.trim();
    if (trimmed === "") {
        throw new TopicRuleError("A topic needs a name");
    }
    if (trimmed.length > 40) {
        throw new TopicRuleError("A topic name can be at most 40 characters");
    }
    return {
        name: trimmed,
        emoji: emoji.trim().slice(0, 8),
        color: (topicColors as readonly string[]).includes(color) ? color : "primary",
    };
}

/** An unused slug for a name: the name itself, or with a number added when it is taken. */
function freeSlug(name: string, ignoring: number): string {
    const base = slugify(name) || "topic";
    for (let attempt = 1; ; attempt += 1) {
        const slug = attempt === 1 ? base : `${base}-${attempt}`;
        const taken =
            reservedSlugs.has(slug) ||
            database.query("SELECT 1 FROM topics WHERE slug = ? AND id != ?").get(slug, ignoring) !== null;
        if (!taken) {
            return slug;
        }
    }
}

/** Adds a topic after the others. */
export function createTopic(name: string, emoji: string, color: string): Topic {
    const details = checkedDetails(name, emoji, color);
    return database
        .transaction(() => {
            const slug = freeSlug(details.name, 0);
            const row = database
                .query<TopicRow, [string, string, string, string]>(
                    `INSERT INTO topics (slug, name, emoji, color, position)
           VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM topics))
           RETURNING id, slug, name, emoji, color`,
                )
                .get(slug, details.name, details.emoji, details.color);
            if (row === null) {
                throw new Error("could not add the topic");
            }
            return toTopic(row);
        })
        .immediate();
}

/** Changes how a topic looks. Its address stays the same so that bookmarks keep working. */
export function updateTopic(id: TopicId, name: string, emoji: string, color: string): void {
    const details = checkedDetails(name, emoji, color);
    const changes = database.run("UPDATE topics SET name = ?, emoji = ?, color = ? WHERE id = ?", [
        details.name,
        details.emoji,
        details.color,
        id,
    ]).changes;
    if (changes === 0) {
        throw new NotFoundError();
    }
}

/** Removes a topic, and with it every tag using it. The channels and videos stay. */
export function deleteTopic(id: TopicId): void {
    if (database.run("DELETE FROM topics WHERE id = ?", [id]).changes === 0) {
        throw new NotFoundError();
    }
}

/** Swaps a topic with its neighbour in the list. Moving the first up or the last down does nothing. */
export function moveTopic(id: TopicId, direction: "up" | "down"): void {
    database
        .transaction(() => {
            const ids = getTopics().map((topic) => topic.id);
            const index = ids.indexOf(id);
            if (index === -1) {
                throw new NotFoundError();
            }
            const other = direction === "up" ? index - 1 : index + 1;
            if (other < 0 || other >= ids.length) {
                return;
            }
            [ids[index], ids[other]] = [ids[other] as TopicId, ids[index] as TopicId];
            ids.forEach((topicId, position) => {
                database.run("UPDATE topics SET position = ? WHERE id = ?", [position + 1, topicId]);
            });
        })
        .immediate();
}

function checkTopicsExist(topicIds: readonly TopicId[]): void {
    for (const topicId of topicIds) {
        if (database.query("SELECT 1 FROM topics WHERE id = ?").get(topicId) === null) {
            throw new NotFoundError();
        }
    }
}

/** Makes `topicIds` the channel's topics, replacing the ones it had. */
export function setChannelTopics(channelId: ChannelId, topicIds: readonly TopicId[]): void {
    database
        .transaction(() => {
            if (database.query("SELECT 1 FROM channels WHERE id = ?").get(channelId) === null) {
                throw new NotFoundError();
            }
            checkTopicsExist(topicIds);
            database.run("DELETE FROM channel_topics WHERE channel_id = ?", [channelId]);
            for (const topicId of new Set(topicIds)) {
                database.run("INSERT INTO channel_topics (channel_id, topic_id) VALUES (?, ?)", [channelId, topicId]);
            }
        })
        .immediate();
}

/** Makes `topicIds` the video's own topics, replacing the ones it had. Topics from its channel are separate. */
export function setVideoTopics(youtubeId: VideoId, topicIds: readonly TopicId[]): void {
    database
        .transaction(() => {
            if (database.query("SELECT 1 FROM videos WHERE youtube_id = ?").get(youtubeId) === null) {
                throw new NotFoundError();
            }
            checkTopicsExist(topicIds);
            database.run("DELETE FROM video_topics WHERE video_youtube_id = ?", [youtubeId]);
            for (const topicId of new Set(topicIds)) {
                database.run("INSERT INTO video_topics (video_youtube_id, topic_id) VALUES (?, ?)", [
                    youtubeId,
                    topicId,
                ]);
            }
        })
        .immediate();
}

/** The topics of every tagged channel, by channel. */
export function getChannelTopicIds(): Map<ChannelId, TopicId[]> {
    const topicsOf = new Map<ChannelId, TopicId[]>();
    for (const row of database
        .query<{ channel_id: number; topic_id: number }, []>("SELECT channel_id, topic_id FROM channel_topics")
        .all()) {
        const id = row.channel_id as ChannelId;
        topicsOf.set(id, [...(topicsOf.get(id) ?? []), row.topic_id as TopicId]);
    }
    return topicsOf;
}

/** The video's own topics (not those from its channel) for each of the given videos. */
export function getVideoTopicIds(youtubeIds: readonly VideoId[]): Map<VideoId, TopicId[]> {
    const wanted = new Set<string>(youtubeIds);
    const topicsOf = new Map<VideoId, TopicId[]>();
    for (const row of database
        .query<{ video_youtube_id: VideoId; topic_id: number }, []>(
            "SELECT video_youtube_id, topic_id FROM video_topics",
        )
        .all()) {
        if (wanted.has(row.video_youtube_id)) {
            topicsOf.set(row.video_youtube_id, [
                ...(topicsOf.get(row.video_youtube_id) ?? []),
                row.topic_id as TopicId,
            ]);
        }
    }
    return topicsOf;
}

/** True for a video with the topic itself or through its channel. */
const inTopic = `(EXISTS (SELECT 1 FROM video_topics vt WHERE vt.video_youtube_id = v.youtube_id AND vt.topic_id = ?)
  OR EXISTS (SELECT 1 FROM channel_topics ct JOIN channels tc ON tc.id = ct.channel_id
       WHERE tc.youtube_id = v.channel_yt_id AND ct.topic_id = ?))`;

const hasNoTopic = `(NOT EXISTS (SELECT 1 FROM video_topics vt WHERE vt.video_youtube_id = v.youtube_id)
  AND NOT EXISTS (SELECT 1 FROM channel_topics ct JOIN channels tc ON tc.id = ct.channel_id
       WHERE tc.youtube_id = v.channel_yt_id))`;

/** One page of the videos the child may watch under a topic, newest published first. */
export function getWatchableVideosInTopic(topicId: TopicId, page: Page): VideoPage {
    return queryPage(`${watchableExpression} AND ${inTopic}`, [topicId, topicId], page);
}

/** One page of the videos the child may watch that have no topic. */
export function getWatchableVideosWithoutTopic(page: Page): VideoPage {
    return queryPage(`${watchableExpression} AND ${hasNoTopic}`, [], page);
}

/** The newest videos of each topic that has any, in topic order, and separately the videos with no topic. */
export function getShelves(perShelf: number): { shelves: Shelf[]; other: VideoPage } {
    const page = { limit: perShelf, offset: 0 };
    const shelves = getTopics()
        .map((topic) => ({ topic, ...getWatchableVideosInTopic(topic.id, page) }))
        .filter((shelf) => shelf.total > 0);
    return { shelves, other: getWatchableVideosWithoutTopic(page) };
}
