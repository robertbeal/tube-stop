import type { LoginLimiter, Sessions, SetupCode } from "../admin/auth.ts";
import type { PasswordHasher } from "../admin/passwords.ts";

export type AppOptions = {
    /** Hashes and checks admin passwords; bcrypt at its default cost if omitted. */
    hasher?: PasswordHasher;
    /** How long an admin login lasts; `config.sessionLifetimeMs` if omitted. */
    sessionLifetimeMs?: number;
};

/** The options with defaults filled in, plus the state the web layer keeps itself. */
export type Services = Required<AppOptions> & {
    sessions: Sessions;
    limiter: LoginLimiter;
    setupCode: SetupCode;
};
