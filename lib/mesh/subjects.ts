/**
 * What a cell says it works on, so a need finds it by that.
 *
 * Mycelium's node serves each cell's `subjects` from its presence, and
 * need-route.ts reads them, but until this nothing wrote them, so no
 * subject had a holder and no hub formed (FZ9MFJ, 18 November). A cell's
 * subjects come from two places, as the routes note settled
 * (FZ9MFJ's routes-into-subjects.md, 17 November):
 *
 * - the owner lines in the machine's config, `prefix=ADDRESS`, the very
 *   values cadence takes as `--owner`, naming the address the cell signs
 *   with or its session's own: the prefix as written, longest first,
 *   since a longer prefix is the narrower subject and is never split at
 *   colons or dots here;
 * - its quest's own list, its README's `subjects` front matter.
 *
 * The owner lines are read from a file of them, one a line, which
 * cadence's home module writes from the same list it passes as
 * `--owner`, so the two can't differ. A missing file declares none.
 *
 * The node's rule is mycelium's `subjects()` in `src/networks/made.rs`:
 * each string trimmed, the first 12 of at most 120 characters (code
 * points, `chars().count()`) holding no control, direction mark, unseen
 * character or line or paragraph separator. The same rule is kept here,
 * refusing every format character rather than the node's named few, so
 * a subject this passes is one the node serves and a subject it would
 * pass over never takes one of the 12 places.
 *
 * A subject routes a need and grants nothing: a yes, a ruling or a grant
 * still comes only from the owner named by address.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The most subjects a cell declares, as mycelium's node reads them. */
export const MOST_SUBJECTS = 12;

/** The most characters one subject holds, as the node reads it. */
export const LONGEST_SUBJECT = 120;

/**
 * The largest owners file read: a line per prefix is a few kilobytes, so
 * anything past this is not one, and isn't read on every refresh.
 */
const LARGEST_OWNERS_FILE = 64 * 1024;

/** Where the owners file is, when the environment names another place. */
export const OWNERS_FILE_ENV = "PI_OWNERS_FILE";

/** The owners file under the config folder: cadence's, as it writes it. */
const OWNERS_UNDER_CONFIG = join("cadence", "owners.txt");

/**
 * What a terminal would not draw as plain text: controls, format
 * characters (direction marks, zero widths, the soft hyphen, tags, the
 * byte order mark), and line and paragraph separators. The node passes
 * over a subject holding any, so one is left out here before it takes a
 * place.
 */
const NOT_PLAIN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * A surrogate standing alone, with no partner to make a code point:
 * written into presence as an escape no Rust string can hold, so the
 * node could not read the presence at all.
 */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * The code points, first and last, the node counts as unseen that
 * aren't format characters: the grapheme joiner, the Hangul and Khmer
 * fillers, the variation selectors, Mongolian or not, and the code
 * points left unassigned among the invisible operators and the tags.
 * Ranges rather than a character class, since most are combining marks,
 * which a class would join to their neighbours.
 */
const UNSEEN: readonly (readonly [number, number])[] = [
	[0x034f, 0x034f],
	[0x115f, 0x1160],
	[0x17b4, 0x17b5],
	[0x180b, 0x180f],
	[0x2060, 0x2065],
	[0x3164, 0x3164],
	[0xfe00, 0xfe0f],
	[0xffa0, 0xffa0],
	[0xe0000, 0xe007f],
	[0xe0100, 0xe01ef],
];

/** Whether a character draws as nothing (see `UNSEEN`). */
function unseen(each: string): boolean {
	const point = each.codePointAt(0) ?? 0;
	return UNSEEN.some(([first, last]) => point >= first && point <= last);
}

/**
 * The owners file `env` names, else cadence's under the config folder:
 * `XDG_CONFIG_HOME` when it is absolute, as the XDG rules say, else
 * `.config` under the home folder. None when no home folder is known
 * as an absolute path, since `homedir()` itself gives back an empty
 * `HOME`, so the file is never looked for under the folder pi started in.
 */
export function ownersFile(env: NodeJS.ProcessEnv): string | undefined {
	const named = env[OWNERS_FILE_ENV];
	if (named) return named;
	const xdg = env.XDG_CONFIG_HOME;
	if (xdg && isAbsolute(xdg)) return join(xdg, OWNERS_UNDER_CONFIG);
	const home = env.HOME || homedir();
	if (!isAbsolute(home)) return undefined;
	return join(home, ".config", OWNERS_UNDER_CONFIG);
}

/**
 * The owner lines in `file`, each trimmed, the blank left out; none
 * when there is no file, it can't be read, or it isn't a plain file of a
 * few kilobytes, so a pipe or a device named there never stalls a
 * refresh. Read afresh each time, since a switch rewrites it.
 */
export function ownerLinesAt(file: string | undefined): string[] {
	if (file === undefined) return [];
	let text: string;
	try {
		text = readSmallFile(file);
	} catch {
		// No owners file on this machine, or not one we may read: the cell
		// declares no owned subjects, which is what it holds without one.
		return [];
	}
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

/**
 * The text of `file`, read only once it is known to be a regular file
 * no larger than `LARGEST_OWNERS_FILE`; it throws otherwise. Opened
 * first and checked through the descriptor, so what is checked is what
 * is read, and opened without blocking, so a pipe can't hold the open.
 * The read stops one byte past the limit, whatever the size said, so a
 * file that grew after the check, or claims none, is refused rather than
 * read in full.
 */
function readSmallFile(file: string): string {
	const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > LARGEST_OWNERS_FILE) {
			throw new Error(`${file} is not a small regular file`);
		}
		const buffer = Buffer.alloc(LARGEST_OWNERS_FILE + 1);
		let read = 0;
		for (;;) {
			const got = readSync(fd, buffer, read, buffer.length - read, null);
			if (got === 0) break;
			read += got;
			if (read > LARGEST_OWNERS_FILE) {
				throw new Error(`${file} grew past ${LARGEST_OWNERS_FILE} bytes`);
			}
		}
		return buffer.toString("utf8", 0, read);
	} finally {
		closeSync(fd);
	}
}

/**
 * The prefixes the owner lines name any of `addresses` for, each as
 * written, once, longest first and else in the order written. A line is
 * split at its first `=`, as cadence splits `--owner`; one with no `=`,
 * or nothing on either side, names nobody.
 */
export function ownedPrefixes(
	lines: readonly string[],
	addresses: readonly string[],
): string[] {
	const own = new Set(addresses);
	const owned: string[] = [];
	for (const line of lines) {
		const at = line.indexOf("=");
		if (at === -1) continue;
		const prefix = line.slice(0, at).trim();
		const address = line.slice(at + 1).trim();
		if (prefix === "" || !own.has(address) || owned.includes(prefix)) continue;
		owned.push(prefix);
	}
	// A stable sort, so prefixes as long stay in the order written.
	return owned.sort((a, b) => b.length - a.length);
}

/** The subjects a README's `subjects` lists, each trimmed; none else. */
export function declaredSubjects(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((one): one is string => typeof one === "string")
		.map((one) => one.trim())
		.filter((one) => one !== "");
}

/**
 * A cell's subjects: those it owns, then those its quest declares, each
 * once, passing over any the node would refuse, at most `MOST_SUBJECTS`.
 */
export function subjectsOf(
	owned: readonly string[],
	declared: readonly string[],
): string[] {
	const subjects: string[] = [];
	for (const subject of [...owned, ...declared]) {
		if (subjects.length === MOST_SUBJECTS) break;
		if (!isPlainSubject(subject) || subjects.includes(subject)) continue;
		subjects.push(subject);
	}
	return subjects;
}

/** Whether a subject is one the node serves: short, and plain to draw. */
function isPlainSubject(subject: string): boolean {
	return (
		subject !== "" &&
		[...subject].length <= LONGEST_SUBJECT &&
		!NOT_PLAIN.test(subject) &&
		!LONE_SURROGATE.test(subject) &&
		![...subject].some(unseen)
	);
}
