/**
 * What a session is doing, as its presence says it: its focused plan's
 * next open item and the newest choice in its quest's Journey, so a map
 * of the machine shows what each part is deciding without reading every
 * plan (KP0L6A [ca859d8c], for H2VYOB's map, 15 November).
 *
 * The quest workflow says it in a file per session, written whole and
 * only when it changes, so `at` is when it last did. The mesh puts it on
 * the session's presence each time that is published, and a mycelium
 * node passes it through. A file of its own, rather than a field of the
 * session's record, since the record is rewritten by much else.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../paths.ts";
import { writeWhole } from "../write-whole.ts";
import { recentJourney } from "./journey.ts";

/** Where sessions say what they are doing, one file each. */
export function doingFolder(): string {
	return join(stateDir("quest-workflow"), "doing");
}

/** What a session is doing, for its presence. */
export interface Doing {
	/** The focused plan, by id. */
	readonly plan: string;
	/** Its next open item's number, when the item has one. */
	readonly item?: number;
	/** That item's first line, plain, at most `DOING_CHARS`. */
	readonly next: string;
	/** The newest Journey entry's first line, plain, at most `DOING_CHARS`. */
	readonly chose?: string;
	/** When either last changed, as an ISO time. */
	readonly at: string;
}

/** How much of an item or a choice is said. */
const DOING_CHARS = 120;

/** What a cut text ends with. */
const CUT = "...";

/** An item's number and the rest of it: `251. Put ...`. */
const NUMBERED = /^(\d+)\.\s+([\s\S]*)$/;

/** Where the quest workflow stands, as far as doing needs it. */
export interface DoingSource {
	readonly questDir: string | null;
	readonly documentId: string | null;
	readonly documentKind: string | null;
	readonly currentItem?: string;
}

/**
 * What a session is doing now, without its time: nothing when no plan
 * is focused or every item is done.
 */
export function doingNow(source: DoingSource): Omit<Doing, "at"> | undefined {
	const { questDir, documentId, documentKind, currentItem } = source;
	if (documentKind !== "plan" || !documentId || !questDir) return undefined;
	if (currentItem === undefined) return undefined;
	const numbered = NUMBERED.exec(currentItem);
	const chose = newestChoice(questDir);
	return {
		plan: documentId,
		...(numbered ? { item: Number(numbered[1]) } : {}),
		next: plain(numbered ? numbered[2] : currentItem),
		...(chose ? { chose } : {}),
	};
}

/** The newest Journey entry's first line, plain, when there is one. */
function newestChoice(questDir: string): string | undefined {
	let readme = "";
	try {
		readme = readFileSync(join(questDir, "README.md"), "utf8");
	} catch {
		// No README to read a Journey section from: the file alone is read.
	}
	const [newest] = recentJourney(questDir, readme, 1);
	return newest ? plain(newest.prose) : undefined;
}

/** A text's first line without markdown, cut to `DOING_CHARS`. */
function plain(text: string): string {
	const line = (text.split("\n")[0] ?? "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[`*_]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return line.length <= DOING_CHARS
		? line
		: `${line.slice(0, DOING_CHARS - CUT.length).trimEnd()}${CUT}`;
}

/** The file a session's doing is said in. */
function doingFile(folder: string, session: string): string {
	return join(folder, `${session}.json`);
}

/**
 * Say what `session` is doing in `folder`, keeping its time while it
 * stands and taking the file away when there is nothing to say.
 */
export function sayDoing(
	folder: string,
	session: string,
	now: Omit<Doing, "at"> | undefined,
	clock: Date,
): void {
	const file = doingFile(folder, session);
	if (now === undefined) {
		rmSync(file, { force: true });
		return;
	}
	const said = readDoing(folder, session);
	if (said && sameDoing(said, now)) return;
	const doing: Doing = { ...now, at: clock.toISOString() };
	writeWhole(file, `${JSON.stringify(doing)}\n`);
}

function sameDoing(said: Doing, now: Omit<Doing, "at">): boolean {
	return (
		said.plan === now.plan &&
		said.item === now.item &&
		said.next === now.next &&
		said.chose === now.chose
	);
}

/** What `session` last said it was doing, when it said anything. */
export function readDoing(folder: string, session: string): Doing | undefined {
	try {
		const read: unknown = JSON.parse(
			readFileSync(doingFile(folder, session), "utf8"),
		);
		return isDoing(read) ? read : undefined;
	} catch {
		// Nothing said, or said before this harness knew how: nothing to read.
		return undefined;
	}
}

/** Whether a value read from disk is a `Doing`. */
export function isDoing(value: unknown): value is Doing {
	if (typeof value !== "object" || value === null) return false;
	const one = value as Record<string, unknown>;
	return (
		typeof one.plan === "string" &&
		typeof one.next === "string" &&
		typeof one.at === "string" &&
		(one.item === undefined || typeof one.item === "number") &&
		(one.chose === undefined || typeof one.chose === "string")
	);
}

/** Where a failure to say it is told: the session's own notices. */
export interface DoingNotices {
	notify(text: string, level: "warning"): void;
}

/**
 * Say what `session` is doing now, as the quest workflow stands, after a
 * quest action, a write to the focused plan or a start. A failure is
 * told, never thrown: the quest's work doesn't wait on a map's field.
 */
export function keepDoingSaid(
	source: DoingSource,
	session: string | undefined,
	notices: DoingNotices,
	folder: string = doingFolder(),
): void {
	if (!session) return;
	try {
		sayDoing(folder, session, doingNow(source), new Date());
	} catch (error) {
		const why = error instanceof Error ? error.message : String(error);
		notices.notify(
			`The map can't show what this session is doing: ${why}`,
			"warning",
		);
	}
}

/** Take away what an ended session said it was doing. */
export function forgetDoing(
	session: string,
	folder: string = doingFolder(),
): void {
	try {
		sayDoing(folder, session, undefined, new Date());
	} catch {
		// An ended session has no presence to carry it, and the session's
		// next start says its own over whatever was left.
	}
}
