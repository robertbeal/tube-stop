function line(level: string, message: string): string {
    return `${new Date().toISOString()} ${level} ${message}`;
}

/** Something that happened and is worth knowing about. */
export function logInfo(message: string): void {
    console.log(line("INFO", message));
}

/** Something that failed. Goes to stderr. */
export function logError(message: string): void {
    console.error(line("ERROR", message));
}
