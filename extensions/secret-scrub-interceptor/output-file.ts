/**
 * The file pi saves a long command's whole output to, scrubbed as its
 * answer is.
 *
 * pi's bash keeps the end of a long output for the answer and writes all
 * of it to a file in the temporary folder, which the answer names in its
 * details. A credential cut from the answer's text was still in that file,
 * and so was one printed in the part the answer left out, for any
 * process running as the person to read. The file is closed before the
 * answer is handed on, so it can be rewritten here.
 */

import {
	chmodSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { isRecord } from "../../lib/internal/record.ts";
import { scrubSecrets } from "../../lib/internal/secrets.ts";

/** How pi names the files it saves output to: `pi-bash-<hex>.log` and its kin. */
const PI_OUTPUT_FILE = /^pi-[a-z]+-[0-9a-f]+\.log$/;

/**
 * The largest file read whole. Scrubbing takes about a millisecond for
 * each 50 KB, so this bounds the wait to well under two seconds; a larger
 * output is left as it is rather than holding the answer back.
 */
const MOST_BYTES = 64 * 1024 * 1024;

/**
 * The output file a tool's details name, when it is one pi saved: in the
 * temporary folder and named as pi names them, so no other file a tool
 * names is ever rewritten.
 */
export function savedOutputFile(
	details: unknown,
	folder: string = tmpdir(),
): string | undefined {
	if (!isRecord(details)) return undefined;
	const named = details.fullOutputPath;
	if (typeof named !== "string") return undefined;
	const file = resolve(named);
	if (dirname(file) !== resolve(folder)) return undefined;
	return PI_OUTPUT_FILE.test(basename(file)) ? file : undefined;
}

/**
 * Rewrites `file` with its credentials scrubbed, and says which kinds it
 * found. The new content is renamed over the old, so a reader sees one or
 * the other whole, and it keeps the owner-only mode pi gave it. A file
 * that is gone, too large or unreadable is left alone.
 */
export function scrubOutputFile(file: string): readonly string[] {
	try {
		const { size, mode } = statSync(file);
		if (size > MOST_BYTES) return [];
		const { text, kinds } = scrubSecrets(readFileSync(file, "utf8"));
		if (kinds.length === 0) return [];
		const staged = `${file}.scrubbing`;
		try {
			writeFileSync(staged, text, { mode: 0o600 });
			chmodSync(staged, mode & 0o777);
			renameSync(staged, file);
		} catch (error) {
			rmSync(staged, { force: true });
			throw error;
		}
		return kinds;
	} catch {
		// Output that can't be read or replaced is no worse than it was,
		// and failing here would cost the agent its answer.
		return [];
	}
}
