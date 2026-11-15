#!/usr/bin/env bash
# Decides what a run of the release workflow does, and prints it as KEY=VALUE lines.
#
#   EVENT   what started the run (push, schedule or workflow_dispatch)
#   IMAGE   the image name, such as ghcr.io/owner/repo
#   YTDLP   the yt-dlp release to build with
#
# The version comes from the conventional commits since the last v* tag:
#   a feat or fix with ! (or any commit with a BREAKING CHANGE: line) -> major
#   feat -> minor, fix -> patch, anything else -> no new release
# A run with no new release rebuilds the current one with the newest yt-dlp, unless it was a push, or
# that image already exists.
set -euo pipefail

last=$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n 1)
range=${last:+$last..}HEAD
IFS=. read -r major minor patch <<<"${last#v}"
major=${major:-0} minor=${minor:-0} patch=${patch:-0}

subjects=$(git log "$range" --format=%s)
bodies=$(git log "$range" --format=%b)
if grep -Eq '^(feat|fix)(\([^)]*\))?!:' <<<"$subjects" || grep -Eq '^BREAKING[ -]CHANGE:' <<<"$bodies"; then
    bump=major
elif grep -Eq '^feat(\([^)]*\))?:' <<<"$subjects"; then
    bump=minor
elif grep -Eq '^fix(\([^)]*\))?:' <<<"$subjects"; then
    bump=patch
else
    bump=none
fi

case $bump in
    major) version="$((major + 1)).0.0" ;;
    minor) version="$major.$((minor + 1)).0" ;;
    patch) version="$major.$minor.$((patch + 1))" ;;
    none) version="${last#v}" ;;
esac

build=true
if [ "$bump" = none ]; then
    if [ -z "$last" ] || [ "$EVENT" = push ]; then
        build=false
    elif docker manifest inspect "$IMAGE:${version}_$YTDLP" >/dev/null 2>&1; then
        build=false
    fi
fi

tags="$IMAGE:${version}_$YTDLP,$IMAGE:$version,$IMAGE:${version%.*},$IMAGE:latest"
if [ "${version%%.*}" != 0 ]; then
    tags+=",$IMAGE:${version%%.*}"
fi

echo "build=$build"
echo "release=$([ "$bump" != none ] && echo true || echo false)"
echo "version=$version"
echo "tags=$tags"
