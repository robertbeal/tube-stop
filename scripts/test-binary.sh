#!/usr/bin/env bash
# Runs a compiled Tube Stop from an empty folder, and checks that it serves its pages and embedded files.
# Usage: test-binary.sh dist/tube-stop-linux-amd64
set -euo pipefail

binary=$(realpath "${1:?usage: test-binary.sh <binary>}")
scripts=$(dirname "$(realpath "$0")")
port=18080

cd "$(mktemp -d)"
DATA_DIR=./data MEDIA_DIR=./media CACHE_DIR=./cache HOST=127.0.0.1 PORT=$port YTDLP_BIN=true \
    "$binary" >log 2>&1 &
app=$!
trap 'kill $app 2>/dev/null || true' EXIT

if ! "$scripts/smoke-test.sh" "http://127.0.0.1:$port"; then
    cat log
    exit 1
fi
