import { raw } from "hono/html";
import type { Child, FC, PropsWithChildren } from "hono/jsx";
import type { Channel, Video } from "../db/store.ts";
import { formatDuration, humanBytes, timeAgo } from "./format.ts";
import type { Pagination } from "./paging.ts";

interface LayoutProps {
  title: string;
  navbar?: Child;
}

const Layout: FC<PropsWithChildren<LayoutProps>> = ({ title, navbar, children }) => (
  <>
    {raw("<!doctype html>")}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <title>{title}</title>
        <script src="/static/theme.js" />
        <link rel="stylesheet" href="/static/bootstrap.min.css" />
        <link rel="stylesheet" href="/static/style.css" />
      </head>
      <body>
        <nav class="navbar bg-body-tertiary border-bottom mb-3">
          <div class="container-xxl">
            <a class="navbar-brand fw-bold" href="/">
              Tube Stop
            </a>
            {navbar}
          </div>
        </nav>
        <main class="container-xxl pb-4">{children}</main>
      </body>
    </html>
  </>
);

const thumbnailUrl = (id: string) => `/thumb/${encodeURIComponent(id)}`;

// ---- child pages ----

export interface IndexProps {
  videos: Video[];
  channels: Pick<Channel, "youtubeId" | "name">[];
  current: string;
  pages: Pagination;
}

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
                  <img class="card-img-top" src={thumbnailUrl(video.youtubeId)} alt="" loading="lazy" />
                </div>
                {video.duration > 0 && (
                  <span class="badge text-bg-dark position-absolute bottom-0 end-0 m-2">
                    {formatDuration(video.duration)}
                  </span>
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
    <script src="/static/player.js" />
  </Layout>
);

// ---- sign in and set up ----

export interface LoginProps {
  next: string;
  username?: string;
  error?: string;
}

export const LoginPage: FC<LoginProps> = ({ next, username = "", error }) => (
  <Layout title="Admin login · Tube Stop">
    <div class="card auth-card mx-auto mt-4 shadow-sm">
      <div class="card-body p-4">
        <form method="post" action="/admin/login">
          <h1 class="h4 mb-3">Admin login</h1>
          {error && (
            <div class="alert alert-danger" role="alert">
              {error}
            </div>
          )}
          <input type="hidden" name="next" value={next} />
          <div class="mb-3">
            <label class="form-label" for="username">
              Username
            </label>
            <input
              class="form-control"
              id="username"
              name="username"
              value={username}
              autocomplete="username"
              autocapitalize="none"
              autofocus={username === ""}
              required
            />
          </div>
          <div class="mb-3">
            <label class="form-label" for="password">
              Password
            </label>
            <input
              class="form-control"
              id="password"
              type="password"
              name="password"
              autocomplete="current-password"
              autofocus={username !== ""}
              required
            />
          </div>
          <button type="submit" class="btn btn-primary w-100">
            Log in
          </button>
        </form>
      </div>
    </div>
  </Layout>
);

export const SetupPage: FC<{ username?: string; error?: string }> = ({ username = "", error }) => (
  <Layout title="Set up · Tube Stop">
    <div class="card auth-card mx-auto mt-4 shadow-sm">
      <div class="card-body p-4">
        <form method="post" action="/admin/setup">
          <h1 class="h4 mb-2">Set up Tube Stop</h1>
          <p class="text-body-secondary">
            Create the admin account. The setup code is printed in the app's log (the terminal or container
            logs where it is running).
          </p>
          {error && (
            <div class="alert alert-danger" role="alert">
              {error}
            </div>
          )}
          <div class="mb-3">
            <label class="form-label" for="code">
              Setup code
            </label>
            <input
              class="form-control"
              id="code"
              name="code"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck={false}
              placeholder="XXXX-XXXX"
              autofocus
              required
            />
          </div>
          <div class="mb-3">
            <label class="form-label" for="username">
              Username
            </label>
            <input
              class="form-control"
              id="username"
              name="username"
              value={username}
              autocomplete="username"
              autocapitalize="none"
              maxlength={64}
              required
            />
          </div>
          <div class="mb-3">
            <label class="form-label" for="password">
              Password
            </label>
            <input
              class="form-control"
              id="password"
              type="password"
              name="password"
              autocomplete="new-password"
              minlength={8}
              maxlength={72}
              aria-describedby="password-help"
              required
            />
            <div id="password-help" class="form-text">
              At least 8 characters.
            </div>
          </div>
          <div class="mb-3">
            <label class="form-label" for="confirm">
              Confirm password
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
          <button type="submit" class="btn btn-primary w-100">
            Create admin account
          </button>
        </form>
      </div>
    </div>
  </Layout>
);

// ---- admin ----

export interface AdminProps {
  username: string;
  message: string;
  channels: Channel[];
  videos: Video[];
  current: string;
  pages: Pagination;
  mediaBytes: number;
  cacheBytes: number;
  nowMs: number;
}

const PostButton: FC<{ action: string; buttonClass: string; inline?: boolean; label: string }> = ({
  action,
  buttonClass,
  inline = true,
  label,
}) => (
  <form class={inline ? "d-inline" : undefined} method="post" action={action}>
    <button type="submit" class={`btn ${buttonClass} btn-sm`}>
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
          <PostButton action={`${base}/unpin`} buttonClass="btn-outline-secondary" label="Unpin" />{" "}
          {video.downloadStatus === "failed" && (
            <PostButton action={`${base}/retry`} buttonClass="btn-outline-primary" label="Retry" />
          )}
        </>
      ) : (
        <PostButton action={`${base}/pin`} buttonClass="btn-outline-primary" label="Pin" />
      )}{" "}
      {video.rule === "block" ? (
        <PostButton action={`${base}/unblock`} buttonClass="btn-outline-success" label="Unblock" />
      ) : (
        <PostButton action={`${base}/block`} buttonClass="btn-outline-warning" label="Block" />
      )}{" "}
      <PostButton
        action={`${base}/remove`}
        buttonClass="btn-outline-danger"
        label={video.channelAllowed ? "Remove (stays hidden)" : "Remove"}
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
        <button type="submit" class="btn btn-outline-secondary btn-sm">
          Log out
        </button>
      </form>
    }
  >
    <h1 class="h3 mb-3">Admin</h1>
    {props.message !== "" && (
      <div class="alert alert-info" role="status">
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
      <button type="submit" class="btn btn-primary">
        Allow
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
        <button type="submit" class="btn btn-primary">
          Change password
        </button>
      </form>
    </details>

    <div class="d-flex justify-content-between align-items-center mb-2">
      <h2 class="h5 mb-0">Allowed channels</h2>
      <form method="post" action="/admin/sync">
        <button type="submit" class="btn btn-outline-primary btn-sm">
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
                  <a href={`/admin?channel=${encodeURIComponent(channel.youtubeId)}`}>{channel.name}</a>
                </td>
                <td>{channel.videoCount}</td>
                <td>{timeAgo(props.nowMs, channel.lastSyncedAt)}</td>
                <td class="text-end">
                  <PostButton
                    action={`/admin/channels/${channel.id}/remove`}
                    buttonClass="btn-outline-danger"
                    inline={false}
                    label="Remove"
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
        {props.current !== "" ? (
          <>
            (channel filter · <a href="/admin">clear</a>)
          </>
        ) : (
          "(individual, blocked, pinned)"
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
