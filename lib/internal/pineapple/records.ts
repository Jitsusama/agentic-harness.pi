/**
 * The safe word's own records are Joel's: no agent changes them.
 *
 * A stop ends only when Joel resumes it, and a stop is a file, so an
 * agent that could remove or rewrite one could resume a stop by itself,
 * which is the one thing the safe word must not allow. Neither may an
 * agent run `pineapple resume`, which refuses inside pi on its own, but
 * is refused here first so the refusal says why.
 *
 * Reading the records goes on: listing the stops, reading the shadow
 * logs, `pineapple-slack heard`. A command that names the folder and is
 * not plainly a read is refused, leaning toward stopping as Joel asked.
 */

import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { effectiveCwd, tokenize } from "../../command/index.ts";
import { unquote } from "../../shell/index.ts";
import { words } from "./writes.ts";

/** Programs that only read what they are pointed at. */
const READS = new Set([
	"cat",
	"less",
	"more",
	"head",
	"tail",
	"ls",
	"stat",
	"file",
	"tree",
	"wc",
	"jq",
	"grep",
	"rg",
	"bat",
	"du",
]);

/** What makes `find` more than a read. */
const FIND_ACTS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir"]);

/** The safe word's commands, and which of their verbs only read. */
const OWN_READS = new Map<string, ReadonlySet<string>>([
	["pineapple-slack", new Set(["heard", "help", "--help", "-h"])],
	["pineapple", new Set(["stops", "heard", "help", "--help", "-h"])],
]);

/** Where the folder lives, however a command spells it. */
const SPELLED =
	/(?:\.local\/state|\$\{?XDG_STATE_HOME\}?)\/pineapple(?:\/|$)|pineapple\/stops(?:\/|$)/;

/**
 * Why a tool call is refused for changing the safe word's records, or
 * undefined when it doesn't. `folder` is the records' folder, the
 * parent of the stops.
 */
export function changesRecords(
	tool: string,
	input: unknown,
	cwd: string,
	folder: string,
	home: string = homedir(),
): string | undefined {
	const fields =
		typeof input === "object" && input !== null
			? (input as Record<string, unknown>)
			: {};
	if (tool === "edit" || tool === "write") {
		const path = typeof fields.path === "string" ? fields.path : undefined;
		return path !== undefined && within(at(path, cwd, home), folder)
			? CHANGED
			: undefined;
	}
	if (tool !== "bash" || typeof fields.command !== "string") return undefined;
	return inBash(fields.command, cwd, folder, home);
}

function inBash(
	command: string,
	cwd: string,
	folder: string,
	home: string,
): string | undefined {
	const line = tokenize(command);
	if (!line.supported) {
		// Unreadable to the command model: refuse what names the folder or
		// a resume at all, since what it does there can't be told.
		if (/\bpineapple\s+resume\b/.test(command)) return RESUME;
		return command.includes(folder) || SPELLED.test(command)
			? CHANGED
			: undefined;
	}
	for (const simple of line.commands) {
		const argv = words(simple);
		if (argv[0] === "pineapple" && argv[1] === "resume") return RESUME;
		const here = effectiveCwd(line, cwd, simple.span.start);
		const dir = "dir" in here ? here.dir : undefined;
		const targets = simple.redirects.map((one) => ({
			writes: one.operator.includes(">"),
			path: one.target ? unquote(one.target.text) : "",
		}));
		const names = (text: string) =>
			text.includes(folder) ||
			SPELLED.test(text) ||
			(isAbsolute(text) && within(text, folder)) ||
			(text.startsWith("~/") && within(at(text, cwd, home), folder));
		const inside = dir !== undefined && within(dir, folder);
		const named =
			inside ||
			argv.some(names) ||
			targets.some((target) => names(target.path));
		if (!named) continue;
		if (targets.some((target) => target.writes && names(target.path)))
			return CHANGED;
		if (inside && targets.some((target) => target.writes)) return CHANGED;
		if (!onlyReads(argv)) return CHANGED;
	}
	return undefined;
}

function onlyReads(argv: readonly string[]): boolean {
	const program = argv[0];
	if (program === undefined) return true;
	if (READS.has(program)) return true;
	if (program === "find") return !argv.some((word) => FIND_ACTS.has(word));
	const verbs = OWN_READS.get(program);
	return verbs?.has(argv[1] ?? "help") ?? false;
}

function at(path: string, cwd: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return resolve(cwd, path);
}

function within(path: string, folder: string): boolean {
	const rel = relative(folder, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const CHANGED =
	"Only Joel resumes a safe-word stop, so its records aren't for an agent to change: reading them goes on, but this would change them. Leave them as they are and carry on with work the stop doesn't reach.";

const RESUME =
	"Only Joel resumes a safe-word stop, and never from inside pi: pineapple resume is his to run at his own terminal, or to press in the launcher.";
