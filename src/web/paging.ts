import type { Page, Video, VideoPage } from "../db/store.ts";

export const kidPageSize = 24; // few, large choices suit a young child
export const adminPageSize = 100; // the admin list is for scanning
const maxPageNumber = 1_000_000;

/** One page of a longer list, for the views. */
export interface Pagination {
    number: number;
    /** 1-based positions of the first and last video shown; 0 when the list is empty. */
    from: number;
    to: number;
    total: number;
    /** Empty when this is the first page. */
    previousUrl: string;
    /** Empty when this is the last page. */
    nextUrl: string;
}

/** Reads the page number from a query value; anything invalid means page 1. */
export function requestedPage(raw: string | undefined): number {
    const number = /^\d+$/.test(raw ?? "") ? Number(raw) : 0;
    return number < 1 ? 1 : Math.min(number, maxPageNumber);
}

/**
 * Works out the page to show, given the page asked for and how many items there are in
 * total. Pages past the end are clamped to the last page. `link` builds the URL of another page.
 */
export function paginate(requested: number, size: number, total: number, link: (page: number) => string): Pagination {
    const lastPage = Math.max(1, Math.ceil(total / size));
    const number = Math.min(Math.max(requested, 1), lastPage);
    return {
        number,
        from: total > 0 ? (number - 1) * size + 1 : 0,
        to: total > 0 ? Math.min(number * size, total) : 0,
        total,
        previousUrl: number > 1 ? link(number - 1) : "",
        nextUrl: number < lastPage ? link(number + 1) : "",
    };
}

/** Builds page URLs under `path`, keeping the channel filter. */
export function listLink(path: string, channel: string): (page: number) => string {
    return (page) => {
        const query = new URLSearchParams([
            ...(channel === "" ? [] : [["channel", channel] as [string, string]]),
            ...(page > 1 ? [["page", String(page)] as [string, string]] : []),
        ]).toString();
        return query === "" ? path : `${path}?${query}`;
    };
}

/** Fetches the requested page of a list, and fetches again if the page asked for turned out to be past the end. */
export function loadPage(
    fetchPage: (page: Page) => VideoPage,
    requested: number,
    size: number,
    link: (page: number) => string,
): { videos: Video[]; pages: Pagination } {
    const first = fetchPage({ limit: size, offset: (requested - 1) * size });
    const pages = paginate(requested, size, first.total, link);
    const videos =
        pages.number === requested
            ? first.videos
            : fetchPage({ limit: size, offset: (pages.number - 1) * size }).videos;
    return { videos, pages };
}
