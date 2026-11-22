import { stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config } from "../shared/config.ts";
import { getWatchableChannels } from "../shared/db/channels.ts";
import { requestCache } from "../shared/db/queue.ts";
import {
    getShelves,
    getTopicBySlug,
    getTopics,
    getWatchableVideosInTopic,
    getWatchableVideosWithoutTopic,
} from "../shared/db/topics.ts";
import type { Video } from "../shared/db/types.ts";
import {
    getRecentlyWatched,
    getSavedVideos,
    getVideo,
    getWatchableVideos,
    markWatched,
    recordPlay,
} from "../shared/db/videos.ts";
import { logger } from "../shared/logger.ts";
import { downloadThumbnail, thumbnailDir } from "../shared/thumbnails.ts";
import { parseVideoId } from "../shared/ytdlp/info.ts";
import { kidPageSize, listLink, loadPage, paginate, requestedPage } from "../web/paging.ts";
import { serveFile } from "./files.ts";
import playerStyles from "./player.css" with { type: "file" };
import playerScript from "./player.js" with { type: "file" };
import { IndexPage, TopicPage, WatchPage } from "./views.tsx";

const hideWatchedCookie = "tubestop_hide_watched";

/** Where the "hide watched" button may send the child back to: a path on this site, with an optional query. */
const localPath = /^\/(?:[\w.~%-]+(?:\/[\w.~%-]+)*)?(?:\?[\w.~%&=+-]*)?$/;

const hidingWatched = (context: Context): boolean => getCookie(context, hideWatchedCookie) === "1";

const currentPath = (context: Context): string => {
    const url = new URL(context.req.url);
    return `${url.pathname}${url.search}`;
};

/** How many videos each row on the home page shows before "See all". */
const shelfSize = 8;

async function exists(path: string): Promise<boolean> {
    return stat(path).then(
        () => true,
        () => false,
    );
}

/** The local file to play for a video, preferring the pinned copy; empty when no file is ready. */
export async function playablePath(video: Video): Promise<string> {
    const candidates = [
        { status: video.downloadStatus, path: video.filePath },
        { status: video.cacheStatus, path: video.cachePath },
    ].filter((candidate) => candidate.status === "ready" && candidate.path !== "");
    const present = await Promise.all(
        candidates.map(async (candidate) => ((await exists(candidate.path)) ? candidate.path : "")),
    );
    return present.find((path) => path !== "") ?? "";
}

/** The picture saved next to a pinned download, or empty if there is none. */
async function pinnedThumbnail(video: Video): Promise<string> {
    if (video.downloadStatus !== "ready" || video.filePath === "") {
        return "";
    }
    const stem = video.filePath.slice(0, video.filePath.length - extname(video.filePath).length);
    const path = `${stem}.jpg`;
    return (await exists(path)) ? path : "";
}

/** The child-facing pages: browse, watch, and the endpoints the player script uses. */
export function userRoutes(): Hono {
    const routes = new Hono();

    /** The video for the `:id` path value, or null if it is unknown or hidden from the child. */
    const watchableVideo = (context: Context): Video | null => {
        const id = parseVideoId(context.req.param("id"));
        const video = id === undefined ? null : getVideo(id);
        return video?.watchable ? video : null;
    };

    const script = Bun.file(playerScript);
    routes.get("/player.js", () => new Response(script, { headers: { "Content-Type": script.type } }));
    const styles = Bun.file(playerStyles);
    routes.get("/player.css", () => new Response(styles, { headers: { "Content-Type": styles.type } }));

    routes.get("/", (context) => {
        const channel = context.req.query("channel") ?? "";
        const channels = getWatchableChannels();
        const hideWatched = hidingWatched(context);
        const here = currentPath(context);
        if (channel === "" && getTopics().length > 0) {
            return context.html(
                <IndexPage
                    videos={[]}
                    channels={channels}
                    current={channel}
                    pages={paginate(1, kidPageSize, 0, listLink("/", ""))}
                    hideWatched={hideWatched}
                    here={here}
                    shelves={{
                        ...getShelves(shelfSize, hideWatched),
                        recent: getRecentlyWatched({ limit: shelfSize, offset: 0 }),
                    }}
                />,
            );
        }
        const { videos, pages } = loadPage(
            (page) => getWatchableVideos(channel, page, hideWatched),
            requestedPage(context.req.query("page")),
            kidPageSize,
            listLink("/", channel),
        );
        return context.html(
            <IndexPage
                videos={videos}
                channels={channels}
                current={channel}
                pages={pages}
                hideWatched={hideWatched}
                here={here}
                recent={channel === "" ? getRecentlyWatched({ limit: shelfSize, offset: 0 }) : undefined}
            />,
        );
    });

    routes.post("/hide-watched", async (context) => {
        const body = await context.req.parseBody();
        const next = typeof body.next === "string" && localPath.test(body.next) ? body.next : "/";
        if (body.hide === "1") {
            setCookie(context, hideWatchedCookie, "1", {
                path: "/",
                httpOnly: true,
                sameSite: "Lax",
                maxAge: 365 * 24 * 60 * 60,
            });
        } else {
            deleteCookie(context, hideWatchedCookie, { path: "/" });
        }
        return context.redirect(next, 303);
    });

    routes.get("/topic/:slug", (context) => {
        const topic = getTopicBySlug(context.req.param("slug"));
        if (topic === null) {
            return context.notFound();
        }
        const hideWatched = hidingWatched(context);
        const { videos, pages } = loadPage(
            (page) => getWatchableVideosInTopic(topic.id, page, hideWatched),
            requestedPage(context.req.query("page")),
            kidPageSize,
            listLink(`/topic/${encodeURIComponent(topic.slug)}`, ""),
        );
        return context.html(
            <TopicPage
                heading={topic.name}
                emoji={topic.emoji}
                videos={videos}
                pages={pages}
                toggle={{ hidden: hideWatched, here: currentPath(context) }}
            />,
        );
    });

    routes.get("/other", (context) => {
        const hideWatched = hidingWatched(context);
        const { videos, pages } = loadPage(
            (page) => getWatchableVideosWithoutTopic(page, hideWatched),
            requestedPage(context.req.query("page")),
            kidPageSize,
            listLink("/other", ""),
        );
        return context.html(
            <TopicPage
                heading="More videos"
                emoji=""
                videos={videos}
                pages={pages}
                toggle={{ hidden: hideWatched, here: currentPath(context) }}
            />,
        );
    });

    routes.get("/watched", (context) => {
        const { videos, pages } = loadPage(
            getRecentlyWatched,
            requestedPage(context.req.query("page")),
            kidPageSize,
            listLink("/watched", ""),
        );
        return context.html(<TopicPage heading="Recently watched" emoji="✓" videos={videos} pages={pages} />);
    });

    // Opening a page only reads state: the page's script asks for the video to be prepared and reports plays.
    routes.get("/watch/:id", async (context) => {
        const video = watchableVideo(context);
        return video === null
            ? context.notFound()
            : context.html(<WatchPage video={video} ready={(await playablePath(video)) !== ""} />);
    });

    // Queues a watch-once download for a video that has no playable file yet. Also how a failed download is retried.
    routes.post("/api/videos/:id/prepare", async (context) => {
        const video = watchableVideo(context);
        if (video === null) {
            return context.notFound();
        }
        if ((await playablePath(video)) === "") {
            requestCache(video.youtubeId);
        }
        return context.body(null, 202);
    });

    routes.post("/api/videos/:id/played", (context) => {
        const video = watchableVideo(context);
        if (video === null) {
            return context.notFound();
        }
        recordPlay(video.youtubeId);
        return context.body(null, 204);
    });

    routes.post("/api/videos/:id/watched", (context) => {
        const video = watchableVideo(context);
        if (video === null) {
            return context.notFound();
        }
        markWatched(video.youtubeId);
        return context.body(null, 204);
    });

    // The pinned videos a device may keep for use without a connection, and how much room it may give them.
    routes.get("/api/offline", async (context) => {
        const sizes = await Promise.all(
            getSavedVideos().map(async (video) => ({
                id: video.youtubeId,
                size: (await stat(video.filePath).catch(() => undefined))?.size ?? 0,
            })),
        );
        return context.json(
            { maxBytes: config.offlineMaxBytes, videos: sizes.filter((entry) => entry.size > 0) },
            200,
            { "Cache-Control": "no-store" },
        );
    });

    routes.get("/status/:id", async (context) => {
        const video = watchableVideo(context);
        return video === null
            ? context.notFound()
            : context.json({ ready: (await playablePath(video)) !== "", failed: video.cacheStatus === "failed" });
    });

    routes.get("/video/:id", async (context) => {
        const video = watchableVideo(context);
        if (video === null) {
            return context.notFound();
        }
        const path = await playablePath(video);
        return path === "" ? context.text("not ready", 503) : serveFile(context.req.raw, path);
    });

    // The pinned download's own picture if it has one, otherwise a copy that is fetched from YouTube the first time it is wanted.
    routes.get("/thumb/:id", async (context) => {
        const video = watchableVideo(context);
        if (video === null) {
            return context.notFound();
        }
        try {
            const path = (await pinnedThumbnail(video)) || join(thumbnailDir, `${video.youtubeId}.jpg`);
            if (!(await exists(path))) {
                await downloadThumbnail(video.youtubeId, context.req.raw.signal);
            }
            return serveFile(context.req.raw, path, { "Cache-Control": "public, max-age=86400" });
        } catch (error) {
            logger.error(`web: thumbnail of ${video.youtubeId}: ${error.message}`);
            return context.text("thumbnail unavailable", 502);
        }
    });

    return routes;
}
