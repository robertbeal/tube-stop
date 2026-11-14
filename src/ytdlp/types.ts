export interface Channel {
  id: string;
  name: string;
}

export interface Video {
  id: string;
  title: string;
  channel: Channel;
  /** Seconds. */
  duration: number;
  /** Upload time in unix seconds, or 0 if unknown. For channel listings it is approximate (accurate to the day). */
  publishedAt: number;
}

/** What a pasted URL points at. */
export type Resolved = Video | Channel;

/** A video is the one with a channel of its own; a channel is just an id and a name. */
export const isVideo = (resolved: Resolved): resolved is Video => "channel" in resolved;

export type ResolveUrl = (url: string, signal: AbortSignal) => Promise<Resolved>;

export type Download = (
  id: string,
  directory: string,
  maxHeight: number,
  signal: AbortSignal,
) => Promise<string>;
