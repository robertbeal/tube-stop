import type { FC } from "hono/jsx";
import type { Channel, Video } from "../shared/db/types.ts";
import { formatDuration } from "../web/format.ts";
import { Layout } from "../web/layout.tsx";
import type { Pagination } from "../web/paging.ts";

const thumbnailUrl = (id: string) => `/thumb/${encodeURIComponent(id)}`;

export type IndexProps = {
    videos: Video[];
    channels: Pick<Channel, "youtubeId" | "name">[];
    current: string;
    pages: Pagination;
};

export const IndexPage: FC<IndexProps> = ({ videos, channels, current, pages }) => (
    <Layout title="Tube Stop">
        {channels.length > 0 && (
            <ul class="nav nav-pills flex-nowrap overflow-x-auto pb-2 mb-3">
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
        )}
        <div class="row row-cols-2 row-cols-md-3 row-cols-xl-4 g-3">
            {videos.length === 0 ? (
                <div class="col-12">
                    <p class="text-body-secondary">Nothing here yet.</p>
                </div>
            ) : (
                videos.map((video) => (
                    <div class="col">
                        <a
                            class="card video-card h-100 text-decoration-none"
                            href={`/watch/${encodeURIComponent(video.youtubeId)}`}
                        >
                            <div class="position-relative">
                                <div class="ratio ratio-16x9">
                                    <img
                                        class="card-img-top"
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
                                {video.downloadStatus === "ready" && (
                                    <span
                                        class="badge text-bg-warning position-absolute top-0 start-0 m-2"
                                        title="Saved"
                                    >
                                        ★
                                    </span>
                                )}
                            </div>
                            <div class="card-body p-2">
                                <h2 class="card-title h6 mb-1 video-title">{video.title}</h2>
                                <p class="card-text small text-body-secondary mb-0">{video.channelName}</p>
                            </div>
                        </a>
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
    </Layout>
);

export const WatchPage: FC<{ video: Video; ready: boolean }> = ({ video, ready }) => (
    <Layout title={`${video.title} · Tube Stop`}>
        <div class="player-frame">
            <div class="ratio ratio-16x9 rounded overflow-hidden mb-3">
                <video
                    id="v"
                    poster={thumbnailUrl(video.youtubeId)}
                    src={ready ? `/video/${encodeURIComponent(video.youtubeId)}` : undefined}
                    autoplay={ready}
                    data-id={video.youtubeId}
                    data-ready={String(ready)}
                    controls
                    playsinline
                    preload="metadata"
                />
            </div>
            <div id="wait" class="alert alert-info" role="status" hidden={ready}>
                <span class="spinner-border spinner-border-sm me-2" aria-hidden="true" />
                Getting this video ready… it will start by itself.
            </div>
            <div id="fail" class="alert alert-danger" role="alert" hidden>
                Something went wrong getting this video.{" "}
                <a href="#" id="retry" class="alert-link">
                    Try again
                </a>
            </div>

            <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
                <label for="speed" class="form-label mb-0">
                    Speed
                </label>
                <select id="speed" class="form-select w-auto">
                    <option value="0.5">0.5×</option>
                    <option value="0.75">0.75×</option>
                    <option value="1" selected>
                        1×
                    </option>
                    <option value="1.25">1.25×</option>
                    <option value="1.5">1.5×</option>
                </select>
                <div class="btn-group" role="group" aria-label="Loop a section">
                    <button id="markA" type="button" class="btn btn-outline-secondary">
                        Set A
                    </button>
                    <button id="markB" type="button" class="btn btn-outline-secondary">
                        Set B
                    </button>
                    <button id="loopToggle" type="button" class="btn btn-outline-primary" disabled>
                        Loop off
                    </button>
                    <button id="clearLoop" type="button" class="btn btn-outline-secondary">
                        Clear
                    </button>
                </div>
                <span id="loopInfo" class="text-body-secondary" />
            </div>

            <h1 class="h4">{video.title}</h1>
            <p class="text-body-secondary">{video.channelName}</p>
            <a class="btn btn-outline-secondary" href="/">
                ← Back
            </a>
        </div>
        <script src="/player.js" />
    </Layout>
);
