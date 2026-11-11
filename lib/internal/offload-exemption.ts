/**
 * The agent fence's one exemption: a `nix-offload there` call, alone and
 * of plain words, run outside the fence, since its ssh logs in to the
 * lent builders with a key the fence hides (`HIDDEN` in `fence.ts`), to
 * builders whose host keys are new each time. What may go out, and the
 * environment and git it is given there, is decided here.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { quoted } from "./sandbox-shell.ts";

/**
 * nix-offload, run outside the fence until the SSH agent's proxy lets
 * the fence reach the builders: the store's own binary, and the store's
 * `env` to start it with an environment of its own.
 */
export interface Offload {
	readonly program: string;
	readonly env: string;
}

/**
 * The day the nix-offload exemption is due out: the SSH agent's proxy
 * (the fence's fourth piece) lets the fence reach the builders by then,
 * and a test fails from this day while the exemption is still here.
 */
export const OFFLOAD_EXEMPTION_ENDS = "2026-11-13";

/** A word with no meaning to a shell: no quote, expansion, glob or redirect. */
const PLAIN_WORD = /^[A-Za-z0-9._/@:=+^*-]+$/;

/** A `nix-offload there` call alone, its arguments plain words. */
const OFFLOAD_CALL =
	/^nix-offload[ \t]+there(?:[ \t]+[A-Za-z0-9._/@:=+^*-]+)*$/;

/** One `cd` into a folder, then the call: the form changed-checks needs. */
const CD_CALL = /^cd[ \t]+(\S+)[ \t]*&&[ \t]*(nix-offload[ \t].*)$/;

/**
 * Flags that build, wait or keep running on this machine rather than a
 * builder, which the exemption never lets out: what runs here should run
 * fenced, as any other command here does. `--out` copies a build's files
 * into any folder it names, which outside the fence would write where a
 * fenced command can't, such as `~/.config/systemd/user`.
 */
const LOCAL_FLAGS = [
	"--here",
	"--here-when-idle",
	"--outlive",
	"--out",
] as const;

/**
 * A git folder no account can make, given as `GIT_DIR` to a call outside
 * any held tree, so no git it runs reads a `.git` a fenced command wrote.
 */
export const NO_GIT_DIR = "/var/empty/no-git";

/** What the work tool vouches for in a held tree: it and its git folder. */
export interface HeldGit {
	readonly folder: string;
	readonly gitDir: string;
}

/** Whether `word` names a path in the Nix store, through every link. */
function storeWord(word: string): boolean {
	return (
		word.startsWith("/nix/store/") &&
		!word.split("/").includes("..") &&
		inStore(word) !== undefined
	);
}

/**
 * Whether a call's arguments may run outside the fence: none of the flags
 * that work here, and a `--run` only when everything it copies and the
 * command it runs are the store's, which a fenced command can't change.
 * The builder runs a `--run` as an account its Nix doesn't trust.
 */
function letOut(words: readonly string[]): boolean {
	const here = (word: string) =>
		LOCAL_FLAGS.some((flag) => word === flag || word.startsWith(`${flag}=`));
	if (words.some(here)) return false;
	if (!words.includes("--run")) return true;
	const end = words.indexOf("--");
	if (end === -1) return false;
	const options = words.slice(0, end);
	if (options.some((word) => word.startsWith("--copy="))) return false;
	for (const [at, word] of options.entries()) {
		if (word !== "--copy") continue;
		const copied = options[at + 1];
		if (copied === undefined || !storeWord(copied)) return false;
	}
	const command = words[end + 1];
	return command !== undefined && storeWord(command);
}

/** The only folders on the exemption's `PATH`: the system's own programs. */
function systemPath(user: string | undefined): string {
	const own =
		user && /^[a-z_][a-z0-9_-]*$/.test(user)
			? [`/etc/profiles/per-user/${user}/bin`]
			: [];
	return [...own, "/run/current-system/sw/bin"].join(":");
}

/** Where an exempt call runs, and how a `cd` folder is vouched for. */
export interface OffloadPlace {
	readonly home: string;
	readonly env: NodeJS.ProcessEnv;
	/**
	 * The folder as it really is, when it is a tree the work tool holds
	 * for this session, named without a link, whose git links check out;
	 * nothing otherwise, and nothing when it isn't given.
	 */
	readonly heldTree?: (folder: string) => HeldGit | undefined;
	/** The folder the command runs in, where a bare call runs. */
	readonly cwd?: string;
	/**
	 * The folder as it really is, with its git folder, when it is a tree
	 * the session holds or a checkout whose git folder the fence keeps
	 * read-only; nothing otherwise.
	 */
	readonly folderGit?: (folder: string) => HeldGit | undefined;
}

/**
 * The shell text that runs a `nix-offload there` call outside the fence,
 * or nothing for any other command, which stays fenced. Only a call
 * alone, of plain words, is let out, or one `cd` into a tree the session
 * holds before it, which changed-checks needs, since it finds its
 * repository from the folder it runs in: anything else chained on,
 * quoted, substituted or expanded stays in, and so does a call with a
 * flag that works on this machine, or a `--run` of anything but the
 * store's (`letOut`). It runs the store's binary by its path with the
 * call's own words, in an environment of its own: the home and runtime
 * folders, the account's name, the system's `PATH`, and nothing from
 * the shell that asked.
 *
 * The checks hold only as they run, while nix-offload and changed-checks
 * run git for minutes after, and a fenced command could point the tree's
 * `.git` at a git folder it made, whose config names a program to run.
 * So git is told where to look and never reads `.git` again: the held
 * tree's own git folder, which the fence keeps read-only. A bare call
 * runs in the command's own folder, and `--run` always sends the commit
 * there, so that folder is held the same way when it is a held tree or
 * a checkout the fence guards. In any other folder git is given one that
 * can't exist, so a flake named by a path, or a `--run`, fails rather
 * than read a `.git` a command wrote. `core.fsmonitor` is off either way.
 */
export function offloadedOutside(
	command: string,
	offload: Offload | undefined,
	place: OffloadPlace,
): string | undefined {
	if (!offload) return undefined;
	let call = command.trim();
	let held: HeldGit | undefined;
	const cd = CD_CALL.exec(call);
	if (cd) {
		const [, named = "", rest = ""] = cd;
		if (!(PLAIN_WORD.test(named) && named.startsWith("/"))) return undefined;
		held = place.heldTree?.(named);
		if (held === undefined) return undefined;
		call = rest.trim();
	} else if (place.cwd !== undefined) {
		held = place.folderGit?.(place.cwd);
	}
	if (!OFFLOAD_CALL.test(call)) return undefined;
	const words = call.split(/[ \t]+/).slice(1);
	if (!letOut(words.slice(1))) return undefined;
	const user = place.env.USER;
	const environment = [
		`HOME=${place.home}`,
		`PATH=${systemPath(user)}`,
		...(user ? [`USER=${user}`, `LOGNAME=${user}`] : []),
		...(place.env.XDG_RUNTIME_DIR
			? [`XDG_RUNTIME_DIR=${place.env.XDG_RUNTIME_DIR}`]
			: []),
		...(held
			? [`GIT_DIR=${held.gitDir}`, `GIT_WORK_TREE=${held.folder}`]
			: [`GIT_DIR=${NO_GIT_DIR}`, "GIT_CEILING_DIRECTORIES=/"]),
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0=core.fsmonitor",
		"GIT_CONFIG_VALUE_0=false",
	];
	// Named env, since the store's may be coreutils' one binary for every
	// program, which acts by the name it is started with.
	return [
		...(held ? ["cd", quoted(held.folder), "&&"] : []),
		"exec -a env",
		quoted(offload.env),
		"-i",
		...environment.map(quoted),
		quoted(offload.program),
		...words.map(quoted),
	].join(" ");
}

/** A program's own path in the Nix store, through every link, or nothing. */
export function inStore(path: string | undefined): string | undefined {
	if (!path) return undefined;
	// Resolved first, so a `..` can't climb out of the store by name.
	let own = resolve(path);
	try {
		own = realpathSync(own);
	} catch {
		// Not there to follow: judged by its name, since nothing runs from it.
	}
	return own.startsWith("/nix/store/") ? own : undefined;
}
