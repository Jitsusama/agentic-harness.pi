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
 *
 * A command that fails by throwing, as one that times out or is stopped,
 * answers with its error's words alone, which name the file in their text
 * rather than in details; so the text is read for it too.
 *
 * The secret-scrub extension and a host's tool round both scrub it, so a
 * hosted conversation that loads no extension leaves no raw spill either.
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
import { isRecord } from "../record.ts";
import {
	type ScrubOptions,
	scrubOptionsOf,
	scrubSecrets,
	type ToolAnswer,
} from "./secrets.ts";

/** How pi names the files it saves output to: `pi-bash-<hex>.log` and its kin. */
const PI_OUTPUT_FILE = /^pi-[a-z]+-[0-9a-f]+\.log$/;

/** How pi-durable names its spill: `pi-output-<uuid>.log`. */
const DURABLE_OUTPUT_FILE =
	/^pi-output-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.log$/;

/**
 * How pi's text names the file it saved, in the trailer it ends a cut
 * output with: `[Showing lines 1-2000 of 9000. Full output: <path>]`.
 */
const NAMED_IN_TEXT = /\[Showing [^\]\n]*Full output: ([^\]\n]+)\]/g;

/** The folder pi-durable makes for each spill with `mkdtemp("tmp-")`. */
const DURABLE_OUTPUT_FOLDER = /^tmp-[A-Za-z0-9]{6}$/;

/**
 * The largest file read whole. Scrubbing takes about a millisecond for
 * each 50 KB, so this bounds the wait to well under two seconds; a larger
 * output is left as it is rather than holding the answer back.
 */
const MOST_BYTES = 64 * 1024 * 1024;

/**
 * Scrubs the files a tool's answer says its whole output was saved to,
 * pi's in the details or pi-durable's in the structured answer, or, when
 * the call failed, either named in its text, read as the call's input says (a printing of the
 * environment as one), and says which kinds it found. Call it once the
 * call has settled, never for a streamed update, since the file may
 * still be written.
 */
export function scrubSavedOutput(
	answer: ToolAnswer<unknown, unknown, unknown>,
	input: unknown,
	folder: string = tmpdir(),
): readonly string[] {
	const options = scrubOptionsOf(input);
	const files = new Set([
		...[answer.details, answer.structuredContent].map((naming) =>
			savedOutputFile(naming, folder),
		),
		// Only a failure loses the details, so only a failure's text is read:
		// any other answer's text may quote a trailer it never wrote.
		...(answer.isError === true ? (answer.content ?? []) : []).flatMap((part) =>
			savedOutputFilesIn(part, folder),
		),
	]);
	const kinds: string[] = [];
	for (const file of files) {
		if (file) kinds.push(...scrubOutputFile(file, options));
	}
	return kinds;
}

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
	return savedOutputPath(named, folder);
}

/**
 * The saved output file a part of an answer names in its text: only the
 * last trailer, the one pi wrote, so an output quoting older trailers
 * has no other file rewritten.
 */
function savedOutputFilesIn(part: unknown, folder: string): string[] {
	if (!isRecord(part) || typeof part.text !== "string") return [];
	const named = [...part.text.matchAll(NAMED_IN_TEXT)].at(-1)?.[1];
	const file = named ? savedOutputPath(named, folder) : undefined;
	return file ? [file] : [];
}

/** `named`, when it is a file pi or pi-durable saved as they name them. */
function savedOutputPath(named: string, folder: string): string | undefined {
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
 * that is gone, too large or unreadable is left alone. A command's
 * printing of the environment is read as one, as `options` says.
 */
export function scrubOutputFile(
	file: string,
	options: ScrubOptions = {},
): readonly string[] {
	try {
		const { size, mode } = statSync(file);
		if (size > MOST_BYTES) return [];
		const { text, kinds } = scrubSecrets(
			readFileSync(file, "utf8"),
			undefined,
			options,
		);
		if (kinds.length === 0) return [];
		const staged = `${file}.scrubbing`;
		try {
			// Made afresh, never through a file or link already at that name
			// in the shared temporary folder.
			rmSync(staged, { force: true });
			writeFileSync(staged, text, { mode: 0o600, flag: "wx" });
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
