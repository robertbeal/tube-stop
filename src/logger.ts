function line(level: string, message: string): string {
    return `${new Date().toISOString()} ${level} ${message}`;
}

export const logger = {
    info(message: string): void {
        console.log(line("INFO", message));
    },

    error(message: string): void {
        console.error(line("ERROR", message));
    },
};
