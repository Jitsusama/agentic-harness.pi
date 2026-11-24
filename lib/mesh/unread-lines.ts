/**
 * Telling a listing in a shape this harness can't read from one that
 * lists nothing. The node's listings are a JSON line a row, and a reader
 * skips a line it can't read, so a listing every line of which it skips
 * would otherwise read as empty: "nothing waits" said of what was never
 * read.
 */

/**
 * The first line of `listing` when it holds lines and none `reads`, so
 * the listing is in a shape the reader can't read; nothing when any line
 * reads, or it holds none.
 */
export function firstUnread(
	listing: string,
	reads: (line: string) => boolean,
): string | undefined {
	const lines = listing.split("\n").filter((line) => line.trim() !== "");
	return lines.length > 0 && !lines.some(reads) ? lines[0] : undefined;
}
