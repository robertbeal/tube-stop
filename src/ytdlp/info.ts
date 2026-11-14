import type { Channel, Video } from "./types.ts";

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

function publishedAt(info: Info): number {
  const uploadDate = info.upload_date?.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3") ?? "";
  return Math.trunc(info.timestamp || Date.parse(uploadDate) / 1000) || 0;
}

export function toVideo(info: Info): Video {
  return {
    id: info.id ?? "",
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
