#!/usr/bin/env bash
# Starts a Tube Stop image and checks that it runs: its tools are there, it serves its pages, and its folders
# can be written by the user it runs as.
# Usage: test-image.sh tube-stop:test
set -euo pipefail

image=${1:?usage: test-image.sh <image>}
scripts=$(dirname "$(realpath "$0")")
port=18081

docker run --rm --entrypoint sh "$image" -c 'yt-dlp --version && ffmpeg -version | head -n 1'

container=$(docker run -d -p "$port:8080" "$image")
trap 'docker rm -f "$container" >/dev/null' EXIT

if ! "$scripts/smoke-test.sh" "http://127.0.0.1:$port"; then
    docker logs "$container"
    exit 1
fi
docker exec "$container" tube-stop reset-admin
docker exec "$container" sh -c 'touch /app/data/x /app/media/x /app/cache/x'
