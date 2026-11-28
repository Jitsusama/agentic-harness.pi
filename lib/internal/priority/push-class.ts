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
 * A backslash ending a line, which joins the next line to it as one, as
 * the shell reads `WORLD_PUSH_CLASS=0 \` over `git push`.
 */
const CONTINUED = /\\\n/g;

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
 * The soonest class any of a command's walks of World's objects is
 * given, since the whole command waits for one turn before its first
 * walk starts and every walk after it runs on that turn: a push given
 * class 0 after a fetch that has none waits as class 0. A walk's class
 * is {@link PUSH_CLASS_VARIABLE} as the walk's own step sets it before its
 * command, or through `env`, past what the command runs under (see
 * `ownAssignment`), a line its backslash continues included; else as an earlier step exported it, or
 * assigned it once exported; else `inherited`, the value the shell runs
 * with, until a step unsets it or takes its export with `export -n`, or
 * the walk's own `env -i` or `env -u` keeps it from git. Anything else,
 * as a value other than 0, 1 or 2, one set through a variable, or one
 * exported in a subshell, is
 * {@link LAST_PUSH_CLASS}, as the gate counts it. So is a command that
 * walks none.
 */
export function pushClassOf(
	command: string,
	where: Where = { home: homedir() },
	inherited?: string,
): PushClass {
	const steps = runSteps(command.replace(CONTINUED, " "));
	// Read in one pass: each step's walk hangs on the folders and variables
	// the steps before it set, so reading them again for each step costs
	// the square of their count.
	const walking = new Set(worldWalkSteps(steps, where).map(({ at }) => at));
	let variable: Variable = {
		value: inherited,
		exported: inherited !== undefined,
	};
	let soonest = LAST_PUSH_CLASS;
	for (const [at, step] of steps.entries()) {
		if (walking.has(at)) {
			const own = ownAssignment(step);
			const reaches = variable.exported && !own.cleared;
			const given = own.given ?? (reaches ? variable.value : undefined);
			const walkClass =
				(given === undefined ? undefined : CLASSES.get(given)) ??
				LAST_PUSH_CLASS;
			if (walkClass < soonest) soonest = walkClass;
		}
		variable = afterStep(step, variable);
	}
	return soonest;
}

/**
 * What a step's own words give {@link PUSH_CLASS_VARIABLE} for its
 * command alone: a value, and whether the value the shell holds is kept
 * from it, as `env -i` and `env -u` keep it.
 */
interface OwnClass {
	readonly given: string | undefined;
	readonly cleared: boolean;
}

/**
 * The words that open a group or a branch of the shell's own, which the
 * command after them runs in the same shell: `{`, `then`, `do`, `else`
 * and `!`. A subshell's `(` is read off the word it opens.
 */
const OPENS = new Set(["{", "then", "do", "else", "!"]);

/**
 * A program that runs the command after it with the environment it was
 * given: the options it reads, those of them that take the next word as
 * their value, the words it reads after them before the command (as
 * `timeout`'s duration), and whether a variable may be set after it, as
 * `env` reads `NAME=value` as one where `nice` would run it.
 */
interface Wrapper {
	readonly valued: ReadonlySet<string>;
	readonly operands: number;
	readonly assigns: boolean;
}

/** The programs {@link ownAssignment} reads through, by {@link Wrapper}. */
const WRAPPERS: ReadonlyMap<string, Wrapper> = new Map([
	[
		"timeout",
		{
			valued: new Set(["-s", "-k", "--signal", "--kill-after"]),
			operands: 1,
			assigns: false,
		},
	],
	[
		"nice",
		{ valued: new Set(["-n", "--adjustment"]), operands: 0, assigns: false },
	],
	[
		"env",
		{
			valued: new Set([
				"-u",
				"--unset",
				"-C",
				"--chdir",
				"-S",
				"--split-string",
			]),
			operands: 0,
			assigns: true,
		},
	],
	["command", { valued: new Set(), operands: 0, assigns: false }],
	["exec", { valued: new Set(["-a"]), operands: 0, assigns: false }],
	["nohup", { valued: new Set(), operands: 0, assigns: false }],
	["time", { valued: new Set(), operands: 0, assigns: true }],
	// Its subcommand and the folder whose environment it loads.
	["direnv", { valued: new Set(), operands: 2, assigns: false }],
]);

/**
 * The value a step gives {@link PUSH_CLASS_VARIABLE} for its own command
 * alone: assigned before it, or after `env`, past what it runs under: a
 * subshell, a group or a branch it opens (see {@link OPENS}), and the
 * programs that run a command as they were given it (see
 * {@link WRAPPERS}), as `timeout 600 env WORLD_PUSH_CLASS=0 git push`
 * gives 0. Nothing for a step that gives none, or one that only assigns,
 * which sets the shell's own. An `env` that empties the environment or
 * takes the variable out of it clears what came before it and keeps the
 * shell's own from the command.
 */
function ownAssignment(step: string): OwnClass {
	const words = step.trim().split(/\s+/).filter(Boolean);
	let given: string | undefined;
	let cleared = false;
	let assigns = true;
	let at = 0;
	while (at < words.length) {
		const word = (words[at] ?? "").replace(/^\(+/, "");
		if (word === "" || OPENS.has(word)) {
			assigns = true;
			at += 1;
			continue;
		}
		const set = ASSIGNED.exec(word);
		if (set !== null) {
			// Past a program that runs its next word, this is that word.
			if (!assigns) return { given: undefined, cleared };
			if (set[1] === PUSH_CLASS_VARIABLE) given = set[2];
			at += 1;
			continue;
		}
		const wrapper = WRAPPERS.get(word);
		if (wrapper === undefined) return { given, cleared };
		if (word === "direnv" && words[at + 1] !== "exec") {
			return { given, cleared };
		}
		const options = pastOptions(words, at + 1, wrapper.valued);
		if (word === "env" && envClears(words.slice(at + 1, options))) {
			given = undefined;
			cleared = true;
		}
		at = options + wrapper.operands;
		assigns = wrapper.assigns;
	}
	return { given: undefined, cleared };
}

/**
 * Whether `env`'s options take {@link PUSH_CLASS_VARIABLE} out of the
 * environment it runs its command with: `-i`, `-` or
 * `--ignore-environment` empty it, and `-u` or `--unset` naming the
 * variable takes it out. It runs them before the variables it sets.
 */
function envClears(options: readonly string[]): boolean {
	return options.some(
		(option, at) =>
			EMPTIES.has(option) ||
			option === `-u${PUSH_CLASS_VARIABLE}` ||
			option === `--unset=${PUSH_CLASS_VARIABLE}` ||
			((option === "-u" || option === "--unset") &&
				options[at + 1] === PUSH_CLASS_VARIABLE),
	);
}

/** `env`'s options that run its command with an empty environment. */
const EMPTIES = new Set(["-i", "-", "--ignore-environment"]);

/**
 * Where a program's options end among `words`, from `at`: past each word
 * starting with `-`, and the value after each of `valued`, up to `--`,
 * which ends them and is read with them.
 */
function pastOptions(
	words: readonly string[],
	at: number,
	valued: ReadonlySet<string>,
): number {
	let next = at;
	while (next < words.length) {
		const word = words[next] ?? "";
		if (word === "--") return next + 1;
		if (!word.startsWith("-")) return next;
		next += valued.has(word) ? 2 : 1;
	}
	return next;
}

/**
 * What the shell knows of {@link PUSH_CLASS_VARIABLE} after a step: an
 * `export` sets and exports it, an `export -n` keeps it from the
 * commands the shell runs, an `unset` clears it, and a step of
 * assignments alone sets it, exported only if it was.
 */
function afterStep(step: string, variable: Variable): Variable {
	const [first, ...rest] = step.trim().split(/\s+/).filter(Boolean);
	if (first === "unset") {
		return rest.includes(PUSH_CLASS_VARIABLE)
			? { value: undefined, exported: false }
			: variable;
	}
	const exporting = first === "export";
	const unexporting = exporting && rest.includes("-n");
	const words = exporting
		? rest.filter((word) => !word.startsWith("-"))
		: [first, ...rest];
	const assignsOnly = words.every(
		(word) => word !== undefined && ASSIGNED.test(word),
	);
	if (!exporting && !assignsOnly) return variable;
	let { value, exported } = variable;
	for (const word of words) {
		const set = ASSIGNED.exec(word ?? "");
		const names =
			word === PUSH_CLASS_VARIABLE || set?.[1] === PUSH_CLASS_VARIABLE;
		if (set?.[1] === PUSH_CLASS_VARIABLE) value = set[2];
		if (exporting && names) exported = !unexporting;
	}
	return { value, exported };
}
