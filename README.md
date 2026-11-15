# Tube Stop

A curated, ad-free, comment-free YouTube viewer for kids. A parent allows whole channels
or single videos; the child can only browse and watch what is allowed. There is no search.

This is the Bun + Hono + `bun:sqlite` version. It starts with a fresh database and is **not
compatible with the data of the earlier Go version**.

## How it works

**Curation.** Each video has a rule:

| Rule | Meaning |
|---|---|
| `allow` | Watchable on its own, even if its channel is not allowed. Set by pasting a video URL. |
| `inherit` | Watchable while its channel is allowed. Set for videos found by channel sync. |
| `block` | Hidden, even if its channel is allowed. |

Pasting a channel URL allows the channel; its 50 newest videos are synced hourly
(`SYNC_INTERVAL`) and on demand. Videos are shown newest first by upload date. For channel
listings YouTube only gives an approximate date (accurate to the day), which is enough for
ordering; videos with no known date follow the dated ones.

**Removing.** In the admin list, *Remove* on a video from an allowed channel blocks it
(and deletes its files) so the next sync cannot bring it back; the button is labelled
"Remove (stays hidden)". Any other video is deleted outright. Removing a *channel* hides its
videos and deletes their watch-once cache files, but keeps pinned files (unpin those by hand).

**Lists are paged:** 24 videos per page for the child ("More videos"), 100 per page in the admin.

**Playing.** Everything plays from a local file so seeking, speed control and A-B loop work.

- **Watch once.** The first time a video is opened, a 720p copy is downloaded to `CACHE_DIR`
  and the page shows "getting ready" until it can play. Copies not played for
  `CACHE_TTL_DAYS`, or beyond `CACHE_MAX_GB` (least recently played first), are deleted hourly.
- **Pinned.** A parent can pin a video: it is downloaded at up to `KEEP_MAX_HEIGHT` into
  `MEDIA_DIR/<channel>/<date> - <title> [id].mp4` with a `.jpg` thumbnail, and kept until unpinned.
  Point Jellyfin at `MEDIA_DIR` (read-only) to watch pinned videos there too. Unpinning deletes the files.

**Thumbnails** are served from this app (`/thumb/{id}`): a pinned video's own picture if it
has one, otherwise a copy fetched from YouTube once and saved in `DATA_DIR/thumbs`, so the child's
browser never contacts YouTube. They are deleted when a standalone video is removed.

Opening a page never changes anything; the page's script asks for the download
(`POST /api/videos/{id}/prepare`) and reports plays (`POST /api/videos/{id}/played`).

## Run

    bun install
    bun src/main.ts      # or: bun start

Child UI: http://localhost:8080/  Admin: http://localhost:8080/admin

Requires [Bun](https://bun.sh), `yt-dlp` and `ffmpeg` on `PATH`. YouTube changes often, so keep `yt-dlp`
updated (`yt-dlp -U`, or rebuild the container image). With Docker, mount volumes for `/data`,
`/media` and `/cache`:

    mkdir -p dist/image
    bun build --compile --minify --target=bun-linux-x64-musl src/main.ts --outfile dist/image/amd64
    bun build --compile --minify --target=bun-linux-arm64-musl src/main.ts --outfile dist/image/arm64
    docker build --build-arg YTDLP_VERSION=2026.10.26 -t tube-stop .
    docker run -p 8080:8080 -v tube-data:/data -v ./media:/media -v tube-cache:/cache tube-stop

The image does not compile anything. It copies in the compiled app (one file per architecture, made by the
first commands: add `--platform` to `docker build` to pick one), plus `ffmpeg`, QuickJS and `yt-dlp`. The
`yt-dlp` release is a required build argument, so the image always says exactly which one it has. It builds for
`linux/amd64` and `linux/arm64`: use `docker buildx build --platform linux/amd64,linux/arm64`.

### Published images

`.github/workflows/release.yml` publishes to GitHub's container registry (`ghcr.io/<owner>/<repo>`) for both
architectures. Releases are git tags like `v1.2.3`. Pushing one builds it with the newest `yt-dlp` and creates a
GitHub release. The version of the image is the app's version and the `yt-dlp` inside it:

| Tag | Meaning | Moves? |
|---|---|---|
| `1.2.3_2026.10.26` | app 1.2.3 with that `yt-dlp` | never |
| `1.2.3` | app 1.2.3 with the newest `yt-dlp` | when `yt-dlp` updates |
| `1.2`, `1` | the newest release in that line (no `0` tag for `0.x`) | with new releases and `yt-dlp` updates |
| `latest` | the newest release | with new releases and `yt-dlp` updates |
| `edge` | the latest `main`, unreleased | on every push to `main` |

Every night the workflow looks up the newest `yt-dlp`. If the newest release has not been built with it, the
workflow rebuilds that release's tag (not `main`) and moves the tags above. Nothing happens otherwise, and
unreleased code never reaches `latest`. Pull `latest` (for example with Watchtower) to follow along, or pin a
full tag such as `1.2.3_2026.10.26` to stay put. You can also run the workflow by hand from the Actions tab.

### Binaries

Each GitHub release also has the app compiled into one executable (the Bun runtime is inside, so about
100 MB, or about 50 MB as a download), with a `SHA256SUMS` file:

| File | For |
|---|---|
| `tube-stop-<version>-linux-x64.tar.gz`, `-linux-arm64.tar.gz` | most Linux systems |
| `tube-stop-<version>-linux-x64-musl.tar.gz`, `-linux-arm64-musl.tar.gz` | Alpine and other musl systems (`apk add libstdc++ libgcc` first) |

The binary does not include `yt-dlp` or `ffmpeg`: install them and put them on `PATH`. Configure it with the
same environment variables as above. `./tube-stop reset-admin` works too. To build one yourself:
`bun build --compile --minify src/main.ts --outfile tube-stop`.

To release: `git tag v1.2.3 && git push origin v1.2.3`.

### How the workflow runs

Each step runs only if the one before it passed:

1. **plan:** works out what to build (the tag, `edge`, or the newest release for the nightly run) and which
   `yt-dlp` to use. The nightly run stops here if there is nothing new.
2. **check:** `bun run check`: type check, lint and all the tests, on the code being built.
3. **binaries:** compiles the four binaries once, and smoke-tests one from an empty folder.
4. **image:** builds the multi-arch image from those same binaries and pushes it.
5. **release:** for a tag, creates the GitHub release with the binaries attached.

## Admin accounts

**First run.** There is no default password. While no admin account exists, `/admin` leads to a
setup page, and the app prints a one-time **setup code** (like `7K2P-Q9XM`) in its log. Enter the
code plus a username and password to create the account; this proves you can read the server's
log, so a stranger on your network cannot claim the account first. After that the setup page
disappears for good (it returns 404).

**Passwords** (at least 8 characters) are never stored: only a salted hash is. Logging in with an unknown username takes as long as a wrong password
and gives the same message, so accounts cannot be discovered. Change your password from the admin
page; that signs out every other login.

**Sessions** are a random token in a cookie (HttpOnly, SameSite=Strict, and Secure when served over
HTTPS), last `ADMIN_SESSION_DAYS`, and are kept in memory, so a restart logs you out. Five wrong
passwords or setup codes in a minute refuse further attempts for a minute. The password still
travels in clear text over plain HTTP, so put the app behind HTTPS (a reverse proxy that sets
`X-Forwarded-Proto: https`) if it is reachable beyond your LAN.

**Forgotten password.** On the machine running the app, with the same `DATA_DIR`:

    bun src/main.ts reset-admin

This deletes the admin account (videos, channels and settings are kept). Open `/admin` again and
the app prints a fresh setup code. In the container: `docker exec <container> tube-stop reset-admin`.

| Env | Default |
|---|---|
| `HOST` | `0.0.0.0` |
| `PORT` | `8080` |
| `DATA_DIR` / `MEDIA_DIR` / `CACHE_DIR` | `./data` / `./media` / `./cache` |
| `YTDLP_BIN` | `yt-dlp` |
| `KEEP_MAX_HEIGHT` | `1080` |
| `ADMIN_SESSION_DAYS` | `30` (1 to 400) |
| `CACHE_TTL_DAYS` / `CACHE_MAX_GB` | `7` / `20` |
| `SYNC_INTERVAL` | `1h` (durations like `30m`, `1h30m`, `500ms`) |

Empty values mean the default. Invalid values stop the app at startup with a message naming each
problem. `ADMIN_PASSWORD` is ignored: accounts are created in the browser.

## Development

    bun test           # all tests (stub yt-dlp, no network)
    bun run check      # typecheck + biome lint + tests, for CI
    bun run format     # biome format and fix

Source is in `src/` (`main.ts` and `serve.ts` for startup, `admin/` for accounts, login and the admin page, `user/` for the child's pages and player, `sync/` for channel syncing and the download worker, `web/` for the Hono app and what the pages share, `shared/` for config, the database, yt-dlp and the rest); tests sit next to the code they test (`*.test.ts`), with the shared test setup in `tests/`.

**Changing the schema:** append a new migration in `src/shared/db/`; never edit an existing one.

## Licence

Copyright (C) 2026 robertbeal

Tube Stop is free software: you can redistribute it and/or modify it under the terms of the GNU
General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version (SPDX: `GPL-3.0-or-later`). It is distributed in the
hope that it will be useful, but WITHOUT ANY WARRANTY. See [LICENSE](LICENSE) for the full text.

Third-party code keeps its own licence: Bootstrap (MIT) is in `src/web/static/bootstrap-LICENSE.txt`. `yt-dlp` and `ffmpeg` are separate programs that Tube Stop runs; they are not part of this project or its licence.
