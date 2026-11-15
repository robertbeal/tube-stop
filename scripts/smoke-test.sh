#!/usr/bin/env bash
# Checks that a running Tube Stop serves its pages and the files built into it.
# Usage: smoke-test.sh http://127.0.0.1:8080
set -euo pipefail

base=${1:?usage: smoke-test.sh <base url>}

for _ in $(seq 40); do
    curl -sf -o /dev/null "$base/" && break
    sleep 0.5
done

for path in / /admin/setup /static/bootstrap.min.css /static/bootstrap-LICENSE.txt /static/style.css /static/theme.js /player.js /player.css; do
    curl -sf -o /dev/null "$base$path" || { echo "$path failed" >&2; exit 1; }
done
echo "ok"
