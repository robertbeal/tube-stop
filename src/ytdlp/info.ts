import type { Channel, Video, VideoId } from "./types.ts";

/** What `yt-dlp -J` prints for a video, channel or playlist. Every field may be missing. */
export interface Info {
  _type?: string;
  id?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  channel_id?: string;
  duration?: number;
  timestamp?: number;
  upload_date?: string;
  entries?: Info[];
}

/** The one way to make a `VideoId`: anything that is not a YouTube video id gives undefined. */
export function parseVideoId(value: string | undefined): VideoId | undefined {
  const pattern = /^[A-Za-z0-9_-]{11}$/;

  return value !== undefined && pattern.test(value) ? (value as VideoId) : undefined;
}

function publishedAt(info: Info): number {
  const uploadDate = info.upload_date?.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3") ?? "";
  return Math.trunc(info.timestamp || Date.parse(uploadDate) / 1000) || 0;
}

/** The video, or undefined when yt-dlp gave no valid YouTube video id. */
export function toVideo(info: Info): Video | undefined {
  const id = parseVideoId(info.id);
  if (id === undefined) {
    return undefined;
  }
  return {
    id,
    title: info.title ?? "",
    channel: {
      id: info.channel_id ?? "",
      name: info.channel || info.uploader || "",
    },
    duration: Math.trunc(info.duration ?? 0),
    publishedAt: publishedAt(info),
  };
}

export function toChannel(info: Info): Channel {
  const id = info.channel_id || info.entries?.[0]?.channel_id || "";

  if (id === "") {
    throw new Error("could not determine channel from URL");
  }

  const name = info.channel || info.uploader || (info.title ?? "").replace(/ - Videos$/, "");
  return { id, name };
}
