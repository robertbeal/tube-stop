import { Hono } from "hono";
import { directorySize, removeMedia } from "../storage.ts";
import { type AuthEnv, changePassword, formFields, redirectWithMessage } from "./auth-routes.tsx";
import { adminPageSize, listLink, loadPage, requestedPage } from "./paging.ts";
import type { Services } from "./services.ts";
import { AdminPage } from "./views.tsx";

const resolveTimeoutMs = 90 * 1000;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs a store change; a missing row or other failure becomes the message to show the admin. */
function messageFrom<Result>(
  change: () => Result,
): { ok: true; value: Result } | { ok: false; message: string } {
  try {
    return { ok: true, value: change() };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/** The password-protected admin pages. Mount them behind the login middleware. */
export function adminRoutes(services: Services): Hono<AuthEnv> {
  const { store } = services;
  const routes = new Hono<AuthEnv>();

  routes.get("/", async (context) => {
    const channel = context.req.query("channel") ?? "";
    const { videos, pages } = loadPage(
      (page) => store.adminVideos(channel, page),
      requestedPage(context.req.query("page")),
      adminPageSize,
      listLink("/admin", channel),
    );
    const [mediaBytes, cacheBytes] = await Promise.all([
      directorySize(services.mediaDir),
      directorySize(services.cacheDir),
    ]);
    return context.html(
      <AdminPage
        username={context.get("user").username}
        message={context.req.query("msg") ?? ""}
        channels={store.channels()}
        videos={videos}
        current={channel}
        pages={pages}
        mediaBytes={mediaBytes}
        cacheBytes={cacheBytes}
        nowMs={services.now()}
      />,
    );
  });

  routes.post("/add", async (context) => {
    const url = (await formFields(context))("url");
    if (url === "") {
      return redirectWithMessage(context, "Enter a URL");
    }
    const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(resolveTimeoutMs)]);
    const resolved = await services.resolver.resolve(url, signal).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, message: describe(error) }),
    );
    if (!resolved.ok) {
      return redirectWithMessage(context, `Could not read that URL: ${resolved.message}`);
    }
    if (resolved.value.kind === "channel") {
      const { channelId, channelName } = resolved.value;
      const added = messageFrom(() => store.addChannel(channelId, channelName));
      if (!added.ok) {
        return redirectWithMessage(context, added.message);
      }
      services.syncer.trigger();
      return redirectWithMessage(context, `Allowed channel ${channelName} (syncing videos…)`);
    }
    const { video } = resolved.value;
    const allowed = messageFrom(() =>
      store.allowVideo({
        youtubeId: video.id,
        channelYoutubeId: video.channelId,
        channelName: video.channelName,
        title: video.title,
        duration: video.duration,
        publishedAt: video.publishedAt,
      }),
    );
    return redirectWithMessage(context, allowed.ok ? `Allowed video ${video.title}` : allowed.message);
  });

  routes.post("/channels/:id/remove", async (context) => {
    const id = /^\d+$/.test(context.req.param("id")) ? Number(context.req.param("id")) : undefined;
    if (id === undefined) {
      return context.notFound();
    }
    const removed = messageFrom(() => store.removeChannel(id));
    if (!removed.ok) {
      return redirectWithMessage(context, removed.message);
    }
    const failures = (
      await Promise.all(removed.value.map((path) => removeMedia(services.cacheDir, path)))
    ).flat();
    return redirectWithMessage(
      context,
      failures.length > 0
        ? `Channel removed, but some cached files could not be deleted: ${failures.map(describe).join("; ")}`
        : "Channel removed. Pinned videos from it were kept.",
    );
  });

  routes.post("/sync", (context) => {
    services.syncer.trigger();
    return redirectWithMessage(context, "Sync started");
  });

  routes.post("/password", changePassword(services));

  routes.post("/videos/:id/:action", async (context) => {
    const id = context.req.param("id");
    const outcome = await videoAction(services, context.req.param("action"), id);
    return outcome === "unknown-action" ? context.notFound() : redirectWithMessage(context, outcome.message);
  });

  return routes;
}

type ActionOutcome = "unknown-action" | { message: string };

function withFileFailures(message: string, failures: Error[]): string {
  return failures.length > 0
    ? `Done, but some files could not be deleted: ${failures.map(describe).join("; ")}`
    : message;
}

async function videoAction(services: Services, action: string, id: string): Promise<ActionOutcome> {
  const { store, mediaDir, cacheDir } = services;
  switch (action) {
    case "pin":
    case "retry": {
      const pinned = messageFrom(() => store.pin(id));
      if (pinned.ok) {
        services.downloads.triggerPins();
      }
      return { message: pinned.ok ? "Done" : pinned.message };
    }
    case "unpin": {
      const unpinned = messageFrom(() => store.unpin(id));
      return {
        message: unpinned.ok
          ? withFileFailures("Done", await removeMedia(mediaDir, unpinned.value))
          : unpinned.message,
      };
    }
    case "block": {
      const blocked = messageFrom(() => store.block(id));
      return { message: blocked.ok ? "Done" : blocked.message };
    }
    case "unblock": {
      const unblocked = messageFrom(() => store.unblock(id));
      return { message: unblocked.ok ? "Done" : unblocked.message };
    }
    case "remove": {
      const removal = messageFrom(() => store.removeVideo(id));
      if (!removal.ok) {
        return { message: removal.message };
      }
      const { filePath, cachePath, blocked } = removal.value;
      const failures = [
        ...(await removeMedia(mediaDir, filePath)),
        ...(await removeMedia(cacheDir, cachePath)),
        ...(blocked
          ? []
          : await services.thumbnails.remove(id).then(
              () => [],
              (error: unknown) => [error instanceof Error ? error : new Error(String(error))],
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
