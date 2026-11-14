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

    docker build -t tube-stop .
    docker run -p 8080:8080 -v tube-data:/data -v ./media:/media -v tube-cache:/cache tube-stop

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
the app prints a fresh setup code. In the container: `docker exec <container> bun src/main.ts reset-admin`.

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

Source is in `src/` (`config.ts`, `commands.ts`, `main.ts`, `db/`, `web/`, ...); tests sit next to the code they test (`*.test.ts`).

**Changing the schema:** append a new migration in `src/db/`; never edit an existing one.

## Licence

Copyright (C) 2026 robertbeal

Tube Stop is free software: you can redistribute it and/or modify it under the terms of the GNU
General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version (SPDX: `GPL-3.0-or-later`). It is distributed in the
hope that it will be useful, but WITHOUT ANY WARRANTY. See [LICENSE](LICENSE) for the full text.

Third-party code keeps its own licence: Bootstrap (MIT) is in `src/web/static/bootstrap-LICENSE.txt`. `yt-dlp` and `ffmpeg` are separate programs that Tube Stop runs; they are not part of this project or its licence.
