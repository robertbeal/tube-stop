import type { VideoId } from "../ytdlp/types.ts";

export type Status = "none" | "queued" | "downloading" | "ready" | "failed";

/** How a video's visibility is decided: allowed on its own, blocked, or following its channel. */
export type Rule = "allow" | "block" | "inherit";

export type Channel = {
    id: number;
    youtubeId: string;
    name: string;
    /** Unix seconds, 0 if never synced. */
    lastSyncedAt: number;
    /** Videos known for the channel that are not blocked. */
    videoCount: number;
};

export type Video = {
    youtubeId: VideoId;
    channelYoutubeId: string;
    channelName: string;
    title: string;
    duration: number;
    rule: Rule;
    pinned: boolean;
    /** The pinned (kept) copy. */
    filePath: string;
    downloadStatus: Status;
    downloadError: string;
    /** The temporary watch-once copy. */
    cacheStatus: Status;
    cachePath: string;
    cacheError: string;
    lastPlayedAt: number;
    playCount: number;
    /** Unix seconds, 0 if unknown. */
    publishedAt: number;
    /** The video's channel is currently allowed. */
    channelAllowed: boolean;
    /** The child may watch it: explicitly allowed, or inheriting from an allowed channel. */
    watchable: boolean;
};

/** What is known about a video when it is first added. */
export type NewVideo = {
    youtubeId: VideoId;
    channelYoutubeId: string;
    channelName: string;
    title: string;
    duration: number;
    publishedAt: number;
};

export type User = {
    id: number;
    username: string;
    passwordHash: string;
};

/** A window of a list: `limit` rows starting after `offset` rows. */
export type Page = {
    limit: number;
    offset: number;
};

export type VideoPage = {
    videos: Video[];
    total: number;
};

/** Describes what removing a video did, so the caller can delete the files. */
export type Removal = {
    filePath: string;
    cachePath: string;
    /**
     * True when the video was kept as blocked instead of deleted. That happens for videos of an
     * allowed channel, which a later sync would otherwise add back.
     */
    blocked: boolean;
};

export class NotFoundError extends Error {
    constructor() {
        super("not found");
    }
}

export class AlreadySetUpError extends Error {
    constructor() {
        super("an admin account already exists");
    }
}
