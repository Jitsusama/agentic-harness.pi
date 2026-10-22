/**
 * What a quest wrote outside every tree it tracks, so a write the home
 * gate or the temp funnel let through is still accounted for.
 *
 * The home gate stood for "the quest accounts for everything it
 * touched". Refusing every write outside a tree went further than that
 * needed: live machine config, a coordination file or a repository
 * about to be made has no tree to be in, and sessions routed round the
 * refusals instead. A write the gate lets through is now noted here,
 * and `conclude` names what the quest wrote outside its trees, in its
 * message and its Journey, so nothing is changed unseen.
 *
 * The note lives in the quest's workspace rather than its folder, which
 * holds only the record, and outside `tmp/`, so concluding keeps it.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { count } from "../../lib/ui/count.ts";
import { workspaceDirOf } from "./workspace.ts";

/** The file the note is kept in, inside the quest's workspace. */
const FILE = "outside-writes.jsonl";

/** How many paths a sentence names before it counts the rest. */
const NAMED = 8;

/** One path written outside the quest's trees. */
export interface OutsideWrite {
	readonly path: string;
	/** When it was first written. */
	readonly at: string;
}

/** Where a quest's note lives, or undefined for an id with no workspace. */
function notePath(root: string, questId: string | null): string | undefined {
	const dir = workspaceDirOf(root, questId);
	return dir ? join(dir, FILE) : undefined;
}

/**
 * Note paths a quest wrote outside its trees. Best effort: a full disk
 * costs the note, never the write.
 */
export function recordOutsideWrites(
	root: string,
	questId: string | null,
	paths: readonly string[],
	now: Date = new Date(),
): void {
	const file = notePath(root, questId);
	if (!file || paths.length === 0) return;
	const at = now.toISOString();
	try {
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(
			file,
			paths.map((path) => `${JSON.stringify({ path, at })}\n`).join(""),
		);
	} catch {
		// Nothing to do but go without; the gate already let the write by.
	}
}

/** Each path a quest wrote outside its trees, once, in the order first written. */
export function readOutsideWrites(
	root: string,
	questId: string | null,
): OutsideWrite[] {
	const file = notePath(root, questId);
	if (!file) return [];
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const first = new Map<string, OutsideWrite>();
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const entry = JSON.parse(line) as Partial<OutsideWrite>;
			if (typeof entry.path !== "string" || typeof entry.at !== "string") {
				continue;
			}
			if (!first.has(entry.path)) {
				first.set(entry.path, { path: entry.path, at: entry.at });
			}
		} catch {
			// A line cut short by a crash is one write's note lost.
		}
	}
	return [...first.values()];
}

/** One sentence naming what a quest wrote outside its trees, or nothing. */
export function outsideWritesSaid(
	writes: readonly OutsideWrite[],
): string | undefined {
	if (writes.length === 0) return undefined;
	const named = writes.slice(0, NAMED).map((w) => w.path);
	const rest = writes.length - named.length;
	const more = rest > 0 ? `, and ${rest} more` : "";
	return `Outside its trees it wrote ${count(writes.length, "path")}: ${named.join(", ")}${more}.`;
}
