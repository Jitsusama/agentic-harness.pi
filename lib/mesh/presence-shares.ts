/**
 * The folders a session works in with others, as its presence says
 * them: its quest's shared folder, which it says, and the shares
 * another presence says, read as a mycelium node reads them. Two cells
 * or more saying one key make a node form the network `files.<key>`
 * (KP0L6A, 18 November).
 */

import { lstatSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { questWorkspace } from "../core/internal/quest/workspace.ts";
import { questSharesRoot } from "../internal/quest/workspace/workspace-root.ts";
import { isRecord } from "../internal/record.ts";

/** A folder a session works in with others, as its presence says it. */
export interface Share {
	/**
	 * What names it alike on every machine, in lower case, such as
	 * `quest:<id>`.
	 */
	readonly key: string;
	/** What it is for, which titles the network it forms. */
	readonly for: string;
	/** Where it is kept on this session's machine. */
	readonly folder: string;
}

/** Whether `folder` is a folder of its own, not a link, that can be looked at. */
function isRealFolder(folder: string): boolean {
	try {
		return lstatSync(folder, { throwIfNoEntry: false })?.isDirectory() ?? false;
	} catch {
		return false;
	}
}

/**
 * The share of `quest`'s shared folder, beside its scratch rather than
 * in it (`questSharesRoot`): the same key on every machine, the folder
 * this machine keeps it in, and for what, its title as a node
 * draws it ({@link drawable}), blanks run together. A title with no words a node takes, as a README with no
 * heading yet, is said as the quest's id, so the quest still shares.
 * The title is cut as a node cuts it, with no blank left at its end.
 * An id that names no quest shares nothing.
 */
export function questShared(
	quest: string,
	title: string,
): { shares?: readonly Share[] } {
	let folder: string;
	try {
		// Named as a quest's scratch is, in the shares' own folder.
		folder = questWorkspace(questSharesRoot(), quest).dir;
	} catch {
		return {};
	}
	// Named from a relative cache, no other reader would find it; not made
	// yet, or removed, it holds nothing to work on together; a file, or a
	// link to somewhere else, isn't the quest's shared folder; and one that
	// can't be looked at is shared by nobody, rather than taking the
	// presence down with it. One a node would clean would be said as
	// another folder than this. Under a root that is a link, as a command
	// could leave one, it would be wherever that leads, such as a scratch.
	if (!isAbsolute(folder)) return {};
	if (drawable(folder) !== folder) return {};
	if (!isRealFolder(dirname(folder)) || !isRealFolder(folder)) return {};
	const plain = drawable(title).replace(/\p{White_Space}+/gu, " ");
	// Only Unicode's blanks, as a node trims: JavaScript's own trim takes a
	// byte-order mark too.
	const cut = [...plain]
		.slice(0, MOST_FOR)
		.join("")
		.replace(/\p{White_Space}+$/u, "");
	const share = shareFrom({
		key: `quest:${quest}`,
		for: cut.length > 0 ? cut : quest,
		folder,
	});
	return share ? { shares: [share] } : {};
}

/** The shares `said` holds, as `sharesFrom` reads them, or none. */
export function sharesSaid(said: unknown): { shares?: readonly Share[] } {
	const shares = sharesFrom(said);
	return shares.length > 0 ? { shares } : {};
}

/** How many of a presence's shares are read: the first, as a node reads them. */
const MOST_SHARES = 16;

/**
 * The letters a share's key is made of: a letter or digit, then up to
 * 95 more or `:`, `_`, `-`.
 */
const SHARE_WORD = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,95}$/;

/** Whether `key` is a share's key: its kind, a colon, then its name. */
const isShareKey = (key: string) =>
	SHARE_WORD.test(key) &&
	key.includes(":") &&
	key.slice(key.indexOf(":") + 1).length > 0;

/** The most characters of a share's `for` a node reads. */
const MOST_FOR = 120;

/** The most bytes a share's folder may hold. */
const MOST_FOLDER_BYTES = 1024;

/** The marks that turn text's direction, which a node refuses. */
const TURNS = new Set([
	0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066,
	0x2067, 0x2068, 0x2069,
]);

/** Whether `letter` is a control character, as a node counts one. */
function control(letter: string): boolean {
	const code = letter.codePointAt(0) ?? 0;
	return code < 0x20 || (code >= 0x7f && code < 0xa0);
}

/** Unicode's blanks, which a node trims from either end. */
const BLANK_ENDS = /^\p{White_Space}+|\p{White_Space}+$/gu;

/**
 * `said` as a terminal draws it on one line, as a node cleans a share:
 * each mark turning text's direction gone, each control letter and
 * line or paragraph break a space, and its ends trimmed.
 */
function drawable(said: string): string {
	return [...said]
		.filter((letter) => !TURNS.has(letter.codePointAt(0) ?? 0))
		.map((letter) =>
			control(letter) || letter === "\u2028" || letter === "\u2029"
				? " "
				: letter,
		)
		.join("")
		.replace(BLANK_ENDS, "");
}

/**
 * The share `value` says, as KP0L6A's node reads it (18 November, from
 * b06f844), or none where it doesn't fit: its key in lower case; its
 * `for` made {@link drawable}, cut to its first 120 characters and
 * trimmed again, or empty where it says nothing or isn't text; and its
 * folder made drawable and of 1 to 1024 bytes. A title or folder is
 * cleaned, never refused, as the node does.
 */
function shareFrom(value: unknown): Share | undefined {
	if (!isRecord(value)) return undefined;
	const { key } = value;
	if (typeof key !== "string" || typeof value.folder !== "string") {
		return undefined;
	}
	const folder = drawable(value.folder);
	const fits =
		isShareKey(key) &&
		folder.length > 0 &&
		Buffer.byteLength(folder, "utf8") <= MOST_FOLDER_BYTES;
	if (!fits) return undefined;
	const said = typeof value.for === "string" ? drawable(value.for) : "";
	return {
		key: key.toLowerCase(),
		for: [...said].slice(0, MOST_FOR).join("").replace(BLANK_ENDS, ""),
		folder,
	};
}

/**
 * The shares a presence says, as a node reads them: of the first
 * sixteen, each that fits, a misfit skipped alone as though unsaid, and
 * a key said again, whatever its case, keeping its first.
 */
function sharesFrom(value: unknown): Share[] {
	if (!Array.isArray(value)) return [];
	const kept = new Map<string, Share>();
	for (const said of value.slice(0, MOST_SHARES)) {
		const share = shareFrom(said);
		if (share && !kept.has(share.key)) kept.set(share.key, share);
	}
	return [...kept.values()];
}
