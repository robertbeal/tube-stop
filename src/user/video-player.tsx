import type { FC } from "hono/jsx";
import type { Video } from "../shared/db/types.ts";

const speeds = [0.5, 0.75, 1, 1.25, 1.5];

type IconProps = { path: string; class?: string };

const Icon: FC<IconProps> = ({ path, class: className }) => (
    <svg class={className} viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false">
        <path fill="currentColor" d={path} />
    </svg>
);

const backPath = "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z";
const playPath = "M8 5v14l11-7z";
const pausePath = "M6 19h4V5H6v14zm8-14v14h4V5h-4z";
const replayPath =
    "M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z";
const settingsPath =
    "M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z";
const enterFullscreenPath = "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z";
const exitFullscreenPath = "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z";

const SkipIcon: FC<{ forward: boolean }> = ({ forward }) => (
    <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true" focusable="false">
        <g transform={forward ? "translate(24 0) scale(-1 1)" : undefined}>
            <path fill="currentColor" d={replayPath} />
        </g>
        <text x="12" y="17" font-size="8" font-weight="bold" text-anchor="middle" fill="currentColor">
            10
        </text>
    </svg>
);

/**
 * The video and its controls. The browser's own controls are replaced by these (the script removes the
 * `controls` attribute), so that speed, looping and full screen can live inside the player. Every control is
 * a real button or input with a spoken name, so screen readers and keyboards keep working. Without the
 * script, the browser's own controls are left in place.
 */
export const Player: FC<{ video: Video; ready: boolean; posterUrl: string; sourceUrl: string }> = ({
    video,
    ready,
    posterUrl,
    sourceUrl,
}) => (
    <div id="player" class="player" role="region" aria-label={`Video player: ${video.title}`}>
        <video
            id="v"
            poster={posterUrl}
            src={ready ? sourceUrl : undefined}
            data-id={video.youtubeId}
            data-ready={String(ready)}
            controls
            playsinline
            preload="metadata"
        />
        <div id="surface" class="player-surface" aria-hidden="true" />

        <div id="controls" class="player-controls" hidden>
            <a id="overlayBack" class="player-button player-back" href="/" aria-label="Back to videos">
                <Icon path={backPath} />
                <span aria-hidden="true">Videos</span>
            </a>

            <div id="transport" class="player-transport" inert={!ready}>
                <div class="player-center">
                    <button
                        id="skipBack"
                        type="button"
                        class="player-button player-button-large"
                        aria-label="Back 10 seconds"
                    >
                        <SkipIcon forward={false} />
                    </button>
                    <button id="playPause" type="button" class="player-button player-button-xlarge" aria-label="Play">
                        <Icon class="icon-play" path={playPath} />
                        <Icon class="icon-pause" path={pausePath} />
                        <Icon class="icon-replay" path={replayPath} />
                    </button>
                    <button
                        id="skipForward"
                        type="button"
                        class="player-button player-button-large"
                        aria-label="Forward 10 seconds"
                    >
                        <SkipIcon forward={true} />
                    </button>
                </div>

                <div class="player-bar">
                    <span id="elapsed" class="player-time" aria-hidden="true">
                        0:00
                    </span>
                    <div id="seekTrack" class="player-seek-track">
                        <input
                            id="seek"
                            class="player-seek"
                            type="range"
                            min="0"
                            max="0"
                            step="1"
                            value="0"
                            aria-label="Seek"
                        />
                    </div>
                    <span id="duration" class="player-time" aria-hidden="true">
                        0:00
                    </span>
                    <button
                        id="settingsButton"
                        type="button"
                        class="player-button"
                        aria-label="Speed and loop"
                        aria-expanded="false"
                        aria-controls="settings"
                    >
                        <Icon path={settingsPath} />
                    </button>
                    <button id="fullscreenButton" type="button" class="player-button" aria-label="Full screen">
                        <Icon class="icon-enter" path={enterFullscreenPath} />
                        <Icon class="icon-exit" path={exitFullscreenPath} />
                    </button>
                </div>
            </div>
        </div>

        <div id="settings" class="player-settings" role="group" aria-label="Speed and loop" hidden>
            <fieldset class="mb-3">
                <legend class="h6">Speed</legend>
                <div class="d-flex flex-wrap gap-2">
                    {speeds.map((speed) => (
                        <>
                            <input
                                type="radio"
                                class="btn-check"
                                name="speed"
                                id={`speed-${speed}`}
                                value={String(speed)}
                                checked={speed === 1}
                            />
                            <label class="btn btn-outline-light btn-lg" for={`speed-${speed}`}>
                                {speed}×
                            </label>
                        </>
                    ))}
                </div>
            </fieldset>
            <fieldset>
                <legend class="h6">Loop a section</legend>
                <div class="d-flex flex-wrap gap-2 align-items-center">
                    <button id="markA" type="button" class="btn btn-outline-light btn-lg">
                        Set start
                    </button>
                    <button id="markB" type="button" class="btn btn-outline-light btn-lg">
                        Set end
                    </button>
                    <button
                        id="loopToggle"
                        type="button"
                        class="btn btn-outline-light btn-lg"
                        aria-pressed="false"
                        disabled
                    >
                        Loop
                    </button>
                    <button id="clearLoop" type="button" class="btn btn-outline-light btn-lg">
                        Clear
                    </button>
                    <span id="loopInfo" class="text-white-50" />
                </div>
            </fieldset>
        </div>

        <div id="wait" class="alert alert-info player-message" role="status" hidden={ready}>
            <span class="spinner-border spinner-border-sm me-2" aria-hidden="true" />
            Getting this video ready… it will start by itself.
        </div>
        <div id="fail" class="alert alert-danger player-message" role="alert" hidden>
            Something went wrong getting this video.{" "}
            <a href="#" id="retry" class="alert-link">
                Try again
            </a>
        </div>
        <div id="offline-fail" class="alert alert-secondary player-message" role="alert" hidden>
            📌 This video isn't pinned. Pin it at home to watch it anywhere.
        </div>
        <div id="announce" class="visually-hidden" role="status" aria-live="polite" />
    </div>
);
