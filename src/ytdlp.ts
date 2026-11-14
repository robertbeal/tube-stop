import { join } from "node:path";

/** A video as described by yt-dlp. */
export interface ListedVideo {
  id: string;
  title: string;
  channelName: string;
  channelId: string;
  /** Seconds. */
  duration: number;
  /** Upload time in unix seconds, or 0 if unknown. For channel listings it is approximate (accurate to the day). */
  publishedAt: number;
}

/** What a pasted URL points at. */
export type Resolved =
  | { kind: "video"; video: ListedVideo }
  | { kind: "channel"; channelId: string; channelName: string };

export interface Resolver {
  resolve(url: string, signal?: AbortSignal): Promise<Resolved>;
}

export interface ChannelLister {
  listChannel(channelId: string, limit: number, signal?: AbortSignal): Promise<ListedVideo[]>;
}

export interface Fetcher {
  downloadToLibrary(id: string, directory: string, maxHeight: number, signal?: AbortSignal): Promise<string>;
  downloadToCache(id: string, directory: string, maxHeight: number, signal?: AbortSignal): Promise<string>;
}

interface YtDlpResponse {
  _type?: string;
  id?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  channel_id?: string;
  duration?: number;
  timestamp?: number;
  upload_date?: string;
  entries?: YtDlpResponse[];
}

const libraryLayout =
  "%(channel,uploader|Unknown)s/%(upload_date>%Y-%m-%d|0000-00-00)s - %(title).150B [%(id)s].%(ext)s";
const cacheLayout = "%(id)s.%(ext)s";

const stderrTail = 500;

function publishedAt(response: YtDlpResponse): number {
  if (typeof response.timestamp === "number" && response.timestamp > 0) {
    return Math.trunc(response.timestamp);
  }
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(response.upload_date ?? "");
  if (date === null) {
    return 0;
  }
  const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const valid =
    parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  return valid ? Math.floor(parsed.getTime() / 1000) : 0;
}

function toVideo(response: YtDlpResponse): ListedVideo {
  return {
    id: response.id ?? "",
    title: response.title ?? "",
    channelName: response.channel || response.uploader || "",
    channelId: response.channel_id ?? "",
    duration: Math.trunc(response.duration ?? 0),
    publishedAt: publishedAt(response),
  };
}

function toChannel(response: YtDlpResponse): Resolved {
  const channelId = response.channel_id || response.entries?.[0]?.channel_id || "";
  if (channelId === "") {
    throw new Error("could not determine channel from URL");
  }
  const channelName =
    response.channel || response.uploader || (response.title ?? "").replace(/ - Videos$/, "");
  return { kind: "channel", channelId, channelName };
}

async function run(binary: string, args: string[], signal?: AbortSignal): Promise<string> {
  const process = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe", signal });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("yt-dlp: cancelled");
  }
  if (exitCode !== 0) {
    throw new Error(`yt-dlp: exited with code ${exitCode}: ${stderr.trim().slice(-stderrTail)}`);
  }
  return stdout;
}

/** Inspects a user-supplied URL: a single video, or a channel or playlist. */
export async function resolveUrl(binary: string, url: string, signal?: AbortSignal): Promise<Resolved> {
  const output = await run(
    binary,
    ["-J", "--flat-playlist", "--playlist-items", "1", "--no-warnings", "--", url],
    signal,
  );
  const response: YtDlpResponse = JSON.parse(output);
  if (response._type === "playlist") {
    return toChannel(response);
  }
  if (!response.id) {
    throw new Error("could not determine video from URL");
  }
  return { kind: "video", video: toVideo(response) };
}

/** Up to `limit` recent videos from a channel, newest first. */
export async function listChannel(
  binary: string,
  channelId: string,
  limit: number,
  signal?: AbortSignal,
): Promise<ListedVideo[]> {
  const output = await run(
    binary,
    [
      "-J",
      "--flat-playlist",
      "--no-warnings",
      "--extractor-args",
      "youtubetab:approximate_date",
      "--playlist-end",
      String(limit),
      `https://www.youtube.com/channel/${channelId}/videos`,
    ],
    signal,
  );
  const response: YtDlpResponse = JSON.parse(output);
  return (response.entries ?? [])
    .filter((entry) => entry.id)
    .map((entry) => ({ ...toVideo(entry), channelId: entry.channel_id || channelId }));
}

/** Downloads a video to the path described by an output template and returns the path of the saved file. */
async function download(
  binary: string,
  id: string,
  template: string,
  maxHeight: number,
  signal?: AbortSignal,
): Promise<string> {
  const format = `bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/b`;
  const output = await run(
    binary,
    [
      "--no-warnings",
      "--no-playlist",
      "--windows-filenames",
      "-f",
      format,
      "--merge-output-format",
      "mp4",
      "--write-thumbnail",
      "--convert-thumbnails",
      "jpg",
      "-o",
      template,
      "--no-simulate",
      "--print",
      "after_move:filepath",
      "--",
      id,
    ],
    signal,
  );
  const path = output.trim().split("\n").at(-1)?.trim() ?? "";
  if (path === "") {
    throw new Error("yt-dlp did not report an output file");
  }
  return path;
}

/**
 * Fetches a video into `directory`, organised by channel and date, and returns the path of
 * the saved file. A .jpg thumbnail is written next to it.
 */
export function downloadToLibrary(
  binary: string,
  id: string,
  directory: string,
  maxHeight: number,
  signal?: AbortSignal,
): Promise<string> {
  return download(binary, id, join(directory, libraryLayout), maxHeight, signal);
}

/**
 * Fetches a video into `directory`, named by its id, and returns the path of the saved
 * file. A .jpg thumbnail is written next to it.
 */
export function downloadToCache(
  binary: string,
  id: string,
  directory: string,
  maxHeight: number,
  signal?: AbortSignal,
): Promise<string> {
  return download(binary, id, join(directory, cacheLayout), maxHeight, signal);
}
