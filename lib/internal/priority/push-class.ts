/**
 * The class a walk of World's objects carries to World's push gate.
 *
 * The gate, a pre-push hook taking pushes of World one at a time, ranks
 * the commands waiting on it by `WORLD_PUSH_CLASS`: 0 soonest, then 1,
 * then 2, and a command without one as 2. The queue gives the same
 * commands their turns before the gate sees them, so it reads the same
 * class: at 17:24 on 27 November a class-0 fetch waited 2052 s in the
 * queue behind class-1 walks held on memory, and the gate's class never
 * applied.
 */

import { homedir } from "node:os";
import { stepsOf, valuesAtSteps } from "./step-variable.ts";
import { type Where, worldWalkSteps } from "./world-walk.ts";

/** A class World's push gate ranks by: 0 soonest, then 1, then 2. */
export type PushClass = 0 | 1 | 2;

/** The class of a walk that carries none, or one the gate can't read. */
export const LAST_PUSH_CLASS: PushClass = 2;

/** The variable a command sets to give World's push gate its class. */
export const PUSH_CLASS_VARIABLE = "WORLD_PUSH_CLASS";

/** Each value of {@link PUSH_CLASS_VARIABLE} the gate reads, as its class. */
const CLASSES: ReadonlyMap<string, PushClass> = new Map([
	["0", 0],
	["1", 1],
	["2", 2],
]);

/** Whether a value is a class World's push gate ranks by. */
export function isPushClass(value: unknown): value is PushClass {
	return value === 0 || value === 1 || value === 2;
}

/**
 * The class a queued job waits by among the walks: its own, or
 * {@link LAST_PUSH_CLASS} for one that carries none, or a value no class
 * reads as, as a job file an older harness wrote may.
 */
export function pushClassOfJob(job: {
	readonly pushClass?: unknown;
}): PushClass {
	return isPushClass(job.pushClass) ? job.pushClass : LAST_PUSH_CLASS;
}

/**
 * The soonest class any of a command's walks of World's objects is
 * given, since the whole command waits for one turn before its first
 * walk starts and every walk after it runs on that turn: a push given
 * class 0 after a fetch that has none waits as class 0. A walk's class
 * is {@link PUSH_CLASS_VARIABLE} as the walk's own step sees it
 * (step-variable.ts's `valuesAtSteps`): set before its command, or
 * through `env`, past what the command runs under, a line its backslash
 * continues included; else as an earlier step exported it, or assigned
 * it once exported; else `inherited`, the value the shell runs with,
 * until a step unsets it or takes its export with `export -n`, or the
 * walk's own `env -i` or `env -u` keeps it from git. Anything else, as a
 * value other than 0, 1 or 2, one set through a variable, or one
 * exported in a subshell, is {@link LAST_PUSH_CLASS}, as the gate counts
 * it. So is a command that walks none.
 */
export function pushClassOf(
	command: string,
	where: Where = { home: homedir() },
	inherited?: string,
): PushClass {
	const steps = stepsOf(command);
	// Read in one pass: each step's walk hangs on the folders and variables
	// the steps before it set, so reading them again for each step costs
	// the square of their count.
	const walking = worldWalkSteps(steps, where).map(({ at }) => at);
	const values = valuesAtSteps(steps, PUSH_CLASS_VARIABLE, inherited);
	let soonest = LAST_PUSH_CLASS;
	for (const at of walking) {
		const given = values[at];
		const walkClass =
			(given === undefined ? undefined : CLASSES.get(given)) ?? LAST_PUSH_CLASS;
		if (walkClass < soonest) soonest = walkClass;
	}
	return soonest;
}
