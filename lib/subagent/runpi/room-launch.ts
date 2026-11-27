/**
 * How a reviewer is started on a room rather than here: the same
 * reviewer's words, rewritten for the room's reviewer entry and handed
 * to the mycelium node with `run`. On a room, `pi` is the image's
 * wrapper into the fenced worker session, so the node streams that
 * session's own output back over pipes, as a local pi's would be, and
 * ends with its code.
 *
 * Pure: it takes the brief's text rather than its path, so what it
 * decides can be tested without a room, a filesystem or a node.
 *
 * The entry (9R6RA6's `pi --review`, in the room's image) takes only
 * the words it names, so each rewrite here answers one of its rules:
 * extensions and skills go as paths within the harness, since the
 * entry resolves them under its own pinned copy; the brief goes as
 * base64 in arguments, since nothing from here reaches a file in the
 * session's home; and the code under review is named by its commit,
 * which the entry checks out in the session's own layer of the room's
 * checkout of the repository `--repo` names before pi starts.
 */

import { isAbsolute, relative, sep } from "node:path";

/** Where a reviewer goes when it goes to a room. */
export interface RoomPlace {
	/** The mycelium binary that asks the node. */
	readonly mycelium: string;
	/** The realm the room is in. */
	readonly realm: string;
	/** The room, as mycelium names the machine. */
	readonly machine: string;
	/** The harness this session runs, whose paths go as relative ones. */
	readonly harnessRoot: string;
	/**
	 * The extensions the room's entry loads into every reviewer itself,
	 * the fence's, as paths here: left out of the words, since the
	 * entry's copies are from its own store and pi would load both.
	 */
	readonly entryLoads?: readonly string[];
}

/** The code a reviewer reads, as the room can find it. */
export interface RoomCode {
	/** The repository's name as the room lays it under ~/src, such as agentic-harness.pi. */
	readonly repo: string;
	/** The reviewed commit, 40 lowercase hex. */
	readonly commit: string;
}

/** A started room reviewer, or why this one stays here. */
export type RoomLaunch =
	| { readonly binary: string; readonly args: readonly string[] }
	| { readonly stays: string };

/**
 * The largest brief that goes to a room, before base64.
 *
 * The last sixty rounds' briefs ran from 8 to 124 KB, and every word
 * of a start rides one command line, which Linux caps at 2 MiB with
 * the environment included. A brief past this stays here rather than
 * risking a start the kernel refuses.
 */
export const MAX_ROOM_BRIEF_BYTES = 1024 * 1024;

/**
 * How much base64 one argument carries.
 *
 * Under the 128 KiB one argument may be, and a multiple of four, so
 * each piece decodes alone and the entry can refuse a bad one before
 * pi starts.
 */
export const ROOM_BRIEF_CHUNK = 96 * 1024;

/**
 * The repositories a room keeps a checkout of, under the worker's
 * ~/src. The entry refuses any other name, so a review of anything
 * else stays here rather than asking.
 */
export const ROOM_REPOS: ReadonlySet<string> = new Set([
	"core.nix",
	"agentic-harness.pi",
	"mycelium",
]);

const COMMIT = /^[0-9a-f]{40}$/;
const VALUED = new Set(["--extension", "-e", "--skill"]);
/**
 * The options whose value the entry refuses when it is empty or starts
 * with a dash, since it reads every value as the next word.
 */
const DASHLESS = new Set(["--system-prompt", "--append-system-prompt"]);

/**
 * The words that start this reviewer on the room, or why it stays.
 *
 * `args` are the reviewer's own, as `composeArgs` made them, without
 * pi's entry in front. `brief` is the text of the file the `@` word
 * names, which goes along as the entry's `--brief-b64` pieces.
 */
export function roomLaunch(
	place: RoomPlace,
	code: RoomCode,
	args: readonly string[],
	brief: string | undefined,
): RoomLaunch {
	if (!COMMIT.test(code.commit)) {
		return { stays: `${code.commit} is not a whole commit` };
	}
	if (!ROOM_REPOS.has(code.repo)) {
		return { stays: `a room keeps no checkout of ${code.repo}` };
	}
	const loaded = new Set(place.entryLoads ?? []);
	const words: string[] = [];
	let briefs = 0;
	for (let at = 0; at < args.length; at += 1) {
		const word = args[at] ?? "";
		if (word === "--session" || word === "--session-dir") {
			// A room's session ends with its home, so nothing resumes it.
			at += 1;
			continue;
		}
		if (word === "--no-session") continue;
		if (DASHLESS.has(word)) {
			const value = args[at + 1] ?? "";
			if (value === "" || value.startsWith("-")) {
				return { stays: `its ${word} is empty or starts with a dash` };
			}
		}
		if (
			(word === "-e" || word === "--extension") &&
			loaded.has(args[at + 1] ?? "")
		) {
			at += 1;
			continue;
		}
		if (VALUED.has(word)) {
			const within = harnessRelative(place.harnessRoot, args[at + 1] ?? "");
			if (within === undefined) {
				return { stays: `${args[at + 1]} is not in the harness` };
			}
			words.push(word === "-e" ? "--extension" : word, within);
			at += 1;
			continue;
		}
		if (word.startsWith("@")) {
			briefs += 1;
			continue;
		}
		words.push(word);
	}
	if (briefs > 1) return { stays: "it names more than one file to read" };
	if (briefs === 1 && (brief ?? "") === "") {
		return { stays: "its brief is empty" };
	}
	const pieces = briefs === 1 ? briefPieces(brief ?? "") : [];
	if (pieces === undefined) {
		return { stays: `its brief is past ${MAX_ROOM_BRIEF_BYTES} bytes` };
	}
	return {
		binary: place.mycelium,
		args: [
			"--realm",
			place.realm,
			"run",
			"--need",
			`machine=${place.machine}`,
			"--",
			"pi",
			"--review",
			"--repo",
			code.repo,
			"--commit",
			code.commit,
			"--no-session",
			...pieces.flatMap((piece) => ["--brief-b64", piece]),
			...words,
		],
	};
}

/** The path within the harness, or undefined when it lies outside. */
function harnessRelative(root: string, path: string): string | undefined {
	if (!isAbsolute(path)) return undefined;
	const within = relative(root, path);
	if (within === "" || isAbsolute(within)) return undefined;
	if (within === ".." || within.startsWith(`..${sep}`)) return undefined;
	return within.split(sep).join("/");
}

/** The brief as base64 pieces, or undefined when it is too big to go. */
function briefPieces(brief: string): string[] | undefined {
	const bytes = Buffer.from(brief, "utf8");
	if (bytes.length > MAX_ROOM_BRIEF_BYTES) return undefined;
	const encoded = bytes.toString("base64");
	const pieces: string[] = [];
	for (let at = 0; at < encoded.length; at += ROOM_BRIEF_CHUNK) {
		pieces.push(encoded.slice(at, at + ROOM_BRIEF_CHUNK));
	}
	return pieces;
}
