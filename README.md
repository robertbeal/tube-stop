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

Once it is running, the child's view is at http://localhost:8080/ and the admin area at
http://localhost:8080/admin. Settings are environment variables, listed under [Settings](#settings).

### Docker

    services:
      tube-stop:
        image: ghcr.io/robertbeal/tube-stop:latest
        restart: unless-stopped
        user: "4217:4217"   # the owner of ./tube-stop on the host
        ports:
          - "8080:8080"
        volumes:
          - ./tube-stop:/app
        environment:
          CACHE_MAX_GB: 20
          KEEP_MAX_HEIGHT: 1080

Everything is kept under `/app`: `data/` (the database and thumbnails), `media/` (pinned videos, one
folder per channel: point Jellyfin here, read-only) and `cache/` (watch-once copies, deleted automatically).
To put one somewhere else, mount it over its folder, for example `./videos:/app/media`. Keeping them under one
mount is the simplest, and lets files move between the folders instantly.

The app never runs as root. By default it runs as user 1000, but set `user:` to the owner of the folder you
mount (as above, using your own numbers: `ls -ldn tube-stop` shows them). If the folder does not exist, Docker
creates it owned by root, and the app stops with `cannot open the database in /app/data: EACCES`: create it
first with `mkdir tube-stop && chown 4217:4217 tube-stop`. With a named volume instead of a host folder
(`tube-stop:/app`), Docker gives the app ownership itself and you can leave out `user:`.

The image has the app, `ffmpeg` and `yt-dlp`, for `amd64` and `arm64`. Pick a tag:

| Tag | Use it to |
|---|---|
| `latest` | follow the newest release |
| `1.2` | stay on one minor version, and get its fixes |
| `1.2.3` | stay on exactly one version |

YouTube changes often, so a new `yt-dlp` is released as a new version of the app within a day. Pull again (or use
something like Watchtower) to get it. The image says which `yt-dlp` it has in its `yt-dlp.version` label.

### Binary

Each GitHub release has the app compiled into one executable, about 50 MB to download, with a `SHA256SUMS`
file. Use the `amd64` or `arm64` one for your machine, or the `-musl` one on Alpine (after
`apk add libstdc++ libgcc`). Install `yt-dlp` and `ffmpeg` and put them on `PATH`, then run `./tube-stop`.
`./tube-stop reset-admin` works too.

### From source

Requires [Bun](https://bun.sh), `yt-dlp` and `ffmpeg` on `PATH`.

    bun install
    bun start

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

## Settings

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

**Building the image.** The image copies in a compiled app instead of compiling one, so make that first:

    bun build --compile --minify --target=bun-linux-x64-musl src/main.ts --outfile dist/tube-stop-linux-amd64-musl
    bun build --compile --minify --target=bun-linux-arm64-musl src/main.ts --outfile dist/tube-stop-linux-arm64-musl
    docker build -t tube-stop .

Add `--platform linux/amd64,linux/arm64` with `docker buildx build` for both architectures. `scripts/test-image.sh
tube-stop` then checks that the image runs. To build a standalone binary for this machine:
`bun build --compile --minify src/main.ts --outfile tube-stop`.

**Releasing is automatic.** Everything is built from `main`, and [semantic-release](https://semantic-release.gitbook.io)
works out the version from the commit messages ([conventional commits](https://www.conventionalcommits.org)), so
there are no tags to push by hand. With its standard rules:

| Commit pushed to `main` | Release |
|---|---|
| `fix:` or `perf:` | patch (0.2.0 → 0.2.1) |
| `feat:` | minor (0.2.0 → 0.3.0) |
| a `!` after the type (`feat!:`), or a `BREAKING CHANGE:` line | major (0.2.0 → 1.0.0) |
| anything else (`docs`, `ci`, `refactor`, `test`, `chore`…) | none: only the checks run |

`.github/workflows/release.yml` runs `bun run check` and asks semantic-release what the next version is. If there
is one, it compiles the four Linux binaries, builds the image, starts it (`scripts/test-image.sh`), pushes it to
`ghcr.io` as `1.2.3`, `1.2`, `1` (not for `0.x`) and `latest`, and creates the `v…` tag and GitHub release with the
binaries attached. A failure at any point stops there, before anything is tagged. Run the workflow by hand from the
Actions tab to retry.

The `yt-dlp` version is pinned at the top of the `Dockerfile`. Every night `.github/workflows/update-ytdlp.yml`
checks for a newer one and, if there is, commits `fix(deps): update yt-dlp to …` to `main`, which releases a new
version like any other fix.

**Changing the schema:** append a new migration in `src/shared/db/`; never edit an existing one.

## Licence

Copyright (C) 2026 robertbeal

Tube Stop is free software: you can redistribute it and/or modify it under the terms of the GNU
General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version (SPDX: `GPL-3.0-or-later`). It is distributed in the
hope that it will be useful, but WITHOUT ANY WARRANTY. See [LICENSE](LICENSE) for the full text.

Third-party code keeps its own licence: Bootstrap (MIT) is in `src/web/static/bootstrap-LICENSE.txt`. `yt-dlp` and `ffmpeg` are separate programs that Tube Stop runs; they are not part of this project or its licence.
