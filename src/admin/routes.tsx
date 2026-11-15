import { Hono } from "hono";
import { config } from "../shared/config.ts";
import { deleteChannel, getChannels, insertChannel, parseChannelId } from "../shared/db/channels.ts";
import { pinVideo, unpinVideo } from "../shared/db/queue.ts";
import { allowVideo, blockVideo, deleteVideo, getAdminVideos, unblockVideo } from "../shared/db/videos.ts";
import { shutdown } from "../shared/shutdown.ts";
import { directorySize, removeMedia } from "../shared/storage.ts";
import { removeThumbnail } from "../shared/thumbnails.ts";
import { parseVideoId } from "../shared/ytdlp/info.ts";
import { resolveUrl } from "../shared/ytdlp/resolve.ts";
import type { VideoId } from "../shared/ytdlp/types.ts";
import { isVideo } from "../shared/ytdlp/types.ts";
import { syncChannels } from "../sync/sync.ts";
import { adminPageSize, listLink, loadPage, requestedPage } from "../web/paging.ts";
import type { Services } from "../web/services.ts";
import { type AuthEnv, changePassword, formFields, redirectWithMessage } from "./auth-routes.tsx";
import { AdminPage } from "./views.tsx";

const resolveTimeoutMs = 90 * 1000;

/** Runs a database change; a missing row or other failure becomes the message to show the admin. */
function messageFrom<Result>(change: () => Result): { ok: true; value: Result } | { ok: false; message: string } {
    try {
        return { ok: true, value: change() };
    } catch (error) {
        return { ok: false, message: error.message };
    }
}

/** The password-protected admin pages. Mount them behind the login middleware. */
export function adminRoutes(services: Services): Hono<AuthEnv> {
    const routes = new Hono<AuthEnv>();

    routes.get("/", async (context) => {
        const channel = context.req.query("channel") ?? "";
        const { videos, pages } = loadPage(
            (page) => getAdminVideos(channel, page),
            requestedPage(context.req.query("page")),
            adminPageSize,
            listLink("/admin", channel),
        );
        const [mediaBytes, cacheBytes] = await Promise.all([
            directorySize(config.mediaDir),
            directorySize(config.cacheDir),
        ]);
        return context.html(
            <AdminPage
                username={context.get("user").username}
                message={context.req.query("msg") ?? ""}
                channels={getChannels()}
                videos={videos}
                current={channel}
                pages={pages}
                mediaBytes={mediaBytes}
                cacheBytes={cacheBytes}
            />,
        );
    });

    routes.post("/add", async (context) => {
        const url = (await formFields(context))("url");
        if (url === "") {
            return redirectWithMessage(context, "Enter a URL");
        }
        const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(resolveTimeoutMs)]);
        const resolved = await resolveUrl(config.ytdlpBin, url, signal).then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, message: error.message }),
        );
        if (!resolved.ok) {
            return redirectWithMessage(context, `Could not read that URL: ${resolved.message}`);
        }
        const { value } = resolved;
        if (!isVideo(value)) {
            const added = messageFrom(() => insertChannel(value.id, value.name));
            if (!added.ok) {
                return redirectWithMessage(context, added.message);
            }
            void syncChannels(shutdown.signal);
            return redirectWithMessage(context, `Allowed channel ${value.name} (syncing videos…)`);
        }
        const video = value;
        const allowed = messageFrom(() =>
            allowVideo({
                youtubeId: video.id,
                channelYoutubeId: video.channel.id,
                channelName: video.channel.name,
                title: video.title,
                duration: video.duration,
                publishedAt: video.publishedAt,
            }),
        );
        return redirectWithMessage(context, allowed.ok ? `Allowed video ${video.title}` : allowed.message);
    });

    routes.post("/channels/:id/remove", async (context) => {
        const id = parseChannelId(context.req.param("id"));
        if (id === undefined) {
            return context.notFound();
        }
        const removed = messageFrom(() => deleteChannel(id));
        if (!removed.ok) {
            return redirectWithMessage(context, removed.message);
        }
        const failures = (await Promise.all(removed.value.map((path) => removeMedia(config.cacheDir, path)))).flat();
        return redirectWithMessage(
            context,
            failures.length > 0
                ? `Channel removed, but some cached files could not be deleted: ${failures.map((failure) => failure.message).join("; ")}`
                : "Channel removed. Pinned videos from it were kept.",
        );
    });

    routes.post("/sync", (context) => {
        void syncChannels(shutdown.signal);
        return redirectWithMessage(context, "Sync started");
    });

    routes.post("/password", changePassword(services));

    routes.post("/videos/:id/:action", async (context) => {
        const id = parseVideoId(context.req.param("id"));
        if (id === undefined) {
            return context.notFound();
        }
        const outcome = await videoAction(context.req.param("action"), id);
        return outcome === "unknown-action" ? context.notFound() : redirectWithMessage(context, outcome.message);
    });

    return routes;
}

type ActionOutcome = "unknown-action" | { message: string };

function withFileFailures(message: string, failures: Error[]): string {
    return failures.length > 0
        ? `Done, but some files could not be deleted: ${failures.map((failure) => failure.message).join("; ")}`
        : message;
}

async function videoAction(action: string, id: VideoId): Promise<ActionOutcome> {
    const { mediaDir, cacheDir } = config;
    switch (action) {
        case "pin":
        case "retry": {
            const pinned = messageFrom(() => pinVideo(id));
            return { message: pinned.ok ? "Done" : pinned.message };
        }
        case "unpin": {
            const unpinned = messageFrom(() => unpinVideo(id));
            return {
                message: unpinned.ok
                    ? withFileFailures("Done", await removeMedia(mediaDir, unpinned.value))
                    : unpinned.message,
            };
        }
        case "block": {
            const blocked = messageFrom(() => blockVideo(id));
            return { message: blocked.ok ? "Done" : blocked.message };
        }
        case "unblock": {
            const unblocked = messageFrom(() => unblockVideo(id));
            return { message: unblocked.ok ? "Done" : unblocked.message };
        }
        case "remove": {
            const removal = messageFrom(() => deleteVideo(id));
            if (!removal.ok) {
                return { message: removal.message };
            }
            const { filePath, cachePath, blocked } = removal.value;
            const failures = [
                ...(await removeMedia(mediaDir, filePath)),
                ...(await removeMedia(cacheDir, cachePath)),
                ...(blocked
                    ? []
                    : await removeThumbnail(id).then(
                          () => [],
                          (error) => [error],
                      )),
            ];
            const message = blocked
                ? "Removed. It stays blocked so syncing the channel cannot bring it back."
                : "Removed";
            return { message: withFileFailures(message, failures) };
        }
        default:
            return "unknown-action";
    }
}
