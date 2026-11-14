import { join } from "node:path";
import { ytdlp } from "./run.ts";

/** Downloads a video to the path described by an output template and returns the path of the saved file. */
async function download(
  binary: string,
  id: string,
  template: string,
  maxHeight: number,
  signal: AbortSignal,
): Promise<string> {
  const format = `bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/b`;
  const output = await ytdlp(
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
  signal: AbortSignal,
): Promise<string> {
  const template =
    "%(channel,uploader|Unknown)s/%(upload_date>%Y-%m-%d|0000-00-00)s - %(title).150B [%(id)s].%(ext)s";

  return download(binary, id, join(directory, template), maxHeight, signal);
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
  signal: AbortSignal,
): Promise<string> {
  const template = "%(id)s.%(ext)s";

  return download(binary, id, join(directory, template), maxHeight, signal);
}
