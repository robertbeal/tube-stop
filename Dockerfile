FROM oven/bun:1-alpine

RUN apk add --no-cache ffmpeg python3 py3-pip ca-certificates \
    && pip install --no-cache-dir --break-system-packages -U "yt-dlp[default]"

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src

ENV DATA_DIR=/data \
    MEDIA_DIR=/media \
    CACHE_DIR=/cache \
    PORT=8080

VOLUME ["/data", "/media", "/cache"]
EXPOSE 8080

CMD ["bun", "src/main.ts"]
