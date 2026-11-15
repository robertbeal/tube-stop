ARG BUN_VERSION=1.4.4

FROM docker.io/oven/bun:${BUN_VERSION}-alpine AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# yt-dlp's standalone build, checked against the checksums published with the release.
FROM docker.io/alpine:3.23 AS ytdlp
ARG TARGETARCH
ARG YTDLP_VERSION=2026.10.26
RUN case "$TARGETARCH" in amd64) asset=yt-dlp_musllinux ;; arm64) asset=yt-dlp_musllinux_aarch64 ;; esac \
    && release="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}" \
    && wget -q "${release}/${asset}" \
    && wget -qO- "${release}/SHA2-256SUMS" | grep " ${asset}\$" | sha256sum -c \
    && install -m 755 "${asset}" /yt-dlp

FROM docker.io/oven/bun:${BUN_VERSION}-alpine
# QuickJS runs the challenges YouTube sets (see yt-dlp.conf). yt-dlp stopped supporting Bun for this after 1.3.14.
RUN apk add --no-cache ffmpeg quickjs ca-certificates
COPY --from=ytdlp /yt-dlp /usr/local/bin/yt-dlp
COPY yt-dlp.conf /etc/yt-dlp.conf

WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

ENV DATA_DIR=/data \
    MEDIA_DIR=/media \
    CACHE_DIR=/cache \
    PORT=8080
RUN mkdir -p /data /media /cache && chown bun:bun /data /media /cache
VOLUME ["/data", "/media", "/cache"]
EXPOSE 8080

USER bun
CMD ["bun", "src/main.ts"]
