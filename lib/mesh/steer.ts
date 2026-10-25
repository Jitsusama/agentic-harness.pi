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
 * holding `{"text": "...", "at": "<ISO time>", "from": "joel"}`. The
 * session going by that address takes it by renaming it again, so two
 * sessions looking at once deliver it once, then reads and removes it.
 * A file that is not a steer is set aside as `.bad`, never retried.
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";

/** One thing the person said, as the inbox carries it. */
export interface Steer {
	readonly text: string;
	/** When it was written, as an ISO time, if the writer said. */
	readonly at?: string;
	/** Who wrote it, if the writer said; the launcher says "joel". */
	readonly from?: string;
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
	const text = "text" in parsed ? parsed.text : undefined;
	if (typeof text !== "string" || text.trim() === "") return undefined;
	const at = "at" in parsed && typeof parsed.at === "string" ? parsed.at : "";
	const from =
		"from" in parsed && typeof parsed.from === "string" ? parsed.from : "";
	return {
		text: text.trim(),
		...(at ? { at } : {}),
		...(from ? { from } : {}),
		file,
	};
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
