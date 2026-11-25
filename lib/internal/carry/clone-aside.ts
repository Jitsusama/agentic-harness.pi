/**
 * The folder an arriving tree is cloned into beside its place, before it
 * is renamed in: taken only where nothing stands at its name, so what is
 * taken out after is a folder the arrival made, and said, never thrown,
 * where the disk won't let it go.
 */

import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { messageOf } from "./message.ts";

/** What a clone left beside a tree's place asks of whoever reads it. */
const BESIDE =
	"take it out by hand, since no arrival takes out a clone it didn't make";

/**
 * Makes the empty folder an arrival clones into, refusing a name that
 * something already stands at: why where it can't, or nothing.
 */
export function claimed(cloning: string): string | undefined {
	try {
		mkdirSync(dirname(cloning), { recursive: true });
		mkdirSync(cloning);
		return undefined;
	} catch (error) {
		return `Its clone couldn't be made at ${cloning}: ${messageOf(error)}`;
	}
}

/**
 * Takes out a clone this arrival made itself, answering where it is
 * left and why where the disk refuses, as a busy or unwritable folder
 * does, so a refused tree is said rather than thrown out of the arrival.
 * What is left asks `asking` of whoever reads it.
 */
export function letGoOf(
	clone: string,
	asking: string = BESIDE,
): string | undefined {
	try {
		rmSync(clone, { recursive: true, force: true });
		return undefined;
	} catch (error) {
		return `its clone is left at ${clone}, since it couldn't be taken out: ${messageOf(error)}; ${asking}`;
	}
}

/** `why`, then what was `left` behind, where anything was. */
export function andLeft(why: string, ...left: (string | undefined)[]): string {
	const said = left.filter((one) => one !== undefined);
	if (said.length === 0) return why;
	const stopped = /[.!?]$/.test(why) ? why : `${why}.`;
	return `${stopped} And ${said.join(", and ")}.`;
}
