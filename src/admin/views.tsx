import type { FC } from "hono/jsx";
import { topicColors } from "../shared/db/topics.ts";
import type { Channel, ChannelId, Topic, TopicId, Video } from "../shared/db/types.ts";
import type { VideoId } from "../shared/ytdlp/types.ts";
import { humanBytes, timeAgo } from "../web/format.ts";
import { Layout } from "../web/layout.tsx";
import type { Pagination } from "../web/paging.ts";

export type AdminProps = {
    username: string;
    message: string;
    /** How the message is shown: "success", "warning" or "error". Anything else is shown neutrally. */
    messageKind: string;
    channels: Channel[];
    topics: Topic[];
    /** The topics given to each channel. */
    channelTopics: Map<ChannelId, TopicId[]>;
    /** The topics given to each video itself, not counting those it gets from its channel. */
    videoTopics: Map<VideoId, TopicId[]>;
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

const TopicBadge: FC<{ topic: Topic; inherited?: boolean }> = ({ topic, inherited = false }) => (
    <span
        class={`badge ${inherited ? `text-bg-light border text-${topic.color}-emphasis` : `text-bg-${topic.color}`}`}
        title={inherited ? "From its channel" : undefined}
    >
        {topic.emoji} {topic.name}
    </span>
);

/** The topics something has, and a box of ticks to change them. `inherited` are shown but come from elsewhere. */
const TopicPicker: FC<{ action: string; topics: Topic[]; chosen: TopicId[]; inherited?: TopicId[] }> = ({
    action,
    topics,
    chosen,
    inherited = [],
}) => {
    if (topics.length === 0) {
        return null;
    }
    const own = topics.filter((topic) => chosen.includes(topic.id));
    const fromChannel = topics.filter((topic) => inherited.includes(topic.id) && !chosen.includes(topic.id));
    return (
        <details class="topic-picker">
            <summary class="d-flex flex-wrap gap-1">
                {own.map((topic) => (
                    <TopicBadge topic={topic} />
                ))}
                {fromChannel.map((topic) => (
                    <TopicBadge topic={topic} inherited />
                ))}
                {own.length + fromChannel.length === 0 && <span class="text-body-secondary small">＋ topics</span>}
            </summary>
            <form method="post" action={action} class="card card-body mt-2 py-2">
                {topics.map((topic) => (
                    <label class="form-check">
                        <input
                            class="form-check-input"
                            type="checkbox"
                            name="topic"
                            value={topic.id}
                            checked={chosen.includes(topic.id)}
                        />
                        <span class="form-check-label">
                            {topic.emoji} {topic.name}
                        </span>
                    </label>
                ))}
                <button type="submit" class="btn btn-primary btn-sm mt-2 align-self-start" data-busy-label="Saving…">
                    Save topics
                </button>
            </form>
        </details>
    );
};

const ColorSelect: FC<{ selected: string }> = ({ selected }) => (
    <select class="form-select form-select-sm w-auto" name="color" aria-label="Colour">
        {topicColors.map((color) => (
            <option value={color} selected={color === selected}>
                {color}
            </option>
        ))}
    </select>
);

const TopicsSection: FC<{ topics: Topic[] }> = ({ topics }) => (
    <details class="card card-body mb-4">
        <summary class="fw-semibold">Topics ({topics.length})</summary>
        <p class="text-body-secondary small mt-2 mb-2">
            Topics group the videos on the child's home page. Tag channels and videos with them below. The order here is
            the order on the page.
        </p>
        <div class="table-responsive">
            <table class="table align-middle mb-3">
                <tbody>
                    {topics.map((topic, index) => (
                        <tr>
                            <td>
                                <form
                                    method="post"
                                    action={`/admin/topics/${topic.id}/update`}
                                    class="d-flex flex-wrap gap-2"
                                >
                                    <input
                                        class="form-control form-control-sm topic-emoji"
                                        name="emoji"
                                        value={topic.emoji}
                                        maxlength={8}
                                        aria-label="Emoji"
                                    />
                                    <input
                                        class="form-control form-control-sm w-auto"
                                        name="name"
                                        value={topic.name}
                                        maxlength={40}
                                        aria-label="Name"
                                        required
                                    />
                                    <ColorSelect selected={topic.color} />
                                    <button
                                        type="submit"
                                        class="btn btn-outline-primary btn-sm"
                                        data-busy-label="Saving…"
                                    >
                                        Save
                                    </button>
                                </form>
                            </td>
                            <td class="text-end text-nowrap">
                                {index > 0 && (
                                    <PostButton
                                        action={`/admin/topics/${topic.id}/up`}
                                        buttonClass="btn-outline-secondary"
                                        label="↑"
                                        busyLabel="…"
                                    />
                                )}{" "}
                                {index < topics.length - 1 && (
                                    <PostButton
                                        action={`/admin/topics/${topic.id}/down`}
                                        buttonClass="btn-outline-secondary"
                                        label="↓"
                                        busyLabel="…"
                                    />
                                )}{" "}
                                <PostButton
                                    action={`/admin/topics/${topic.id}/delete`}
                                    buttonClass="btn-outline-danger"
                                    label="Delete"
                                    busyLabel="Deleting…"
                                />
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
        <form method="post" action="/admin/topics" class="d-flex flex-wrap gap-2">
            <input
                class="form-control form-control-sm topic-emoji"
                name="emoji"
                placeholder="🙂"
                maxlength={8}
                aria-label="Emoji"
            />
            <input
                class="form-control form-control-sm w-auto"
                name="name"
                placeholder="New topic"
                maxlength={40}
                aria-label="Name"
                required
            />
            <ColorSelect selected="primary" />
            <button type="submit" class="btn btn-primary btn-sm" data-busy-label="Adding…">
                Add topic
            </button>
        </form>
    </details>
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

/** The topics a video gets from its channel. */
function channelTopicsOf(props: AdminProps, video: Video): TopicId[] {
    const channel = props.channels.find((candidate) => candidate.youtubeId === video.channelYoutubeId);
    return channel === undefined ? [] : (props.channelTopics.get(channel.id) ?? []);
}

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

        <TopicsSection topics={props.topics} />

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
                        <th>Topics</th>
                        <th>Videos</th>
                        <th>Last sync</th>
                        <th />
                    </tr>
                </thead>
                <tbody>
                    {props.channels.length === 0 ? (
                        <tr>
                            <td colspan={5} class="text-body-secondary">
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
                                <td>
                                    <TopicPicker
                                        action={`/admin/channels/${channel.id}/topics`}
                                        topics={props.topics}
                                        chosen={props.channelTopics.get(channel.id) ?? []}
                                    />
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
                        <th>Topics</th>
                        <th>Status</th>
                        <th>Plays</th>
                        <th />
                    </tr>
                </thead>
                <tbody>
                    {props.videos.length === 0 ? (
                        <tr>
                            <td colspan={6} class="text-body-secondary">
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
                                    <TopicPicker
                                        action={`/admin/videos/${encodeURIComponent(video.youtubeId)}/topics`}
                                        topics={props.topics}
                                        chosen={props.videoTopics.get(video.youtubeId) ?? []}
                                        inherited={channelTopicsOf(props, video)}
                                    />
                                </td>
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
