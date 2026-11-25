/**
 * What this machine tells the council start line about a round: whether
 * it leads, as World's changes do, and which rounds are marked urgent,
 * and where a change's rounds stand in it, as `runs` says.
 *
 * Apart from `start-spacing.ts`, which keeps the line for any machine,
 * because where World lives and where a person marks a round urgent are
 * this machine's, not the line's.
 */

import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { placesInLine } from "../../../lib/core/review/ask/start-spacing.ts";

const run = promisify(execFile);

/** How long git may take to say where a checkout keeps its objects. */
const GIT_ANSWERS_WITHIN_MS = 5000;

/** Where World's own object store lives on this machine. */
function worldStore(): string {
	return join(homedir(), "world", "git");
}

/** What each local checkout was found to be, so git is asked once. */
const worldCheckouts = new Map<string, Promise<boolean>>();

/**
 * Whether a round on `change`, by its label, is World work: a change
 * World hosts, or a local range whose checkout keeps its objects in
 * World's store or borrows them from it (1OGSE7, 25 November). A
 * checkout git can't answer for in time is read as not World's, which
 * only leaves its round where its ask puts it.
 */
export async function isWorldWork(change: string): Promise<boolean> {
	if (change.includes("shop/world")) return true;
	const checkout = / in local:(.+)$/.exec(change)?.[1];
	if (checkout === undefined) return false;
	let found = worldCheckouts.get(checkout);
	if (found === undefined) {
		found = keepsWorldObjects(checkout);
		worldCheckouts.set(checkout, found);
	}
	return await found;
}

async function keepsWorldObjects(checkout: string): Promise<boolean> {
	try {
		const world = await realpath(worldStore());
		const { stdout } = await run(
			"git",
			[
				"-C",
				checkout,
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
			],
			{ timeout: GIT_ANSWERS_WITHIN_MS },
		);
		const common = await realpath(stdout.trim());
		if (common === world) return true;
		return await borrowsFrom(common, world);
	} catch {
		// No World store here, or a checkout gone or slow to answer: not
		// World work, so its round stands where its ask puts it.
		return false;
	}
}

/** Whether the store at `common` borrows its objects from `world`. */
async function borrowsFrom(common: string, world: string): Promise<boolean> {
	let alternates: string;
	try {
		alternates = await readFile(
			join(common, "objects", "info", "alternates"),
			"utf8",
		);
	} catch {
		// A store that borrows nothing keeps no alternates file.
		return false;
	}
	for (const each of alternates.split("\n")) {
		const objects = each.trim();
		if (objects === "") continue;
		const owner = await realpath(dirname(objects)).catch(() => undefined);
		if (owner === world) return true;
	}
	return false;
}

/**
 * The rounds and changes marked urgent, one ticket id or change label a
 * line, from the file velocity keeps in the runtime folder and the one
 * beside the line, which outlives a reboot. `#` starts a comment.
 */
export async function urgentMarks(line: string): Promise<string[]> {
	const runtime = process.env.XDG_RUNTIME_DIR;
	const files = [
		join(dirname(line), "urgent"),
		...(runtime === undefined ? [] : [join(runtime, "council-urgent")]),
	];
	const marks: string[] = [];
	for (const file of files) {
		let text: string;
		try {
			text = await readFile(file, "utf8");
		} catch {
			// Nobody has marked anything urgent there.
			continue;
		}
		for (const each of text.split("\n")) {
			const mark = each.replace(/#(?!\d).*$/, "").trim();
			if (mark !== "") marks.push(mark);
		}
	}
	return marks;
}

/**
 * Where the rounds waiting on `change` stand in the line kept beside
 * `path`, said one a line, or nothing when none waits.
 */
export async function lineSaid(
	path: string,
	change: string,
): Promise<string[]> {
	const places = await placesInLine(path, change);
	return places.map(
		(place) =>
			`- waiting in the start line, position ${place.position} of ${place.of}, asked ${place.askedAt} by ${place.by}`,
	);
}
