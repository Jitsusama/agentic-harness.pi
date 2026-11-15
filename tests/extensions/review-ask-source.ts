/**
 * The source of `review_ask` and its rounds, for the tests that sweep it
 * rather than run a round: every module a call's rounds are split across,
 * read the way a sweep of the one file they began in read that file.
 *
 * One list here rather than one in each sweep, so a round moved to a
 * module of its own is swept by every test the day it moves, and a sweep
 * cannot pass by no longer reading where the code went.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const TOOLS = join(
	import.meta.dirname,
	"..",
	"..",
	"extensions",
	"review-integration",
	"tools",
);

/** The modules a `review_ask` call and its rounds are written in. */
const ROUND_MODULES = [
	"ask.ts",
	"ask-council.ts",
	"ask-weigh.ts",
	"ask-stack.ts",
	"ask-round.ts",
	"ask-reviewer.ts",
] as const;

/** Each of those modules' text, in the order they are listed. */
export function askModules(): string[] {
	return ROUND_MODULES.map((file) => readFileSync(join(TOOLS, file), "utf8"));
}

/** Every one of those modules' text as one, a module after another. */
export function askSource(): string {
	return askModules().join("\n");
}

/** Where a top-level async function opens, exported or not, and its name. */
const OPENING = /^(?:export )?async function (\w+)\(/gm;

/**
 * Each top-level async function's text, by its name: from where it opens
 * to where the next one in its own module does, or that module's end.
 */
export function askFunctions(): Map<string, string> {
	const bodies = new Map<string, string>();
	for (const text of askModules()) {
		const openings = [...text.matchAll(OPENING)];
		for (const [at, opening] of openings.entries()) {
			const name = opening[1];
			if (name === undefined) continue;
			const start = opening.index + opening[0].indexOf("async function");
			bodies.set(name, text.slice(start, openings[at + 1]?.index));
		}
	}
	return bodies;
}
