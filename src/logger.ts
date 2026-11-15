function line(level: string, message: string): string {
    return `${new Date().toISOString()} ${level} ${message}`;
}

export const logger = {
    /** Something that happened and is worth knowing about. */
    info(message: string): void {
        console.log(line("INFO", message));
    },

    /** Something that failed. Goes to stderr. */
    error(message: string): void {
        console.error(line("ERROR", message));
    },
};
