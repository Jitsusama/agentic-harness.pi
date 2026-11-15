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
 *
 * The settings are written from outside, unfenced, so they live where
 * nothing inside can write: pi's folder in the runtime folder, which
 * the fence empties, bound back read-only. Written in a folder a
 * command could reach, a link planted in its place would have had this
 * write and delete, unfenced, wherever it pointed, Joel's own direnv
 * settings among them (ISXEG8 [3fcd33a5]). Each folder on the way is
 * still refused when it is a link or someone else's.
 */

import {
	lstatSync,
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
export const DIRENV_VARIABLE = "DIRENV_CONFIG";

/** The files direnv reads its settings from, of which the fence writes its own. */
const SETTINGS = ["direnv.toml", "config.toml"] as const;

/** pi's folder in the runtime folder, as `fence-copy.ts` names it. */
const PI_FOLDER = "pi-fence";

/** The fence's own settings folder, within pi's, and the person's within theirs. */
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
		env[DIRENV_VARIABLE] ??
		join(env.XDG_CONFIG_HOME ?? join(home, ".config"), FOLDER)
	);
}

/**
 * Make the fence's own direnv settings in pi's folder in the runtime
 * folder `runtimeDir`, from the person's folder `person`, trusting
 * every `.envrc` under each of `trusted`, which direnv compares as real
 * paths; and name the folder, which the fence binds read-only and a
 * fenced command's `DIRENV_VARIABLE` names. Nothing, when there is no
 * runtime folder, the person keeps a settings file of their own, or a
 * folder on the way is a link or someone else's or can't be made: a
 * fenced direnv then reads the person's, as it did before.
 */
export function fenceDirenv(
	person: string,
	runtimeDir: string | undefined,
	trusted: readonly string[],
): string | undefined {
	if (!runtimeDir) return undefined;
	const theirs = entriesOf(person);
	if (theirs.some((entry) => isSettings(entry))) return undefined;
	const pi = join(runtimeDir, PI_FOLDER);
	const folder = join(pi, FOLDER);
	try {
		// One level at a time, never the runtime folder itself: node's
		// recursive mkdir spins where a parent refuses a child, as /proc
		// does (`fence-copy.ts`).
		if (!ownFolder(pi) || !ownFolder(folder)) return undefined;
		for (const entry of entriesOf(folder)) {
			if (isSettings(entry) || theirs.includes(entry)) continue;
			// Only links and the settings file are made here, so nothing
			// is removed recursively: a folder found here is refused.
			rmSync(join(folder, entry), { force: true });
		}
		for (const entry of theirs)
			linkTo(join(person, entry), join(folder, entry));
		writeWhole(join(folder, SETTINGS[0]), trusting(trusted));
	} catch {
		// Settings that can't be written leave direnv reading the person's,
		// as it did before; a refusal still names the way round.
		return undefined;
	}
	return folder;
}

/**
 * Whether `folder` is a folder of this account's, not a link, made
 * when it isn't there yet.
 */
function ownFolder(folder: string): boolean {
	const found = lstatSync(folder, { throwIfNoEntry: false });
	if (found === undefined) {
		mkdirSync(folder, { mode: 0o700 });
		return true;
	}
	return (
		found.isDirectory() &&
		!found.isSymbolicLink() &&
		(process.getuid === undefined || found.uid === process.getuid())
	);
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
	// Never recursively: what stands here is a link or nothing, and a
	// folder in its place is refused by the throw.
	rmSync(link, { force: true });
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
