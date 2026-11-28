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
import { runSteps } from "./steps.ts";
import { type Where, worldWalks } from "./world-walk.ts";

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

/** A variable set as one word, as `WORLD_PUSH_CLASS=0`. */
const ASSIGNED = /^([A-Za-z_]\w*)=(\S*)$/;

/**
 * What the shell knows of {@link PUSH_CLASS_VARIABLE} between steps: its
 * value, and whether it is exported, so the commands it runs see it.
 */
interface Variable {
	readonly value: string | undefined;
	readonly exported: boolean;
}

/**
 * The class of a command's first walk of World's objects, since the
 * whole command waits for one turn before that walk starts. It is
 * {@link PUSH_CLASS_VARIABLE} as the walk's own step sets it before its
 * command, or through `env`; else as an earlier step exported it, or
 * assigned it once exported; else `inherited`, the value the shell runs
 * with, until a step unsets it. Anything else, as a value other than 0,
 * 1 or 2, one set through a variable, or one set in a subshell, is
 * {@link LAST_PUSH_CLASS}, as the gate counts it. So is a command that
 * walks none.
 */
export function pushClassOf(
	command: string,
	where: Where = { home: homedir() },
	inherited?: string,
): PushClass {
	const steps = runSteps(command);
	let variable: Variable = {
		value: inherited,
		exported: inherited !== undefined,
	};
	for (const [at, step] of steps.entries()) {
		if (worldWalks(steps.slice(0, at + 1), where).length > 0) {
			const given =
				ownAssignment(step) ?? (variable.exported ? variable.value : undefined);
			return (
				(given === undefined ? undefined : CLASSES.get(given)) ??
				LAST_PUSH_CLASS
			);
		}
		variable = afterStep(step, variable);
	}
	return LAST_PUSH_CLASS;
}

/**
 * The value a step gives {@link PUSH_CLASS_VARIABLE} for its own command
 * alone: assigned before it, or through `env`. Nothing for a step that
 * gives none, or one that only assigns, which sets the shell's own.
 */
function ownAssignment(step: string): string | undefined {
	const words = step.trim().split(/\s+/).filter(Boolean);
	let given: string | undefined;
	let at = 0;
	const readAssignments = () => {
		for (; at < words.length; at += 1) {
			const set = ASSIGNED.exec(words[at] ?? "");
			if (set === null) return;
			if (set[1] === PUSH_CLASS_VARIABLE) given = set[2];
		}
	};
	readAssignments();
	if (at === words.length) return undefined;
	if (words[at] === "env") {
		at += 1;
		readAssignments();
	}
	return given;
}

/**
 * What the shell knows of {@link PUSH_CLASS_VARIABLE} after a step that
 * walks nothing: an `export` sets and exports it, an `unset` clears it,
 * and a step of assignments alone sets it, exported only if it was.
 */
function afterStep(step: string, variable: Variable): Variable {
	const [first, ...rest] = step.trim().split(/\s+/).filter(Boolean);
	if (first === "unset") {
		return rest.includes(PUSH_CLASS_VARIABLE)
			? { value: undefined, exported: false }
			: variable;
	}
	const exporting = first === "export";
	const words = exporting ? rest : [first, ...rest];
	const assignsOnly = words.every(
		(word) => word !== undefined && ASSIGNED.test(word),
	);
	if (!exporting && !assignsOnly) return variable;
	let { value, exported } = variable;
	for (const word of words) {
		if (exporting && word === PUSH_CLASS_VARIABLE) exported = true;
		const set = ASSIGNED.exec(word ?? "");
		if (set?.[1] === PUSH_CLASS_VARIABLE) {
			value = set[2];
			exported ||= exporting;
		}
	}
	return { value, exported };
}
