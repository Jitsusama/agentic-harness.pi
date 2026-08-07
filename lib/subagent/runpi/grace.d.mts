/**
 * Types for the shared stdio grace.
 *
 * The value is plain `.mjs` because the supervisor script is run
 * directly by node and cannot import TypeScript. Its other reader is
 * TypeScript, and a number taken as `any` would let the two sides
 * agree at runtime and part company in the types, which is the same
 * drift this constant exists to close.
 */

/** How long a departed process gets to flush its pipes. */
export const STDIO_GRACE_MS: number;
