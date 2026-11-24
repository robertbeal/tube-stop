# The yt-dlp release in the image. A scheduled workflow keeps this up to date.
ARG YTDLP_VERSION=2026.11.23

# yt-dlp's standalone build, checked against the checksums published with the release.
FROM docker.io/alpine:3.23 AS ytdlp
ARG TARGETARCH
ARG YTDLP_VERSION
RUN case "$TARGETARCH" in amd64) asset=yt-dlp_musllinux ;; arm64) asset=yt-dlp_musllinux_aarch64 ;; esac \
    && release="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}" \
    && wget -q "${release}/${asset}" \
    && wget -qO- "${release}/SHA2-256SUMS" | grep " ${asset}\$" | sha256sum -c \
    && install -m 755 "${asset}" /yt-dlp

FROM docker.io/alpine:3.23
ARG TARGETARCH
ARG YTDLP_VERSION
LABEL yt-dlp.version=$YTDLP_VERSION
# libstdc++ and libgcc are what the compiled app needs. QuickJS runs the challenges YouTube sets (see yt-dlp.conf).
RUN apk add --no-cache ffmpeg quickjs ca-certificates libstdc++ libgcc \
    && adduser -D -u 1000 tubestop \
    && mkdir -p /app/data /app/media /app/cache \
    && chown -R tubestop:tubestop /app
COPY --from=ytdlp /yt-dlp /usr/local/bin/yt-dlp
COPY yt-dlp.conf /etc/yt-dlp.conf
# The compiled app for Alpine, one file per architecture: see the README for how to make it.
COPY --chmod=755 dist/tube-stop-linux-${TARGETARCH}-musl /usr/local/bin/tube-stop

# Everything the app keeps is under /app, so one mount there is enough.
WORKDIR /app
ENV DATA_DIR=/app/data \
    MEDIA_DIR=/app/media \
    CACHE_DIR=/app/cache \
    PORT=8080
VOLUME ["/app"]
EXPOSE 8080

USER tubestop
CMD ["tube-stop"]
