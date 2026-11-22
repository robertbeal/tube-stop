import type { FC } from "hono/jsx";
import type { Channel, Shelf, Video, VideoPage } from "../shared/db/types.ts";
import { formatDuration } from "../web/format.ts";
import { Layout } from "../web/layout.tsx";
import type { Pagination } from "../web/paging.ts";
import { Player } from "./video-player.tsx";

const thumbnailUrl = (id: string) => `/thumb/${encodeURIComponent(id)}`;

const VideoCard: FC<{ video: Video }> = ({ video }) => (
    <a
        class="card video-card h-100 text-decoration-none"
        href={`/watch/${encodeURIComponent(video.youtubeId)}`}
        data-video-id={video.youtubeId}
        data-title={video.title}
        data-channel={video.channelName}
        data-duration={String(video.duration)}
    >
        <div class="position-relative">
            <div class="ratio ratio-16x9">
                <img
                    class={`card-img-top ${video.watchedAt > 0 ? "watched-thumb" : ""}`}
                    src={thumbnailUrl(video.youtubeId)}
                    alt=""
                    loading="lazy"
                />
            </div>
            {video.duration > 0 && (
                <span class="badge text-bg-dark position-absolute bottom-0 end-0 m-2">
                    {formatDuration(video.duration)}
                </span>
            )}
            {video.watchedAt > 0 && (
                <span class="badge text-bg-success position-absolute top-0 end-0 m-2">✓ Watched</span>
            )}
            {video.downloadStatus === "ready" && (
                <span class="badge text-bg-warning position-absolute top-0 start-0 m-2" title="Saved">
                    ★
                </span>
            )}
        </div>
        <div class="card-body p-2">
            <h2 class="card-title h6 mb-1 video-title">{video.title}</h2>
            <p class="card-text small text-body-secondary mb-0">{video.channelName}</p>
        </div>
    </a>
);

const ChannelBar: FC<{ channels: Pick<Channel, "youtubeId" | "name">[]; current: string }> = ({ channels, current }) =>
    channels.length === 0 ? null : (
        <ul class="nav nav-pills flex-nowrap overflow-x-auto pb-2 mb-3 channel-bar">
            <li class="nav-item">
                <a class={`nav-link ${current === "" ? "active" : ""}`} href="/">
                    All
                </a>
            </li>
            {channels.map((channel) => (
                <li class="nav-item">
                    <a
                        class={`nav-link text-nowrap ${current === channel.youtubeId ? "active" : ""}`}
                        href={`/?channel=${encodeURIComponent(channel.youtubeId)}`}
                    >
                        {channel.name}
                    </a>
                </li>
            ))}
        </ul>
    );

const VideoGrid: FC<{ videos: Video[]; pages: Pagination }> = ({ videos, pages }) => (
    <>
        <div class="row row-cols-2 row-cols-md-3 row-cols-xl-4 g-3">
            {videos.length === 0 ? (
                <div class="col-12">
                    <p class="text-body-secondary">Nothing here yet.</p>
                </div>
            ) : (
                videos.map((video) => (
                    <div class="col">
                        <VideoCard video={video} />
                    </div>
                ))
            )}
        </div>
        {(pages.previousUrl !== "" || pages.nextUrl !== "") && (
            <nav class="d-flex justify-content-center flex-wrap gap-3 my-4" aria-label="Pages">
                {pages.previousUrl !== "" && (
                    <a class="btn btn-outline-secondary btn-lg" href={pages.previousUrl}>
                        ← Newer videos
                    </a>
                )}
                {pages.nextUrl !== "" && (
                    <a class="btn btn-primary btn-lg" href={pages.nextUrl}>
                        More videos →
                    </a>
                )}
            </nav>
        )}
    </>
);

/** A row of videos under a heading, scrolling sideways, ending in a tile to see them all. */
const ShelfRow: FC<{
    heading: string;
    emoji: string;
    color: string;
    href: string;
    videos: Video[];
    total: number;
}> = ({ heading, emoji, color, href, videos, total }) => (
    <section class="shelf mb-4" aria-label={heading}>
        <h2 class="h4 mb-2">
            <a class={`shelf-heading text-decoration-none text-${color}-emphasis`} href={href}>
                {emoji !== "" && <span aria-hidden="true">{emoji} </span>}
                {heading}
            </a>
        </h2>
        <ul class="shelf-row list-unstyled d-flex gap-3 overflow-x-auto pb-2 mb-0">
            {videos.map((video) => (
                <li class="shelf-item">
                    <VideoCard video={video} />
                </li>
            ))}
            {total > videos.length && (
                <li class="shelf-item shelf-more">
                    <a
                        class={`btn btn-${color} btn-lg w-100 h-100 d-flex align-items-center justify-content-center`}
                        href={href}
                    >
                        See all {total} →
                    </a>
                </li>
            )}
        </ul>
    </section>
);

// Material Design "visibility" and "visibility_off" icons.
const visibleIcon =
    "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z";
const hiddenIcon =
    "M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z";

/** The button shows what pressing it does: the eye is crossed out to hide watched videos, and open to show them again. */
const HideWatchedToggle: FC<{ hidden: boolean; here: string }> = ({ hidden, here }) => (
    <form method="post" action="/hide-watched" class="hide-watched-form">
        <input type="hidden" name="next" value={here} />
        <input type="hidden" name="hide" value={hidden ? "0" : "1"} />
        <button
            type="submit"
            class={`btn toggle-button d-inline-flex align-items-center gap-2 ${hidden ? "btn-success" : "btn-outline-secondary"}`}
        >
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
                <path fill="currentColor" d={hidden ? visibleIcon : hiddenIcon} />
            </svg>
            {hidden ? "Show watched" : "Hide watched"}
        </button>
    </form>
);

/**
 * Shows only the videos pinned on this device. Pins are kept by the browser, so the server cannot draw the
 * list: the page's script does, and shows this button once it can.
 */
const PinnedToggle: FC = () => (
    <button
        id="pinnedToggle"
        type="button"
        class="btn toggle-button btn-outline-secondary d-inline-flex align-items-center gap-2"
        aria-pressed="false"
        hidden
    >
        <span aria-hidden="true">📌</span>
        <span id="pinnedToggleLabel">Pinned only</span>
    </button>
);

/** The buttons that narrow a list of videos. */
const FilterBar: FC<{ watched?: { hidden: boolean; here: string } }> = ({ watched }) => (
    <div class="filter-bar d-flex justify-content-end flex-wrap gap-2 mb-3">
        <PinnedToggle />
        {watched !== undefined && <HideWatchedToggle hidden={watched.hidden} here={watched.here} />}
    </div>
);

export type IndexProps = {
    videos: Video[];
    channels: Pick<Channel, "youtubeId" | "name">[];
    current: string;
    pages: Pagination;
    /** When given, the page shows a row for each topic instead of the list of videos. */
    shelves?: { shelves: Shelf[]; other: VideoPage; recent: VideoPage };
    /** Recently watched videos to show under the list; the topic rows carry their own. */
    recent?: VideoPage;
    /** Whether watched videos are being left out. */
    hideWatched: boolean;
    /** The page's own address, to come back to after pressing the button. */
    here: string;
};

export const IndexPage: FC<IndexProps> = ({ videos, channels, current, pages, shelves, recent, hideWatched, here }) => (
    <Layout title="Tube Stop" offline>
        <h1 class="visually-hidden">Videos</h1>
        <ChannelBar channels={channels} current={current} />
        <FilterBar watched={{ hidden: hideWatched, here }} />
        {shelves === undefined ? (
            <>
                <VideoGrid videos={videos} pages={pages} />
                {recent !== undefined && recent.total > 0 && (
                    <ShelfRow
                        heading="Recently watched"
                        emoji="✓"
                        color="success"
                        href="/watched"
                        videos={recent.videos}
                        total={recent.total}
                    />
                )}
            </>
        ) : (
            <>
                {shelves.shelves.map(({ topic, videos: shelfVideos, total }) => (
                    <ShelfRow
                        heading={topic.name}
                        emoji={topic.emoji}
                        color={topic.color}
                        href={`/topic/${encodeURIComponent(topic.slug)}`}
                        videos={shelfVideos}
                        total={total}
                    />
                ))}
                {shelves.other.total > 0 && (
                    <ShelfRow
                        heading={shelves.shelves.length === 0 ? "Videos" : "More videos"}
                        emoji=""
                        color="secondary"
                        href="/other"
                        videos={shelves.other.videos}
                        total={shelves.other.total}
                    />
                )}
                {shelves.recent.total > 0 && (
                    <ShelfRow
                        heading="Recently watched"
                        emoji="✓"
                        color="success"
                        href="/watched"
                        videos={shelves.recent.videos}
                        total={shelves.recent.total}
                    />
                )}
            </>
        )}
    </Layout>
);

/** A full list of videos under a heading: a topic, the ones with no topic, or the recently watched. */
export const TopicPage: FC<{
    heading: string;
    emoji: string;
    videos: Video[];
    pages: Pagination;
    /** The hide-watched button, left out when not given. */
    toggle?: { hidden: boolean; here: string };
}> = ({ heading, emoji, videos, pages, toggle }) => (
    <Layout title={`${heading} · Tube Stop`} back={{ href: "/", label: "Home" }} offline>
        <h1 class="h3 mb-3">
            {emoji !== "" && <span aria-hidden="true">{emoji} </span>}
            {heading}
        </h1>
        <FilterBar watched={toggle} />
        <VideoGrid videos={videos} pages={pages} />
    </Layout>
);

export const WatchPage: FC<{ video: Video; ready: boolean }> = ({ video, ready }) => (
    <Layout
        title={`${video.title} · Tube Stop`}
        back={{ href: "/", label: "Videos" }}
        head={<link rel="stylesheet" href="/player.css" />}
        offline
    >
        <div class="player-frame">
            <Player
                video={video}
                ready={ready}
                posterUrl={thumbnailUrl(video.youtubeId)}
                sourceUrl={`/video/${encodeURIComponent(video.youtubeId)}`}
            />
            <div class="watch-details">
                <h1 class="h4">{video.title}</h1>
                <p class="text-body-secondary">{video.channelName}</p>
                <div class="d-flex flex-wrap align-items-center gap-3 mb-3">
                    <button
                        id="pinButton"
                        type="button"
                        class="btn btn-outline-primary btn-lg pin-button"
                        data-id={video.youtubeId}
                        data-title={video.title}
                        data-channel={video.channelName}
                        data-duration={String(video.duration)}
                        aria-pressed="false"
                        hidden
                    >
                        📌 Pin
                    </button>
                    <span id="pinMessage" class="text-body-secondary" role="status" />
                </div>
            </div>
        </div>
        <script src="/player.js" />
    </Layout>
);
