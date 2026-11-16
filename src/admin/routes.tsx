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
import { type AuthEnv, changePassword, formFields, type MessageKind, redirectWithMessage } from "./auth-routes.tsx";
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
                messageKind={context.req.query("kind") ?? ""}
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
            return redirectWithMessage(context, "Enter a URL", "error");
        }
        const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(resolveTimeoutMs)]);
        const resolved = await resolveUrl(config.ytdlpBin, url, signal).then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, message: error.message }),
        );
        if (!resolved.ok) {
            return redirectWithMessage(context, `Could not read that URL: ${resolved.message}`, "error");
        }
        const { value } = resolved;
        if (!isVideo(value)) {
            const added = messageFrom(() => insertChannel(value.id, value.name));
            if (!added.ok) {
                return redirectWithMessage(context, added.message, "error");
            }
            void syncChannels(shutdown.signal);
            return redirectWithMessage(context, `Allowed channel ${value.name} (syncing videos…)`, "success");
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
        return allowed.ok
            ? redirectWithMessage(context, `Allowed video ${video.title}`, "success")
            : redirectWithMessage(context, allowed.message, "error");
    });

    routes.post("/channels/:id/remove", async (context) => {
        const id = parseChannelId(context.req.param("id"));
        if (id === undefined) {
            return context.notFound();
        }
        const removed = messageFrom(() => deleteChannel(id));
        if (!removed.ok) {
            return redirectWithMessage(context, removed.message, "error");
        }
        const failures = (await Promise.all(removed.value.map((path) => removeMedia(config.cacheDir, path)))).flat();
        return failures.length > 0
            ? redirectWithMessage(
                  context,
                  `Channel removed, but some cached files could not be deleted: ${failures.map((failure) => failure.message).join("; ")}`,
                  "warning",
              )
            : redirectWithMessage(context, "Channel removed. Pinned videos from it were kept.", "success");
    });

    routes.post("/sync", (context) => {
        void syncChannels(shutdown.signal);
        return redirectWithMessage(context, "Sync started", "success");
    });

    routes.post("/password", changePassword(services));

    routes.post("/videos/:id/:action", async (context) => {
        const id = parseVideoId(context.req.param("id"));
        if (id === undefined) {
            return context.notFound();
        }
        const outcome = await videoAction(context.req.param("action"), id);
        return outcome === "unknown-action"
            ? context.notFound()
            : redirectWithMessage(context, outcome.message, outcome.kind);
    });

    return routes;
}

type Notice = { message: string; kind: MessageKind };

type ActionOutcome = "unknown-action" | Notice;

/** "Done" when the change worked, and the reason it did not when it failed. */
function done(change: { ok: true } | { ok: false; message: string }): Notice {
    return change.ok ? { message: "Done", kind: "success" } : { message: change.message, kind: "error" };
}

/** The message when it worked, or a warning when some files could not be deleted afterwards. */
function withFileFailures(message: string, failures: Error[]): Notice {
    return failures.length > 0
        ? {
              message: `Done, but some files could not be deleted: ${failures.map((failure) => failure.message).join("; ")}`,
              kind: "warning",
          }
        : { message, kind: "success" };
}

async function videoAction(action: string, id: VideoId): Promise<ActionOutcome> {
    const { mediaDir, cacheDir } = config;
    switch (action) {
        case "pin":
        case "retry":
            return done(messageFrom(() => pinVideo(id)));
        case "unpin": {
            const unpinned = messageFrom(() => unpinVideo(id));
            return unpinned.ok ? withFileFailures("Done", await removeMedia(mediaDir, unpinned.value)) : done(unpinned);
        }
        case "block":
            return done(messageFrom(() => blockVideo(id)));
        case "unblock":
            return done(messageFrom(() => unblockVideo(id)));
        case "remove": {
            const removal = messageFrom(() => deleteVideo(id));
            if (!removal.ok) {
                return done(removal);
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
            return withFileFailures(message, failures);
        }
        default:
            return "unknown-action";
    }
}
