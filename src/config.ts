export interface Config {
    host: string;
    port: number;
    dataDir: string;
    mediaDir: string;
    cacheDir: string;
    ytdlpBin: string;
    keepMaxHeight: number;
    cacheTtlMs: number;
    cacheMaxBytes: number;
    syncIntervalMs: number;
    sessionLifetimeMs: number;
}

type Parsed<Value> = { ok: true; value: Value } | { ok: false; problem: string };

const millisecondsPerDay = 24 * 60 * 60 * 1000;
const bytesPerGigabyte = 2 ** 30;
const maxSessionDays = 400; // browsers refuse cookies that last longer

const unitMilliseconds: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

function positiveInteger(raw: string): number | undefined {
    const number = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function positiveNumber(raw: string): number | undefined {
    const number = raw.trim() === "" ? Number.NaN : Number(raw);
    return Number.isFinite(number) && number > 0 ? number : undefined;
}

function port(raw: string): number | undefined {
    const number = positiveInteger(raw);
    return number !== undefined && number <= 65535 ? number : undefined;
}

function sessionDays(raw: string): number | undefined {
    const number = positiveInteger(raw);
    return number !== undefined && number <= maxSessionDays ? number : undefined;
}

/** Parses durations such as "30m", "1h" or "1h30m". Returns milliseconds. */
export function parseDuration(raw: string): number | undefined {
    const pieces = [...raw.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
    if (pieces.length === 0 || pieces.map((piece) => piece[0]).join("") !== raw) {
        return undefined;
    }
    const total = pieces.reduce((sum, piece) => sum + Number(piece[1]) * (unitMilliseconds[piece[2] ?? ""] ?? 0), 0);
    return total > 0 ? total : undefined;
}

function setting<Value>(
    env: Record<string, string | undefined>,
    key: string,
    fallback: string,
    want: string,
    parse: (raw: string) => Value | undefined,
): Parsed<Value> {
    const raw = env[key] || fallback;
    const value = parse(raw);
    return value === undefined ? { ok: false, problem: `${key}: want ${want}, got "${raw}"` } : { ok: true, value };
}

function text(env: Record<string, string | undefined>, key: string, fallback: string): Parsed<string> {
    return { ok: true, value: env[key] || fallback };
}

function unwrap<Value>(parsed: Parsed<Value>): Value {
    if (!parsed.ok) {
        throw new Error(parsed.problem);
    }
    return parsed.value;
}

/**
 * Reads settings from the environment. Every invalid value is reported together, so a typo
 * fails startup instead of silently becoming a default.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
    const host = text(env, "HOST", "0.0.0.0");
    const portNumber = setting(env, "PORT", "8080", "a port number between 1 and 65535", port);
    const dataDir = text(env, "DATA_DIR", "./data");
    const mediaDir = text(env, "MEDIA_DIR", "./media");
    const cacheDir = text(env, "CACHE_DIR", "./cache");
    const ytdlpBin = text(env, "YTDLP_BIN", "yt-dlp");
    const keepMaxHeight = setting(env, "KEEP_MAX_HEIGHT", "1080", "a positive whole number of pixels", positiveInteger);
    const sessionLifetimeDays = setting(
        env,
        "ADMIN_SESSION_DAYS",
        "30",
        `a whole number of days between 1 and ${maxSessionDays}`,
        sessionDays,
    );
    const cacheTtlDays = setting(env, "CACHE_TTL_DAYS", "7", "a positive whole number of days", positiveInteger);
    const cacheMaxGigabytes = setting(env, "CACHE_MAX_GB", "20", "a positive number of gigabytes", positiveNumber);
    const syncIntervalMs = setting(env, "SYNC_INTERVAL", "1h", "a positive duration such as 30m or 1h", parseDuration);

    const problems = [
        portNumber,
        keepMaxHeight,
        sessionLifetimeDays,
        cacheTtlDays,
        cacheMaxGigabytes,
        syncIntervalMs,
    ].flatMap((parsed) => (parsed.ok ? [] : [parsed.problem]));
    if (problems.length > 0) {
        throw new Error(problems.join("\n"));
    }

    return {
        host: unwrap(host),
        port: unwrap(portNumber),
        dataDir: unwrap(dataDir),
        mediaDir: unwrap(mediaDir),
        cacheDir: unwrap(cacheDir),
        ytdlpBin: unwrap(ytdlpBin),
        keepMaxHeight: unwrap(keepMaxHeight),
        cacheTtlMs: unwrap(cacheTtlDays) * millisecondsPerDay,
        cacheMaxBytes: Math.floor(unwrap(cacheMaxGigabytes) * bytesPerGigabyte),
        syncIntervalMs: unwrap(syncIntervalMs),
        sessionLifetimeMs: unwrap(sessionLifetimeDays) * millisecondsPerDay,
    };
}
