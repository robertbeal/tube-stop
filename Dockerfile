# yt-dlp's standalone build, checked against the checksums published with the release.
FROM docker.io/alpine:3.23 AS ytdlp
ARG TARGETARCH
ARG YTDLP_VERSION
RUN test -n "$YTDLP_VERSION" || { echo "pass --build-arg YTDLP_VERSION=<a yt-dlp release, like 2026.10.26>" >&2; exit 1; } \
    && case "$TARGETARCH" in amd64) asset=yt-dlp_musllinux ;; arm64) asset=yt-dlp_musllinux_aarch64 ;; esac \
    && release="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}" \
    && wget -q "${release}/${asset}" \
    && wget -qO- "${release}/SHA2-256SUMS" | grep " ${asset}\$" | sha256sum -c \
    && install -m 755 "${asset}" /yt-dlp

FROM docker.io/alpine:3.23
ARG TARGETARCH
# libstdc++ and libgcc are what the compiled app needs. QuickJS runs the challenges YouTube sets (see yt-dlp.conf).
RUN apk add --no-cache ffmpeg quickjs ca-certificates libstdc++ libgcc \
    && adduser -D -u 1000 tubestop \
    && mkdir -p /data /media /cache \
    && chown tubestop:tubestop /data /media /cache
COPY --from=ytdlp /yt-dlp /usr/local/bin/yt-dlp
COPY yt-dlp.conf /etc/yt-dlp.conf
# The compiled app, one file per architecture: see the README for how to make it.
COPY dist/image/${TARGETARCH} /usr/local/bin/tube-stop

ENV DATA_DIR=/data \
    MEDIA_DIR=/media \
    CACHE_DIR=/cache \
    PORT=8080
VOLUME ["/data", "/media", "/cache"]
EXPOSE 8080

USER tubestop
CMD ["tube-stop"]
