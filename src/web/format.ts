/** Formats a length in seconds as m:ss or h:mm:ss. Empty when unknown. */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) {
    return "";
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(remainder)}` : `${minutes}:${pad(remainder)}`;
}

/** Formats a size in IEC units with one decimal, such as "1.5 KiB". */
export function humanBytes(byteCount: number): string {
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  if (byteCount < 1024) {
    return `${byteCount} B`;
  }
  const exponent = Math.min(Math.floor(Math.log(byteCount) / Math.log(1024)), units.length);
  return `${(byteCount / 1024 ** exponent).toFixed(1)} ${units[exponent - 1]}`;
}

function pluralAgo(count: number, unit: string): string {
  return count === 1 ? `1 ${unit} ago` : `${count} ${unit}s ago`;
}

/**
 * Describes how long before `nowMs` a unix time (seconds) was, in the largest sensible unit:
 * "never" for 0, then "just now", "5 minutes ago", "3 hours ago", "2 days ago".
 */
export function timeAgo(nowMs: number, unixSeconds: number): string {
  if (unixSeconds === 0) {
    return "never";
  }
  const elapsedSeconds = (nowMs - unixSeconds * 1000) / 1000;
  if (elapsedSeconds < 60) {
    return "just now"; // includes times slightly in the future from clock differences
  }
  if (elapsedSeconds < 3600) {
    return pluralAgo(Math.floor(elapsedSeconds / 60), "minute");
  }
  if (elapsedSeconds < 86400) {
    return pluralAgo(Math.floor(elapsedSeconds / 3600), "hour");
  }
  return pluralAgo(Math.floor(elapsedSeconds / 86400), "day");
}
