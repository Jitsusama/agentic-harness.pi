/**
 * A variable as each step of a shell command sees it: set for that step
 * alone, exported by an earlier step, or inherited from the shell the
 * command runs in. The queue reads what a command tells it this way,
 * World's push gate class (push-class.ts) and when its work is due to
 * start (due-to-start.ts), so both read a command alike.
 */

import { runSteps } from "./steps.ts";

/**
 * A backslash ending a line, which joins the next line to it as one, as
 * the shell reads `WORLD_PUSH_CLASS=0 \` over `git push`.
 */
const CONTINUED = /\\\n/g;

/** A variable set as one word, as `WORLD_PUSH_CLASS=0`. */
const ASSIGNED = /^([A-Za-z_]\w*)=(\S*)$/;

/**
 * What the shell knows of a variable between steps: its value, and
 * whether it is exported, so the commands it runs see it.
 */
interface Variable {
	readonly value: string | undefined;
	readonly exported: boolean;
}

/** A command's steps, with each line its backslash continues joined on. */
export function stepsOf(command: string): string[] {
	return runSteps(command.replace(CONTINUED, " "));
}

/**
 * The value `name` has for each of `steps`' own commands: as the step
 * sets it before its command, or through `env`, past what the command
 * runs under (see `ownAssignment`); else as an earlier step exported it,
 * or assigned it once exported; else `inherited`, the value the shell
 * runs with, until a step unsets it or takes its export with
 * `export -n`, or the step's own `env -i` or `env -u` keeps it from the
 * command. Nothing for a step that sees none. A value is read as
 * written, so one set through another variable reads as its text, such
 * as `$C`, which no reader takes; one exported in a subshell is not
 * seen.
 */
export function valuesAtSteps(
	steps: readonly string[],
	name: string,
	inherited?: string,
): (string | undefined)[] {
	let variable: Variable = {
		value: inherited,
		exported: inherited !== undefined,
	};
	return steps.map((step) => {
		const own = ownAssignment(step, name);
		const shells =
			variable.exported && !own.cleared ? variable.value : undefined;
		variable = afterStep(step, name, variable);
		return own.given ?? shells;
	});
}

/**
 * The value `name` has for the first of `command`'s steps that `reaches`
 * holds of, given the steps up to and including it, as
 * {@link valuesAtSteps} reads it. Nothing when no step reaches, or the
 * step sees none.
 */
export function variableAtStep(
	command: string,
	name: string,
	reaches: (steps: readonly string[]) => boolean,
	inherited?: string,
): string | undefined {
	const steps = stepsOf(command);
	const values = valuesAtSteps(steps, name, inherited);
	for (const at of steps.keys()) {
		if (reaches(steps.slice(0, at + 1))) return values[at];
	}
	return undefined;
}

/**
 * What a step's own words give a variable for its command alone: a
 * value, and whether the value the shell holds is kept from it, as
 * `env -i` and `env -u` keep it.
 */
interface Own {
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
 * The value a step gives `name` for its own command alone: assigned
 * before it, or after `env`, past what it runs under: a subshell, a
 * group or a branch it opens (see {@link OPENS}), and the programs that
 * run a command as they were given it (see {@link WRAPPERS}), as
 * `timeout 600 env WORLD_PUSH_CLASS=0 git push` gives 0. Nothing for a
 * step that gives none, or one that only assigns, which sets the
 * shell's own. An `env` that empties the environment or takes the
 * variable out of it clears what came before it and keeps the shell's
 * own from the command.
 */
function ownAssignment(step: string, name: string): Own {
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
			if (set[1] === name) given = set[2];
			at += 1;
			continue;
		}
		const wrapper = WRAPPERS.get(word);
		if (wrapper === undefined) return { given, cleared };
		if (word === "direnv" && words[at + 1] !== "exec") {
			return { given, cleared };
		}
		const options = pastOptions(words, at + 1, wrapper.valued);
		if (word === "env" && envClears(words.slice(at + 1, options), name)) {
			given = undefined;
			cleared = true;
		}
		at = options + wrapper.operands;
		assigns = wrapper.assigns;
	}
	return { given: undefined, cleared };
}

/**
 * Whether `env`'s options take `name` out of the environment it runs
 * its command with: `-i`, `-` or `--ignore-environment` empty it, and
 * `-u` or `--unset` naming the variable takes it out. It runs them
 * before the variables it sets.
 */
function envClears(options: readonly string[], name: string): boolean {
	return options.some(
		(option, at) =>
			EMPTIES.has(option) ||
			option === `-u${name}` ||
			option === `--unset=${name}` ||
			((option === "-u" || option === "--unset") && options[at + 1] === name),
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
 * What the shell knows of `name` after a step: an `export` sets and
 * exports it, an `export -n` keeps it from the commands the shell runs,
 * an `unset` clears it, and a step of assignments alone sets it,
 * exported only if it was.
 */
function afterStep(step: string, name: string, variable: Variable): Variable {
	const [first, ...rest] = step.trim().split(/\s+/).filter(Boolean);
	if (first === "unset") {
		return rest.includes(name)
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
		const names = word === name || set?.[1] === name;
		if (set?.[1] === name) value = set[2];
		if (exporting && names) exported = !unexporting;
	}
	return { value, exported };
}
