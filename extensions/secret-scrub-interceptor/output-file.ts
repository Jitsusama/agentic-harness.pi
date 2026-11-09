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
 *
 * A shared host's bash is pi-durable's, which spills to a file of its own
 * in a private folder it makes in the temporary folder, and names it in
 * the structured answer rather than the details. Both are recognised.
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

/** How pi-durable names its spill: `pi-output-<uuid>.log`. */
const DURABLE_OUTPUT_FILE =
	/^pi-output-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.log$/;

/** The folder pi-durable makes for each spill with `mkdtemp("tmp-")`. */
const DURABLE_OUTPUT_FOLDER = /^tmp-[A-Za-z0-9]{6}$/;

/**
 * The largest file read whole. Scrubbing takes about a millisecond for
 * each 50 KB, so this bounds the wait to well under two seconds; a larger
 * output is left as it is rather than holding the answer back.
 */
const MOST_BYTES = 64 * 1024 * 1024;

/**
 * The output file a tool's details or structured answer name, when it is
 * one pi or pi-durable saved: in the temporary folder, or pi-durable's own
 * folder directly in it, and named as they name them, so no other file a
 * tool names is ever rewritten.
 */
export function savedOutputFile(
	naming: unknown,
	folder: string = tmpdir(),
): string | undefined {
	if (!isRecord(naming)) return undefined;
	const named = naming.fullOutputPath;
	if (typeof named !== "string") return undefined;
	const file = resolve(named);
	const root = resolve(folder);
	const parent = dirname(file);
	if (parent === root)
		return PI_OUTPUT_FILE.test(basename(file)) ? file : undefined;
	const durable =
		dirname(parent) === root &&
		DURABLE_OUTPUT_FOLDER.test(basename(parent)) &&
		DURABLE_OUTPUT_FILE.test(basename(file));
	return durable ? file : undefined;
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
