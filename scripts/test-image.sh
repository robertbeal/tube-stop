#!/usr/bin/env bash
# Starts a Tube Stop image and checks that it runs: its tools are there, it serves its pages and the files built
# into it, and the user it runs as can write to its folders.
# Usage: test-image.sh tube-stop:test
set -euo pipefail

image=${1:?usage: test-image.sh <image>}
url=http://127.0.0.1:18081

docker run --rm --entrypoint sh "$image" -c 'yt-dlp --version && ffmpeg -version | head -n 1'

container=$(docker run -d -p 18081:8080 "$image")
trap 'docker rm -f "$container" >/dev/null' EXIT

for _ in $(seq 40); do
    curl -sf -o /dev/null "$url/" && break
    sleep 0.5
done
for path in / /admin/setup /static/bootstrap.min.css /static/bootstrap-LICENSE.txt /static/style.css /static/theme.js /static/forms.js /player.js /player.css; do
    curl -sf -o /dev/null "$url$path" || { echo "$path failed" >&2; docker logs "$container"; exit 1; }
done

docker exec "$container" tube-stop reset-admin
docker exec "$container" sh -c 'touch /app/data/x /app/media/x /app/cache/x'
