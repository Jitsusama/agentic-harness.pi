import { createHash } from "node:crypto";

/**
 * A short, stable pointer to a piece of text, for the reduction and
 * demotion machinery that needs to name what it cut without keeping
 * the bytes. Not the ledger's own digest: `lib/ledger/scan.ts` computes
 * and persists its own, at its own length, and already has real,
 * live-stored rows keyed on it, so it is left alone rather than
 * unified with this one just because both call the same hash.
 */
const DEFAULT_CHARS = 16;

export function shortDigest(text: string, chars = DEFAULT_CHARS): string {
	return createHash("sha256").update(text).digest("hex").slice(0, chars);
}
