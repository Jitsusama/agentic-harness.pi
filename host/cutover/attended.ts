/**
 * Which host a session moves into: the attended host for a session Joel
 * drives, the background host for builders and watchers (OSPHT4's
 * cutover, 10 November).
 *
 * A session Joel drives holds words a person wrote
 * (lib/internal/session/driven.ts); on 10 November 17 of the 66 live
 * pis did. Each pi says so in its presence, worked out from the log it
 * holds in memory, so the cutover reads a log itself only for a session
 * whose presence can't say: reading them all took minutes when the
 * machine was busy. Either host gives every conversation a screen a
 * viewer attaches to, so a session put in the other one loses nothing
 * Joel could see; the person names any the rule gets wrong.
 */

import { createReadStream } from "node:fs";
import { isPersonWords } from "../../lib/internal/session/driven.ts";
import type { HostKind } from "../service/address.ts";

/** Where a session goes, and why, as the cutover says it. */
export interface HostChoice {
	readonly kind: HostKind;
	readonly why: string;
}

/** What the person said of where sessions go, by address. */
export interface HostOverrides {
	readonly attended: ReadonlySet<string>;
	readonly background: ReadonlySet<string>;
}

/** No overrides. */
export const NO_OVERRIDES: HostOverrides = {
	attended: new Set(),
	background: new Set(),
};

/** Whether a log line is words a person wrote. */
function isPersonLine(line: string): boolean {
	try {
		return isPersonWords(JSON.parse(line));
	} catch {
		// A line half-written as the log grows says nothing yet.
		return false;
	}
}

/** What marks a user message, in the head of its line. */
const USER_MARK = Buffer.from('"role":"user"');

/**
 * How much of a line's head can hold the mark: pi writes a message's
 * type, id, parent and time before its role, which sat at byte 107 of
 * each user line on 10 November.
 */
const HEAD_BYTES = 256;

const NEWLINE = 0x0a;

/**
 * The user lines of a log, found by each line's head alone. A builder's
 * log runs to tens of megabytes of tool results, and the live pis' to
 * about 1.5 GB together on 10 November: split into lines and searched
 * whole, the dry run took over two minutes, so only a line whose head
 * holds the mark is gathered whole.
 */
async function* userLines(file: string): AsyncGenerator<string> {
	let head = Buffer.alloc(0);
	let gathered: Buffer[] | undefined;
	let skipping = false;
	for await (const read of createReadStream(file)) {
		const chunk = Buffer.isBuffer(read) ? read : Buffer.from(read);
		let at = 0;
		while (at < chunk.length) {
			const end = chunk.indexOf(NEWLINE, at);
			const stop = end < 0 ? chunk.length : end;
			if (gathered) {
				gathered.push(chunk.subarray(at, stop));
			} else if (!skipping) {
				const want = Math.min(stop, at + HEAD_BYTES - head.length);
				head = Buffer.concat([head, chunk.subarray(at, want)]);
				if (head.includes(USER_MARK)) {
					gathered = [head, chunk.subarray(want, stop)];
				} else if (head.length >= HEAD_BYTES) {
					skipping = true;
				}
			}
			if (end < 0) break;
			if (gathered) yield Buffer.concat(gathered).toString("utf8");
			gathered = undefined;
			skipping = false;
			head = Buffer.alloc(0);
			at = end + 1;
		}
	}
	if (gathered) yield Buffer.concat(gathered).toString("utf8");
}

/**
 * Whether a session's log holds words a person wrote, stopped at the
 * first, so a session Joel drives answers early and only a builder's is
 * read whole; a log that can't be read holds none.
 */
export async function personWrote(file: string): Promise<boolean> {
	try {
		for await (const line of userLines(file)) {
			if (isPersonLine(line)) return true;
		}
		return false;
	} catch {
		// Gone or unreadable since it was found: nothing in it to go by.
		return false;
	}
}

/** Where a session goes: the person's word first, then its log's. */
export function hostFor(
	addresses: readonly string[],
	wrote: boolean,
	overrides: HostOverrides = NO_OVERRIDES,
): HostChoice {
	const named = (set: ReadonlySet<string>) =>
		addresses.find((address) => set.has(address.toUpperCase()));
	const attended = named(overrides.attended);
	if (attended)
		return { kind: "attended", why: `named attended (${attended})` };
	const background = named(overrides.background);
	if (background)
		return { kind: "background", why: `named background (${background})` };
	return wrote
		? { kind: "attended", why: "its log holds words a person wrote" }
		: { kind: "background", why: "nobody but the harness has written in it" };
}
