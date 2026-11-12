/**
 * A verb: one thing the person can ask of a model over what they have
 * selected, offered by the launcher. Each is a markdown file named for
 * it: front matter saying its words, what its answer does (`say` shows
 * it, `replace` puts it over the selection, `hand` gives it to an agent),
 * whether it waits for Return, the arguments it takes and the prompt it
 * asks, and a body that is its system prompt. The prompt names the
 * selection and each argument in double braces, and asks of the
 * selection alone when it names nothing.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { isRecord } from "../record.ts";

/** What a verb's answer does. */
const RESULTS = ["say", "replace", "hand"] as const;

/** What a verb's answer does: shown, put over the selection, or handed on. */
type VerbResult = (typeof RESULTS)[number];

/** One argument a verb takes, and the words the launcher asks it with. */
interface VerbArg {
	readonly name: string;
	readonly words: string;
}

/** A verb as its file says it. */
export interface Verb {
	readonly id: string;
	readonly words: string;
	readonly says: string;
	readonly result: VerbResult;
	readonly disruptive: boolean;
	readonly args: readonly VerbArg[];
	readonly system: string;
	readonly prompt: string;
}

/** The place in a prompt the selection goes. */
const SELECTION = "selection";

/** What a verb, or an argument, may be named. */
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** A place in a prompt, named in double braces. */
const PLACE = /\{\{\s*([a-z][a-z0-9-]*)\s*\}\}/g;

/** A file's front matter and the body after it. */
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** A file in a verb folder that says what the folder holds, not a verb. */
const NOT_A_VERB = "README.md";

/**
 * The verb a file holds, named `id`, or what about it is refused, in
 * words that finish "refused because ...".
 */
export function parseVerb(
	id: string,
	text: string,
): { verb: Verb } | { problem: string } {
	if (!NAME.test(id)) {
		return {
			problem: `its name, ${id}, is not lower-case words joined by hyphens`,
		};
	}
	const split = FRONT_MATTER.exec(text);
	if (!split) return { problem: "it opens with no front matter" };
	let front: unknown;
	try {
		front = parseYaml(split[1] ?? "");
	} catch (error) {
		return { problem: `its front matter is not YAML: ${String(error)}` };
	}
	if (!isRecord(front)) return { problem: "its front matter is no mapping" };
	const words = nonEmpty(front.words);
	if (!words) return { problem: "it says no words" };
	const result = RESULTS.find((one) => one === front.result);
	if (!result) {
		return {
			problem: `its result is ${String(front.result)}, not say, replace or hand`,
		};
	}
	const args = argsOf(front.args);
	if (typeof args === "string") return { problem: args };
	const prompt = nonEmpty(front.prompt) ?? `{{${SELECTION}}}`;
	const named = new Set(args.map((arg) => arg.name));
	for (const [, place] of prompt.matchAll(PLACE)) {
		if (place !== SELECTION && place && !named.has(place)) {
			return { problem: `its prompt names ${place}, which no argument is` };
		}
	}
	return {
		verb: {
			id,
			words,
			says: nonEmpty(front.says) ?? "",
			result,
			disruptive: front.disruptive === true,
			args,
			system: (split[2] ?? "").trim(),
			prompt,
		},
	};
}

/** A verb's arguments, or what is wrong with them. */
function argsOf(raw: unknown): VerbArg[] | string {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) return "its arguments are no list";
	const args: VerbArg[] = [];
	for (const arg of raw) {
		if (!isRecord(arg)) return "an argument is no mapping";
		const name = nonEmpty(arg.name);
		if (!name) return "an argument has no name";
		if (!NAME.test(name) || name === SELECTION) {
			return `an argument's name, ${name}, is not one a prompt can name`;
		}
		args.push({ name, words: nonEmpty(arg.words) ?? name });
	}
	return args;
}

/**
 * The prompt a verb asks of `selection` with `args`, each put in its
 * place as it stands, so braces in what was selected stay text; an
 * argument not given is left empty. An argument the verb doesn't take is
 * refused.
 */
export function fillVerb(
	verb: Verb,
	args: Readonly<Record<string, string>>,
	selection: string,
): { prompt: string } | { problem: string } {
	const taken = new Set(verb.args.map((arg) => arg.name));
	for (const name of Object.keys(args)) {
		if (!taken.has(name)) {
			return { problem: `${verb.id} takes no argument named ${name}` };
		}
	}
	const prompt = verb.prompt.replace(PLACE, (_whole, place: string) =>
		place === SELECTION ? selection : (args[place] ?? ""),
	);
	return { prompt };
}

/**
 * What the launcher lists of a verb, keyed as every daemon's records
 * are: what it is called and does, never its prompts.
 */
export function verbRecord(verb: Verb): Record<string, unknown> {
	return {
		key: `verb:${verb.id}`,
		kind: "verb",
		id: verb.id,
		words: verb.words,
		says: verb.says,
		result: verb.result,
		disruptive: verb.disruptive,
		args: verb.args.map((arg) => ({ name: arg.name, words: arg.words })),
	};
}

/**
 * Every verb the folders hold, a later folder's taking a name over an
 * earlier one's, so the person's own replace the package's; and each
 * file refused, with why. A folder that isn't there holds none.
 */
export function readVerbs(folders: readonly string[]): {
	verbs: Map<string, Verb>;
	problems: { file: string; problem: string }[];
} {
	const verbs = new Map<string, Verb>();
	const problems: { file: string; problem: string }[] = [];
	for (const folder of folders) {
		for (const file of verbFiles(folder)) {
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch (error) {
				problems.push({ file, problem: `it can't be read: ${String(error)}` });
				continue;
			}
			const read = parseVerb(basename(file, ".md"), text);
			if ("problem" in read) problems.push({ file, problem: read.problem });
			else verbs.set(read.verb.id, read.verb);
		}
	}
	return { verbs, problems };
}

/** The verb files a folder holds, by name; none when it isn't there. */
function verbFiles(folder: string): string[] {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		// A folder that isn't there, as the person's own until they make
		// one, holds no verbs.
		return [];
	}
	return names
		.filter((name) => name.endsWith(".md") && name !== NOT_A_VERB)
		.sort()
		.map((name) => join(folder, name));
}

/** A non-empty string, trimmed, or nothing. */
function nonEmpty(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
