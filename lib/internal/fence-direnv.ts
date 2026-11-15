/**
 * direnv inside the agent fence. The person's allow list stays
 * read-only there (`fence-home.ts`), so an `.envrc` a fenced command
 * approved never runs as the person in their own shell, where it would
 * run outside the fence. But that left every tree the work broker cut
 * unapproved inside, so `direnv exec .` in a new tree said it was
 * blocked and `direnv allow` failed on the read-only list (ISXEG8
 * [cb9b85fd], 15 November).
 *
 * So a fenced command's direnv reads settings of the fence's own,
 * through `DIRENV_CONFIG`: the person's library and `direnvrc` linked
 * in, as they are, and a `direnv.toml` trusting the work trees and the
 * quests' scratch folders. An `.envrc` there runs inside the fence, no
 * further than the command that asked for it could go itself, and the
 * person's own direnv never reads these settings. Where the person
 * keeps a `direnv.toml` of their own, theirs stands, and a refusal
 * names the way round instead.
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Block, routed } from "./fence-git-route.ts";

/** The variable that points direnv at its settings. */
const VARIABLE = "DIRENV_CONFIG";

/** The files direnv reads its settings from, of which the fence writes its own. */
const SETTINGS = ["direnv.toml", "config.toml"] as const;

/** The fence's own settings folder, within the sandbox's cache. */
const FOLDER = "direnv";

/**
 * The person's direnv settings folder: `DIRENV_CONFIG`, or `direnv`
 * in their configuration folder, as direnv finds it.
 */
export function personDirenvConfig(
	home: string,
	env: Readonly<Record<string, string | undefined>>,
): string {
	return (
		env[VARIABLE] ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), FOLDER)
	);
}

/**
 * Make the fence's own direnv settings in the sandbox cache `own`, from
 * the person's folder `person`, trusting every `.envrc` under each of
 * `trusted`, which direnv compares as real paths; and name the variable
 * and folder a fenced command is given. Nothing, when the person keeps
 * a settings file of their own or the folder can't be made: a fenced
 * direnv then reads the person's, as it did before.
 */
export function fenceDirenv(
	person: string,
	own: string,
	trusted: readonly string[],
): readonly [string, string] | undefined {
	const theirs = entriesOf(person);
	if (theirs.some((entry) => isSettings(entry))) return undefined;
	const folder = join(own, FOLDER);
	try {
		mkdirSync(folder, { recursive: true, mode: 0o700 });
		for (const entry of entriesOf(folder)) {
			if (isSettings(entry) || theirs.includes(entry)) continue;
			rmSync(join(folder, entry), { recursive: true, force: true });
		}
		for (const entry of theirs)
			linkTo(join(person, entry), join(folder, entry));
		writeWhole(join(folder, SETTINGS[0]), trusting(trusted));
	} catch {
		// A cache that can't be written leaves direnv reading the person's
		// settings, as it did before; a refusal still names the way round.
		return undefined;
	}
	return [VARIABLE, folder];
}

/** Whether `entry` is one of the files direnv reads its settings from. */
function isSettings(entry: string): boolean {
	return SETTINGS.some((name) => name === entry);
}

/** The names in `folder`, or none when it can't be read. */
function entriesOf(folder: string): string[] {
	try {
		return readdirSync(folder).sort();
	} catch {
		// No folder is no settings, as direnv itself reads it.
		return [];
	}
}

/** Point `link` at `target`, unless it already is. */
function linkTo(target: string, link: string): void {
	try {
		if (readlinkSync(link) === target) return;
	} catch {
		// Not a link yet, or not there: it's made below.
	}
	rmSync(link, { recursive: true, force: true });
	symlinkSync(target, link);
}

/** direnv's settings trusting every `.envrc` under each of `trusted`. */
function trusting(trusted: readonly string[]): string {
	const prefixes = trusted.map((path) => JSON.stringify(path)).join(", ");
	return `[whitelist]\nprefix = [${prefixes}]\n`;
}

/**
 * Write `text` to `path` whole, through a file beside it, so a fenced
 * direnv starting at the same moment reads the old or the new, never
 * half of either; a file that already says it is left alone.
 */
function writeWhole(path: string, text: string): void {
	try {
		if (readFileSync(path, "utf8") === text) return;
	} catch {
		// Not there yet: it's written below.
	}
	const half = `${path}.${process.pid}.${Date.now()}`;
	writeFileSync(half, text, { mode: 0o600 });
	renameSync(half, path);
}

/** The line a refused `.envrc` gains. */
export const DIRENV_ROUTE =
	"pi: direnv's allow list is read-only in the agent fence, so nothing approved inside runs in the person's own shell. An .envrc in a work tree (`work tree` cuts one) or a quest's scratch folder runs without approval: `direnv exec <tree> <command>`. For one elsewhere, run the checkout's from inside it: `direnv exec ~/src/<repo> <command>`.";

/** direnv's words for an `.envrc` it won't run, or a list it couldn't write. */
const REFUSED =
	/is blocked\. Run `direnv allow`|direnv\/allow\/\S*: read-only file system/;

/**
 * `content` with the route added after the block where direnv refused
 * an `.envrc` or couldn't approve one, `record` called once for it; or
 * undefined, when no block says so.
 */
export function routedDirenv<T extends Block>(
	content: readonly T[],
	record: () => void,
): T[] | undefined {
	return routed(content, REFUSED, DIRENV_ROUTE, record);
}
