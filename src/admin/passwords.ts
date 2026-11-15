export const minPasswordLength = 8;
/** bcrypt only uses the first 72 bytes, so longer passwords are refused rather than silently truncated. */
export const maxPasswordLength = 72;
/** Roughly a quarter of a second per hash: slow enough to make guessing expensive. */
export const defaultCost = 12;

const minCost = 4;
const maxCost = 31;

/** Thrown for a new password that does not meet the rules. The message is fit to show to the user. */
export class PasswordRuleError extends Error {}

/** Returns the problem with a new password, or undefined if it is acceptable. Length is counted in bytes. */
export function passwordProblem(password: string): string | undefined {
    const length = Buffer.byteLength(password);
    if (length < minPasswordLength) {
        return `password must be at least ${minPasswordLength} characters`;
    }
    if (length > maxPasswordLength) {
        return `password must be at most ${maxPasswordLength} bytes`;
    }
    return undefined;
}

function costOf(hash: string): number | undefined {
    const match = /^\$2[abxy]\$(\d\d)\$/.exec(hash);
    return match ? Number(match[1]) : undefined;
}

/** The settings for hashing admin passwords with bcrypt. Only the hash is ever stored. */
export interface PasswordHasher {
    cost: number;
    // A hash of a password nobody knows. Checking against it makes a login for a non-existent
    // user take as long as one with a wrong password.
    unknownUserHash: Promise<string>;
}

export function createPasswordHasher(cost: number = defaultCost): PasswordHasher {
    if (!Number.isInteger(cost) || cost < minCost || cost > maxCost) {
        throw new Error(`bcrypt cost ${cost} is outside ${minCost}-${maxCost}`);
    }
    return { cost, unknownUserHash: Bun.password.hash("a password nobody has", { algorithm: "bcrypt", cost }) };
}

export async function hashPassword(hasher: PasswordHasher, password: string): Promise<string> {
    const problem = passwordProblem(password);
    if (problem) {
        throw new PasswordRuleError(problem);
    }
    return Bun.password.hash(password, { algorithm: "bcrypt", cost: hasher.cost });
}

/**
 * A malformed hash never matches, and neither does a password longer than the maximum:
 * bcrypt would otherwise compare only its first 72 bytes.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
    if (Buffer.byteLength(password) > maxPasswordLength) {
        return false;
    }
    try {
        return await Bun.password.verify(password, hash);
    } catch {
        return false;
    }
}

/** Does the work of a failed check, so the time taken does not reveal whether a username exists. */
export async function spendTimeVerifying(hasher: PasswordHasher, password: string): Promise<void> {
    await verifyPassword(await hasher.unknownUserHash, password);
}

/** True when the hash was made at a lower cost than this hasher uses, or is malformed. */
export function needsUpgrade(hasher: PasswordHasher, hash: string): boolean {
    const cost = costOf(hash);
    return cost === undefined || cost < hasher.cost;
}
