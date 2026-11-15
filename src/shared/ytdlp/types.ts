/** A YouTube video id: 11 characters from a URL-safe alphabet. It is safe to put in a file name or a URL. */
export type VideoId = string & { readonly brand: "VideoId" };

export type Channel = {
    id: string;
    name: string;
};

export type Video = {
    id: VideoId;
    title: string;
    channel: Channel;
    /** Seconds. */
    duration: number;
    /** Upload time in unix seconds, or 0 if unknown. For channel listings it is approximate (accurate to the day). */
    publishedAt: number;
};

/** What a pasted URL points at. */
export type Resolved = Video | Channel;

/** A video is the one with a channel of its own; a channel is just an id and a name. */
export const isVideo = (resolved: Resolved): resolved is Video => "channel" in resolved;
