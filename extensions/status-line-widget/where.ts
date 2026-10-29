/**
 * What the line tells a folder's place and git's state by, as a machine's
 * own prompt does, so the two agree.
 *
 * A machine that has a prompt of its own can write `where.json` into this
 * extension's configuration folder (`~/.config/pi/agentic-harness.pi/
 * status-line/` by default): the program that answers git's state in
 * gitstatusd's protocol, the files or folders that mark a root, and the
 * marks its prompt draws. Without it the line still works: a folder is told
 * from the nearest `.git`, and the branch comes from pi itself, with no
 * marks for unsaved or unpushed work.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../../lib/internal/paths.ts";
import { isRecord } from "../../lib/internal/record.ts";
import { GLYPH } from "../../lib/ui/types.ts";

/** The marks the line draws, by what they mean. */
export interface Marks {
	/** Before a branch's name; empty draws the name alone. */
	readonly branch: string;
	/** Work in the tree not yet committed. */
	readonly unsaved: string;
	/** Commits not yet pushed. */
	readonly unpushed: string;
	/** Where a name is cut short. */
	readonly more: string;
	/** A step of git's work done, under way, and still to come. */
	readonly complete: string;
	readonly active: string;
	readonly pending: string;
	/** Before how hard the model thinks; empty draws the word alone. */
	readonly thinking: string;
}

export interface Where {
	/** A gitstatusd-speaking program, or null to ask pi for the branch. */
	readonly engine: string | null;
	/** Markers of a root, nearest first in priority. */
	readonly roots: readonly string[];
	readonly marks: Marks;
}

/**
 * The marks for a machine that names none. Plain characters for the two
 * that only an engine can show, since an engine without marks is a machine
 * configured by hand, and a geometric mark in place of its own would be a
 * guess at its font.
 */
export const DEFAULT_MARKS: Marks = {
	branch: "",
	unsaved: "*",
	unpushed: "^",
	more: GLYPH.ellipsis,
	complete: GLYPH.complete,
	active: GLYPH.active,
	pending: GLYPH.pending,
	thinking: "",
};

export const DEFAULT_WHERE: Where = {
	engine: null,
	roots: [".git"],
	marks: DEFAULT_MARKS,
};

/** Where the machine's description is kept. */
export function whereFile(): string {
	return join(configDir("status-line"), "where.json");
}

/**
 * Read a machine's description, keeping each field that reads and the
 * default for each that doesn't. A file that's missing or isn't JSON is
 * the default whole: the line has nowhere to say so, and a line that
 * still tells the folder is better than one that stops.
 */
export function readWhere(file = whereFile()): Where {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return DEFAULT_WHERE;
	}
	if (!isRecord(raw)) return DEFAULT_WHERE;

	const engine =
		typeof raw.engine === "string" && raw.engine.length > 0 ? raw.engine : null;
	const roots =
		Array.isArray(raw.roots) &&
		raw.roots.length > 0 &&
		raw.roots.every((root) => typeof root === "string" && root.length > 0)
			? (raw.roots as string[])
			: DEFAULT_WHERE.roots;

	const given = isRecord(raw.marks) ? raw.marks : {};
	const marks: { -readonly [K in keyof Marks]: string } = {
		...DEFAULT_MARKS,
	};
	for (const name of Object.keys(DEFAULT_MARKS) as (keyof Marks)[]) {
		const mark = given[name];
		if (typeof mark === "string") marks[name] = mark;
	}
	return { engine, roots, marks };
}
