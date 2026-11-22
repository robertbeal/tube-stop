// Files imported with `with { type: "file" }` give their path, which Bun.file() reads from disk or from a compiled binary.
declare module "*.css" {
    const path: string;
    export default path;
}

declare module "*.js" {
    const path: string;
    export default path;
}

declare module "*.png" {
    const path: string;
    export default path;
}
