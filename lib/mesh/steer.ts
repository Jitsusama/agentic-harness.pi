/**
 * The steer inbox: what the person says to one peer from outside its
 * window, such as the launcher's Steer box, delivered to it as the
 * person's own message rather than as a peer's on the mesh.
 *
 * Joel, 2026-10-25: "i really need to be able to have some interface i
 * can steer on". A mesh message would not do: peers read those as
 * context from other agents, and attention can make one a note, so a
 * pivot from the person would lose its authority on the way.
 *
 * Each peer address has a folder, `<root>/<ADDRESS>/`. A writer puts a
 * file there under a temporary name and renames it to end in `.json`,
 * holding `{"text": "...", "at": "<ISO time>", "from": "joel"}`, and
 * an `id` when the writer wants to follow what becomes of it (see
 * talk.ts). An `act` of `pause`, `resume` or `stop` needs no text. The
 * session going by that address takes it by renaming it again, so two
 * sessions looking at once deliver it once, then reads and removes it.
 * A file that is not a steer is set aside as `.bad`, never retried.
 */

import {
	type Dirent,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { isTalkId } from "./talk.ts";

/**
 * What the person may do to a session besides talk: pause it after its
 * current step, resume it, or stop the run in progress.
 */
export const STEER_ACTS = ["pause", "resume", "stop"] as const;

/** One of STEER_ACTS. */
export type SteerAct = (typeof STEER_ACTS)[number];

function isSteerAct(value: unknown): value is SteerAct {
	return (STEER_ACTS as readonly unknown[]).includes(value);
}

/** One thing the person said, as the inbox carries it. */
export interface Steer {
	/**
	 * Their words; empty only for an act, and kept only beside `resume`,
	 * since words would start the run a pause or stop is ending.
	 */
	readonly text: string;
	/** What they did besides talk, when they did. */
	readonly act?: SteerAct;
	/** When it was written, as an ISO time, if the writer said. */
	readonly at?: string;
	/** Who wrote it, if the writer said; the launcher says "joel". */
	readonly from?: string;
	/** The talk it opens, when the writer gave one (see talk.ts). */
	readonly id?: string;
	/** The file it came in, for what is said about it on screen. */
	readonly file: string;
}

/** What taking the inbox found: steers to deliver, and files set aside. */
export interface Taken {
	readonly steers: Steer[];
	readonly bad: string[];
}

const READY = ".json";
const TAKEN = ".taking";
const BAD = ".bad";

/** The inbox folder of one peer address. */
export function inboxOf(root: string, address: string): string {
	return join(root, address.toUpperCase());
}

/** A steer read from a file's text, or nothing when it is not one. */
export function steerFrom(raw: string, file: string): Steer | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Not JSON at all: the caller sets it aside as not a steer.
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const act =
		"act" in parsed && isSteerAct(parsed.act) ? parsed.act : undefined;
	const said =
		"text" in parsed && typeof parsed.text === "string"
			? parsed.text.trim()
			: "";
	const text = act === "pause" || act === "stop" ? "" : said;
	if (!act && text === "") return undefined;
	const at = "at" in parsed && typeof parsed.at === "string" ? parsed.at : "";
	const from =
		"from" in parsed && typeof parsed.from === "string" ? parsed.from : "";
	const id = "id" in parsed && isTalkId(parsed.id) ? parsed.id : undefined;
	return {
		text,
		...(act ? { act } : {}),
		...(at ? { at } : {}),
		...(from ? { from } : {}),
		...(id ? { id } : {}),
		file,
	};
}

/**
 * Let go of the inboxes of addresses nobody answers now. Each session
 * makes one for its own address and one for its quest's the first time
 * it looks, so without this the folder grew by two for every session
 * the machine ever ran: 118 on 2026-10-29, when a burst of ten in six
 * minutes set the launcher, which lists them, crash-looping.
 *
 * An empty inbox goes once it is older than `quietSince`, so a session
 * that has just made its own, ahead of publishing who it is, keeps it.
 * One holding anything, such as a steer for a session that may yet be
 * restored or a talk's replies, goes once nothing in it has changed
 * since `keptSince`. Returns the addresses let go.
 */
export function forgetInboxes(
	root: string,
	answered: ReadonlySet<string>,
	quietSince: number,
	keptSince: number,
): string[] {
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return [];
	}
	const forgotten: string[] = [];
	for (const name of names) {
		if (answered.has(name)) continue;
		const inbox = join(root, name);
		const last = lastChange(inbox);
		if (last === undefined) continue;
		if (last.at >= (last.empty ? quietSince : keptSince)) continue;
		try {
			rmSync(inbox, { recursive: true, force: true });
			forgotten.push(name);
		} catch {
			// Left for the next sweep, which tries again.
		}
	}
	return forgotten;
}

/**
 * When anything in a folder last changed, and whether it holds no file
 * at all; undefined when it is not a folder that can be read.
 */
function lastChange(dir: string): { at: number; empty: boolean } | undefined {
	let at: number;
	let entries: Dirent[];
	try {
		const own = statSync(dir);
		if (!own.isDirectory()) return undefined;
		at = own.mtimeMs;
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	let empty = true;
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			const inner = lastChange(path);
			if (!inner) continue;
			at = Math.max(at, inner.at);
			empty &&= inner.empty;
			continue;
		}
		empty = false;
		try {
			at = Math.max(at, statSync(path).mtimeMs);
		} catch {
			// Gone as it was read, as a steer taken meanwhile is: still not empty.
		}
	}
	return { at, empty };
}

/**
 * Every steer waiting in an inbox, oldest name first, each taken off
 * disk as it is read. Making the folder is part of looking, so a
 * writer finds it there once its peer has looked once.
 */
export function takeSteers(inbox: string, taker: string): Taken {
	mkdirSync(inbox, { recursive: true });
	const steers: Steer[] = [];
	const bad: string[] = [];
	const ready = readdirSync(inbox)
		.filter((name) => name.endsWith(READY))
		.sort();
	for (const name of ready) {
		const from = join(inbox, name);
		const taking = `${from}.${taker}${TAKEN}`;
		try {
			renameSync(from, taking);
		} catch {
			// Another session took it first, or its writer withdrew it.
			continue;
		}
		const steer = steerFrom(readFileSync(taking, "utf8"), name);
		if (steer) {
			steers.push(steer);
			unlinkSync(taking);
		} else {
			renameSync(taking, `${from}${BAD}`);
			bad.push(name);
		}
	}
	return { steers, bad };
}
