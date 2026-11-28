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
 * checkout of the repository `--repo` names before pi starts. A room
 * keyed to its repository in the config also says which commit it read,
 * and the supervisor holds its reviewer to that.
 */

import { isAbsolute, relative, sep } from "node:path";

/**
 * Which machine the node puts a reviewer on: the one it names, or any
 * with every need (`kind=value`), as mycelium's own `run --need` picks.
 */
export type RoomMachine =
	| { readonly machine: string }
	| { readonly needs: readonly string[] };

/** Where a reviewer goes when it goes to a room. */
export type RoomPlace = RoomMachine & RoomReach;

/** How a room is reached, and what this session's reviewers leave out there. */
export interface RoomReach {
	/** The mycelium binary that asks the node. */
	readonly mycelium: string;
	/** The realm the room is in. */
	readonly realm: string;
	/**
	 * A room the config keys to the change's repository, rather than the
	 * default one. Its entry takes any repository name of a safe shape,
	 * not only ROOM_REPOS, and says which commit it checked out before pi
	 * starts, which its reviewer is held to.
	 */
	readonly keyed?: boolean;
	/** The harness this session runs, whose paths go as relative ones. */
	readonly harnessRoot: string;
	/**
	 * The extensions the room's entry loads into every reviewer itself,
	 * the fence's, as paths here: left out of the words, since the
	 * entry's copies are from its own store and pi would load both.
	 */
	readonly entryLoads?: readonly string[];
	/**
	 * The session's default extensions and skills from outside the
	 * harness, which packages outside it register for this machine's own
	 * model access and credentials: left out of the words, since a room
	 * reaches its model through its own provider. Any other path outside
	 * the harness still keeps its reviewer here.
	 */
	readonly hereOnly?: readonly string[];
}

/** The code a reviewer reads, as the room can find it. */
export interface RoomCode {
	/** The repository's name as the room lays it under ~/src, such as agentic-harness.pi. */
	readonly repo: string;
	/** The reviewed commit, 40 lowercase hex. */
	readonly commit: string;
}

/** How a reviewer starts on a room. */
export interface RoomStart {
	readonly binary: string;
	readonly args: readonly string[];
	/**
	 * The commit the room must say it checked out, in the first line of
	 * its stream, before anything it says counts.
	 */
	readonly checkout?: string;
}

/** A started room reviewer, or why this one stays here. */
export type RoomLaunch = RoomStart | { readonly stays: string };

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
 * The repositories the default room keeps a checkout of, under the
 * worker's ~/src. Its entry refuses any other name, so a review of
 * anything else goes to a room keyed to its repository, or stays here.
 */
export const ROOM_REPOS: ReadonlySet<string> = new Set([
	"core.nix",
	"agentic-harness.pi",
	"mycelium",
]);

/**
 * The shape of a repository name a keyed room is asked for: one folder
 * name under the room's ~/src, never a path or an option.
 */
export const ROOM_REPO_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The type of the line a keyed room's entry prints on stdout before pi
 * starts, `{"type":"room_checkout","commit":"<40 hex>"}`, naming the
 * commit its reviewer reads.
 */
export const ROOM_CHECKOUT = "room_checkout";

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
	const known =
		place.keyed === true
			? ROOM_REPO_NAME.test(code.repo)
			: ROOM_REPOS.has(code.repo);
	if (!known) {
		return { stays: `a room keeps no checkout of ${code.repo}` };
	}
	const needs = "machine" in place ? [`machine=${place.machine}`] : place.needs;
	if (needs.length === 0) {
		return { stays: "its room names no machine and no need" };
	}
	const loaded = new Set(place.entryLoads ?? []);
	const hereOnly = new Set(place.hereOnly ?? []);
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
			if (within === undefined && hereOnly.has(args[at + 1] ?? "")) {
				at += 1;
				continue;
			}
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
			// One word, so no realm can be read as an option of its own.
			`--realm=${place.realm}`,
			"run",
			...needs.flatMap((need) => ["--need", need]),
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
		// Only a keyed room's entry says its checkout so far. The default
		// room's (9R6RA6's) doesn't print the line yet; holding its
		// reviewers to it as well is the next step, once it does.
		...(place.keyed === true ? { checkout: code.commit } : {}),
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
