import type { FC } from "hono/jsx";
import type { Channel, Video } from "../shared/db/types.ts";
import { humanBytes, timeAgo } from "../web/format.ts";
import { Layout } from "../web/layout.tsx";
import type { Pagination } from "../web/paging.ts";

export type AdminProps = {
    username: string;
    message: string;
    /** How the message is shown: "success", "warning" or "error". Anything else is shown neutrally. */
    messageKind: string;
    channels: Channel[];
    videos: Video[];
    current: string;
    pages: Pagination;
    mediaBytes: number;
    cacheBytes: number;
};

const messageStyles: Record<string, { alertClass: string; role: string }> = {
    success: { alertClass: "alert-success", role: "status" },
    warning: { alertClass: "alert-warning", role: "status" },
    error: { alertClass: "alert-danger", role: "alert" },
};

const PostButton: FC<{
    action: string;
    buttonClass: string;
    inline?: boolean;
    label: string;
    busyLabel: string;
}> = ({ action, buttonClass, inline = true, label, busyLabel }) => (
    <form class={inline ? "d-inline" : undefined} method="post" action={action}>
        <button type="submit" class={`btn ${buttonClass} btn-sm`} data-busy-label={busyLabel}>
            {label}
        </button>
    </form>
);

const VideoStatus: FC<{ video: Video }> = ({ video }) => (
    <>
        {video.rule === "block" ? (
            <span class="badge text-bg-danger">blocked</span>
        ) : video.watchable ? (
            <span class="badge text-bg-success">watchable</span>
        ) : (
            <span class="badge text-bg-secondary">hidden</span>
        )}{" "}
        {video.pinned && <span class="badge text-bg-info">pinned ({video.downloadStatus})</span>}
        {video.downloadError !== "" && <div class="small text-danger mt-1">{video.downloadError}</div>}
    </>
);

const VideoActions: FC<{ video: Video }> = ({ video }) => {
    const base = `/admin/videos/${encodeURIComponent(video.youtubeId)}`;
    return (
        <td class="text-end text-nowrap">
            {video.pinned ? (
                <>
                    <PostButton
                        action={`${base}/unpin`}
                        buttonClass="btn-outline-secondary"
                        label="Unpin"
                        busyLabel="Unpinning…"
                    />{" "}
                    {video.downloadStatus === "failed" && (
                        <PostButton
                            action={`${base}/retry`}
                            buttonClass="btn-outline-primary"
                            label="Retry"
                            busyLabel="Retrying…"
                        />
                    )}
                </>
            ) : (
                <PostButton action={`${base}/pin`} buttonClass="btn-outline-primary" label="Pin" busyLabel="Pinning…" />
            )}{" "}
            {video.rule === "block" ? (
                <PostButton
                    action={`${base}/unblock`}
                    buttonClass="btn-outline-success"
                    label="Unblock"
                    busyLabel="Unblocking…"
                />
            ) : (
                <PostButton
                    action={`${base}/block`}
                    buttonClass="btn-outline-warning"
                    label="Block"
                    busyLabel="Blocking…"
                />
            )}{" "}
            <PostButton
                action={`${base}/remove`}
                buttonClass="btn-outline-danger"
                label={video.channelAllowed ? "Remove (stays hidden)" : "Remove"}
                busyLabel="Removing…"
            />
        </td>
    );
};

export const AdminPage: FC<AdminProps> = (props) => (
    <Layout
        title="Admin · Tube Stop"
        navbar={
            <form class="d-flex align-items-center gap-2" method="post" action="/admin/logout">
                <span class="navbar-text">
                    Logged in as <strong>{props.username}</strong>
                </span>
                <button type="submit" class="btn btn-outline-secondary btn-sm" data-busy-label="Logging out…">
                    Log out
                </button>
            </form>
        }
    >
        <h1 class="h3 mb-3">Admin</h1>
        {props.message !== "" && (
            <div
                class={`alert ${messageStyles[props.messageKind]?.alertClass ?? "alert-info"}`}
                role={messageStyles[props.messageKind]?.role ?? "status"}
            >
                {props.message}
            </div>
        )}
        <p class="text-body-secondary">
            Pinned downloads: <strong>{humanBytes(props.mediaBytes)}</strong> · Watch-once cache:{" "}
            <strong>{humanBytes(props.cacheBytes)}</strong>
        </p>

        <form method="post" action="/admin/add" class="input-group mb-4">
            <input
                class="form-control"
                name="url"
                placeholder="Paste a YouTube channel or video URL"
                aria-label="YouTube channel or video URL"
                required
            />
            <button type="submit" class="btn btn-primary" data-busy-label="Adding…">
                Add
            </button>
        </form>

        <details class="card card-body mb-4">
            <summary class="fw-semibold">Change password</summary>
            <form method="post" action="/admin/password" class="password-form mt-3">
                <div class="mb-3">
                    <label class="form-label" for="current">
                        Current password
                    </label>
                    <input
                        class="form-control"
                        id="current"
                        type="password"
                        name="current"
                        autocomplete="current-password"
                        required
                    />
                </div>
                <div class="mb-3">
                    <label class="form-label" for="new">
                        New password
                    </label>
                    <input
                        class="form-control"
                        id="new"
                        type="password"
                        name="new"
                        autocomplete="new-password"
                        minlength={8}
                        maxlength={72}
                        aria-describedby="new-help"
                        required
                    />
                    <div id="new-help" class="form-text">
                        At least 8 characters.
                    </div>
                </div>
                <div class="mb-3">
                    <label class="form-label" for="confirm">
                        Confirm new password
                    </label>
                    <input
                        class="form-control"
                        id="confirm"
                        type="password"
                        name="confirm"
                        autocomplete="new-password"
                        minlength={8}
                        maxlength={72}
                        required
                    />
                </div>
                <button type="submit" class="btn btn-primary" data-busy-label="Changing…">
                    Change password
                </button>
            </form>
        </details>

        <div class="d-flex justify-content-between align-items-center mb-2">
            <h2 class="h5 mb-0">Allowed channels</h2>
            <form method="post" action="/admin/sync">
                <button type="submit" class="btn btn-outline-primary btn-sm" data-busy-label="Starting sync…">
                    Sync all now
                </button>
            </form>
        </div>
        <div class="table-responsive mb-4">
            <table class="table table-hover align-middle">
                <thead>
                    <tr>
                        <th>Channel</th>
                        <th>Videos</th>
                        <th>Last sync</th>
                        <th />
                    </tr>
                </thead>
                <tbody>
                    {props.channels.length === 0 ? (
                        <tr>
                            <td colspan={4} class="text-body-secondary">
                                No channels yet.
                            </td>
                        </tr>
                    ) : (
                        props.channels.map((channel) => (
                            <tr>
                                <td>
                                    <a href={`/admin?channel=${encodeURIComponent(channel.youtubeId)}`}>
                                        {channel.name}
                                    </a>
                                </td>
                                <td>{channel.videoCount}</td>
                                <td>{timeAgo(channel.lastSyncedAt)}</td>
                                <td class="text-end">
                                    <PostButton
                                        action={`/admin/channels/${channel.id}/remove`}
                                        buttonClass="btn-outline-danger"
                                        inline={false}
                                        label="Remove"
                                        busyLabel="Removing…"
                                    />
                                </td>
                            </tr>
                        ))
                    )}
                </tbody>
            </table>
        </div>

        <h2 class="h5">
            Videos{" "}
            <small class="text-body-secondary">
                {props.current === "" ? (
                    "(individual, blocked, pinned)"
                ) : (
                    <>
                        (channel filter · <a href="/admin">clear</a>)
                    </>
                )}
            </small>
        </h2>
        <div class="table-responsive">
            <table class="table table-hover align-middle">
                <thead>
                    <tr>
                        <th>Title</th>
                        <th>Channel</th>
                        <th>Status</th>
                        <th>Plays</th>
                        <th />
                    </tr>
                </thead>
                <tbody>
                    {props.videos.length === 0 ? (
                        <tr>
                            <td colspan={5} class="text-body-secondary">
                                Nothing to show.
                            </td>
                        </tr>
                    ) : (
                        props.videos.map((video) => (
                            <tr>
                                <td>
                                    <a href={`/watch/${encodeURIComponent(video.youtubeId)}`}>{video.title}</a>
                                </td>
                                <td>{video.channelName}</td>
                                <td>
                                    <VideoStatus video={video} />
                                </td>
                                <td>{video.playCount}</td>
                                <VideoActions video={video} />
                            </tr>
                        ))
                    )}
                </tbody>
            </table>
        </div>
        {props.pages.total > 0 && (
            <nav class="d-flex align-items-center flex-wrap gap-3 my-3" aria-label="Pages">
                <span class="text-body-secondary">
                    Showing {props.pages.from}–{props.pages.to} of {props.pages.total}
                </span>
                {props.pages.previousUrl !== "" && (
                    <a class="btn btn-outline-secondary btn-sm" href={props.pages.previousUrl}>
                        ← Previous
                    </a>
                )}
                {props.pages.nextUrl !== "" && (
                    <a class="btn btn-outline-secondary btn-sm" href={props.pages.nextUrl}>
                        Next →
                    </a>
                )}
            </nav>
        )}
    </Layout>
);
