import type { FC } from "hono/jsx";
import type { Channel, Shelf, Topic, Video, VideoPage } from "../shared/db/types.ts";
import { formatDuration } from "../web/format.ts";
import { Layout } from "../web/layout.tsx";
import type { Pagination } from "../web/paging.ts";
import { Player } from "./video-player.tsx";

const thumbnailUrl = (id: string) => `/thumb/${encodeURIComponent(id)}`;

const VideoCard: FC<{ video: Video }> = ({ video }) => (
    <a class="card video-card h-100 text-decoration-none" href={`/watch/${encodeURIComponent(video.youtubeId)}`}>
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

export type IndexProps = {
    videos: Video[];
    channels: Pick<Channel, "youtubeId" | "name">[];
    current: string;
    pages: Pagination;
    /** When given, the page shows a row for each topic instead of the list of videos. */
    shelves?: { shelves: Shelf[]; other: VideoPage };
};

export const IndexPage: FC<IndexProps> = ({ videos, channels, current, pages, shelves }) => (
    <Layout title="Tube Stop">
        <h1 class="visually-hidden">Videos</h1>
        <ChannelBar channels={channels} current={current} />
        {shelves === undefined ? (
            <VideoGrid videos={videos} pages={pages} />
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
            </>
        )}
    </Layout>
);

/** All the videos of one topic, or of the ones with no topic when `topic` is null. */
export const TopicPage: FC<{ topic: Topic | null; videos: Video[]; pages: Pagination }> = ({
    topic,
    videos,
    pages,
}) => (
    <Layout title={`${topic === null ? "More videos" : topic.name} · Tube Stop`} back={{ href: "/", label: "Home" }}>
        <h1 class="h3 mb-3">
            {topic !== null && topic.emoji !== "" && <span aria-hidden="true">{topic.emoji} </span>}
            {topic === null ? "More videos" : topic.name}
        </h1>
        <VideoGrid videos={videos} pages={pages} />
    </Layout>
);

export const WatchPage: FC<{ video: Video; ready: boolean }> = ({ video, ready }) => (
    <Layout
        title={`${video.title} · Tube Stop`}
        back={{ href: "/", label: "Videos" }}
        head={<link rel="stylesheet" href="/player.css" />}
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
            </div>
        </div>
        <script src="/player.js" />
    </Layout>
);
