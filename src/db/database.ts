import { Database } from "bun:sqlite";
import { migrations } from "./schema.ts";

/** Opens (creating if needed) the database file and brings its schema up to date. */
export function openDatabase(path: string): Database {
    const database = new Database(path, { create: true, strict: true });
    database.run("PRAGMA busy_timeout = 5000");
    database.run("PRAGMA journal_mode = WAL");
    database.run("PRAGMA foreign_keys = ON");
    migrate(database);
    return database;
}

function migrate(database: Database): void {
    const row = database.query<{ user_version: number }, []>("PRAGMA user_version").get();
    const version = row?.user_version ?? 0;
    if (version > migrations.length) {
        throw new Error(`database schema version ${version} is newer than this build supports (${migrations.length})`);
    }
    migrations.slice(version).forEach((migration, index) => {
        const number = version + index + 1;
        database
            .transaction(() => {
                database.run(migration);
                database.run(`PRAGMA user_version = ${number}`);
            })
            .immediate();
    });
}
