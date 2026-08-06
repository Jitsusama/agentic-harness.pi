/**
 * Types for the journal reader.
 *
 * The reader itself is plain `.mjs`, because the supervisor script is
 * run directly by node and cannot import TypeScript. Its other caller
 * is TypeScript and should not have to take it as `any`: the whole
 * point of one reader is that both sides agree, and an untyped import
 * is how they would stop agreeing.
 */

/** The largest one recorded finding may be, in bytes. */
export const MAX_JOURNAL_ENTRY_BYTES: number;

/** How many recorded findings are carried back from one reviewer. */
export const MAX_JOURNAL_ENTRIES: number;

/** The opening words of anything said about the journal. */
export const JOURNAL_SAYS: string;

/** What one journal file turned out to hold. */
export interface JournalCounts {
	/** The entries that parsed, in the order they were written. */
	readonly entries: readonly unknown[];
	/** Lines that would not parse, usually the one a kill landed on. */
	readonly dropped: number;
	/** Lines refused for being larger than one finding should be. */
	readonly tooBig: number;
	/** Lines refused for arriving past the limit on entries. */
	readonly tooMany: number;
}

/** Parse a journal file's text into the entries it holds. */
export function parseJournal(raw: string): JournalCounts;

/** What to say about the entries a parse could not carry. */
export function journalWarnings(counts: JournalCounts, path: string): string[];
