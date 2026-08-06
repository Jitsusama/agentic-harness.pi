/**
 * Reading back what a reviewer wrote down as it went.
 *
 * A module of its own for the same reason the watchdog is one: two
 * readers of this file would decide differently about it, and the
 * second reader is not hypothetical. The supervisor folds the journal
 * into its result while the run is still its own; a round collected
 * afterwards has to read the same file with no supervisor left to ask,
 * because the case the journal exists for is precisely the one where
 * the supervisor died before writing anything.
 *
 * Pure, and takes the text rather than the path, so what it decides
 * can be tested without a filesystem and cannot drift between the two
 * callers.
 */

/**
 * How much a reviewer may record, and how big one entry may be.
 *
 * The journal is the one channel a reviewer controls that no other cap
 * touches: the stream has a line cap and the answer has a text cap,
 * and a file read straight off disk has neither. A finding is a
 * paragraph, so 64 KB is generous for one and a hundred is more than
 * any reviewer has ever raised. Whatever is refused stays on disk and
 * the warning says where, so this bounds what travels rather than what
 * is kept, which is the only reason refusing anything here is
 * acceptable at all.
 *
 * Counted in bytes, since a string's length is UTF-16 units and a cap
 * that means one thing for prose and another for anything else is not
 * a cap.
 */
export const MAX_JOURNAL_ENTRY_BYTES = 64 * 1024;

/** How many recorded findings are carried back from one reviewer. */
export const MAX_JOURNAL_ENTRIES = 100;

/** The opening words of anything said about the journal. */
export const JOURNAL_SAYS = "Recorded findings:";

/**
 * Parse a journal file's text into the entries it holds.
 *
 * One JSON object per line, and a line that will not parse costs that
 * line alone: a reviewer killed mid-write leaves a half-written last
 * line, and everything above it is intact and paid for. Dropping the
 * lot over the line the kill landed on would give up exactly what this
 * file exists to keep.
 *
 * Returns the counts as well as the entries, so a caller can say what
 * was left behind rather than quietly returning less than it read.
 */
export function parseJournal(raw) {
	const entries = [];
	let dropped = 0;
	let tooBig = 0;
	let tooMany = 0;
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		if (Buffer.byteLength(line, "utf-8") > MAX_JOURNAL_ENTRY_BYTES) {
			tooBig += 1;
			continue;
		}
		if (entries.length >= MAX_JOURNAL_ENTRIES) {
			tooMany += 1;
			continue;
		}
		try {
			entries.push(JSON.parse(line));
		} catch {
			dropped += 1;
		}
	}
	return { entries, dropped, tooBig, tooMany };
}

/**
 * What to say about the entries a parse could not carry.
 *
 * Each names where the file still is, because every one of these is a
 * finding somebody paid for that is not going to appear in the round.
 */
export function journalWarnings(counts, path) {
	const said = [];
	if (counts.dropped > 0) {
		said.push(
			`${JOURNAL_SAYS} ${counts.dropped} could not be read back, most likely written as the reviewer was stopped`,
		);
	}
	if (counts.tooBig > 0) {
		said.push(
			`${JOURNAL_SAYS} ${counts.tooBig} were larger than ${MAX_JOURNAL_ENTRY_BYTES} bytes and were left behind; they are still at ${path}`,
		);
	}
	if (counts.tooMany > 0) {
		said.push(
			`${JOURNAL_SAYS} ${counts.tooMany} arrived past the limit of ${MAX_JOURNAL_ENTRIES} and were left behind; they are still at ${path}`,
		);
	}
	return said;
}
