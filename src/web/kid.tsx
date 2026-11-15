import { stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Context } from "hono";
import { Hono } from "hono";
import type { Video } from "../db/store.ts";
import { getVideo, getWatchableChannels, getWatchableVideos, recordPlay, requestCache } from "../db/store.ts";
import { downloadThumbnail } from "../thumbnails.ts";
import { parseVideoId } from "../ytdlp/info.ts";
import { serveFile } from "./files.ts";
import { kidPageSize, listLink, loadPage, requestedPage } from "./paging.ts";
import type { Services } from "./services.ts";
import { IndexPage, WatchPage } from "./views.tsx";

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

const staticDirectory = join(import.meta.dir, "static");

/** The child-facing pages: browse, watch, and the endpoints the player script uses. */
export function kidRoutes(services: Services): Hono {
    const { store } = services;
    const routes = new Hono();

    /** The video for the `:id` path value, or null if it is unknown or hidden from the child. */
    const watchableVideo = (context: Context): Video | null => {
        const id = parseVideoId(context.req.param("id"));
        const video = id === undefined ? null : getVideo(store, id);
        return video?.watchable ? video : null;
    };

    routes.get("/static/*", (context) => {
        const name = context.req.path.slice("/static/".length);
        return name === "" || name !== basename(name) || name.startsWith(".")
            ? context.notFound()
            : serveFile(context.req.raw, join(staticDirectory, name));
    });

    routes.get("/", (context) => {
        const channel = context.req.query("channel") ?? "";
        const { videos, pages } = loadPage(
            (page) => getWatchableVideos(store, channel, page),
            requestedPage(context.req.query("page")),
            kidPageSize,
            listLink("/", channel),
        );
        return context.html(
            <IndexPage videos={videos} channels={getWatchableChannels(store)} current={channel} pages={pages} />,
        );
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
            requestCache(store, video.youtubeId);
        }
        return context.body(null, 202);
    });

    routes.post("/api/videos/:id/played", (context) => {
        const video = watchableVideo(context);
        if (video === null) {
            return context.notFound();
        }
        recordPlay(store, video.youtubeId);
        return context.body(null, 204);
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
            const path = (await pinnedThumbnail(video)) || join(services.thumbnailDir, `${video.youtubeId}.jpg`);
            if (!(await exists(path))) {
                await downloadThumbnail(services.thumbnailDir, video.youtubeId, context.req.raw.signal);
            }
            return serveFile(context.req.raw, path, { "Cache-Control": "public, max-age=86400" });
        } catch (error) {
            services.log(`web: thumbnail of ${video.youtubeId}: ${error.message}`);
            return context.text("thumbnail unavailable", 502);
        }
    });

    return routes;
}
