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
 * The variable the supervisor names the journal file in.
 *
 * The one word a supervisor and a pack in different processes have to
 * agree on with nothing between them: the supervisor sets it on the
 * child's environment and the pack reads it back. Spelled differently
 * on the two sides, the pack finds nothing, records nothing, says
 * nothing, and every recovery path resting on the journal quietly
 * returns an empty review.
 */
export const JOURNAL_PATH_VAR = "SUBAGENT_JOURNAL_PATH";

/**
 * The tool a reviewer records a finding with.
 *
 * Here rather than beside the other tool names because this is the
 * side that has to match the pack, and the pack should be able to
 * learn its own name without importing the dispatcher that permits
 * it. Pi's `--tools` flag is an allowlist that covers extension tools,
 * so a roster naming a palette must include this or the reviewer is
 * denied the one tool its contract tells it to call.
 */
export const JOURNAL_TOOL_NAME = "record_finding";

/**
 * Where the pack providing that tool lives, relative to the repo.
 *
 * One fact in two halves with the name above: a caller loads this file
 * and then permits that tool, and a rename moving one without the
 * other leaves a reviewer told to call something nothing registered.
 */
export const JOURNAL_PACK_PATH = "packs/review-journal/index.ts";

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
