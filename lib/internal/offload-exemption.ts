/**
 * The agent fence's one exemption: a `nix-offload there` call, alone and
 * of plain words, run outside the fence, since its ssh logs in to the
 * lent builders with a key the fence hides (`HIDDEN` in `fence.ts`), to
 * builders whose host keys are new each time. What may go out, and the
 * environment and git it is given there, is decided here.
 *
 * Only what reads nothing a fenced command chose goes out: derivations
 * already in the store. A flake never does. nix-offload sends a flake that
 * isn't a git tree here, or any `path:` one, as its whole folder, read as
 * the person, so a fenced command naming `path:~/.config/gh` would have
 * shipped that folder to a builder; and `--changed` sends a tree to an
 * evaluator, a machine of the person's own where nothing lent is up,
 * whose `--impure` evaluation of a flake the command wrote reads that
 * machine's files as the person. So a flake, a tree's checks and
 * `--changed` are evaluated inside the fence, through the untrusted
 * daemon's socket, and what they name is handed on as derivations
 * (ISXEG8, 11 November).
 *
 * A `--run` stays in too, for now. nix-offload commits a tree's changes
 * from its index and files, both of which a fenced command can write:
 * an index entry naming a gitlink whose `.git` points at a repository
 * the fence hides has that repository's HEAD read and sent, an
 * alternates file reaches its objects, and the tree's attributes pick
 * the filters git runs. It goes out again once nix-offload sends a held
 * tree's committed objects alone, refusing alternates and gitlinks.
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
 * The day the nix-offload exemption is due out: a broker holds the
 * builders' key by then, so nothing goes out of the fence to reach them,
 * and a test fails from this day while the exemption is still here.
 */
export const OFFLOAD_EXEMPTION_ENDS = "2026-11-28";

/** A word with no meaning to a shell: no quote, expansion, glob or redirect. */
const PLAIN_WORD = /^[A-Za-z0-9._/@:=+^*-]+$/;

/** A `nix-offload there` call alone, its arguments plain words. */
const OFFLOAD_CALL =
	/^nix-offload[ \t]+there(?:[ \t]+[A-Za-z0-9._/@:=+^*-]+)*$/;

/** One `cd` into a folder, then the call, as a tree's work is run from. */
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
 * The flags a derivations' build may carry out: its logs, going on past
 * a failure, printing what it built, and how it waits its turn. Any other
 * keeps the call fenced.
 */
const DERIVATION_FLAGS = [
	"-L",
	"--print-build-logs",
	"--keep-going",
	"--print-out-paths",
	"--bulk",
	"--first",
	"--never-ask",
] as const;

/** A derivation's path in the store, with the outputs wanted or without. */
const DERIVATION =
	/^\/nix\/store\/[0-9a-z]{32}-[^/]+\.drv(?:\^[A-Za-z0-9_,*-]+)?$/;

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

/** Whether `word` names a derivation in the store, through every link. */
function derivationWord(word: string): boolean {
	const [path = ""] = word.split("^");
	return DERIVATION.test(word) && storeWord(path);
}

/**
 * Whether a call's arguments may run outside the fence: derivations in
 * the store alone, with only the flags a build of them takes, so none
 * that works on this machine.
 */
function letOut(words: readonly string[]): boolean {
	const flag = (word: string) =>
		DERIVATION_FLAGS.some((known) => known === word);
	return (
		words.some(derivationWord) &&
		words.every((word) => flag(word) || derivationWord(word))
	);
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
 * holds before it: anything else chained on, quoted, substituted or
 * expanded stays in, and so does anything but derivations (`letOut`).
 * It runs the store's binary by its path with the call's own words, in an environment of its own: the home and runtime
 * folders, the account's name, the system's `PATH`, and nothing from
 * the shell that asked.
 *
 * A derivations' build reads no git, but nix-offload may run some for
 * minutes, and a fenced command could point a tree's `.git` at a git
 * folder it made, whose config names a program to run. So git is told
 * where to look and never reads `.git` again: in a held tree or a
 * checkout the fence guards, its own git folder, which the fence keeps
 * read-only, and anywhere else a folder that can't exist.
 * `core.fsmonitor` is off either way.
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

/**
 * Why a lone `nix-offload there` call the exemption keeps in is refused,
 * with what to run instead, or nothing for any other command. Inside, it
 * has no key to reach a builder and would end saying only that ssh
 * couldn't: so a call that would go to one is refused up front. One that
 * builds here (`--here` and the like) runs fenced as any build does, and
 * `--takes` only says what nix-offload takes.
 */
export function offloadKeptIn(command: string): string | undefined {
	const call = CD_CALL.exec(command.trim())?.[2] ?? command.trim();
	if (!OFFLOAD_CALL.test(call)) return undefined;
	const words = call.split(/[ \t]+/).slice(2);
	const here = (word: string) =>
		LOCAL_FLAGS.some((flag) => word === flag || word.startsWith(`${flag}=`));
	if (words.some(here) || words.join(" ") === "--takes") return undefined;
	return [
		"The agent fence sends only derivations to the builders: a flake, a path: folder or --changed would be read or evaluated as the person outside it, and a --run would commit the tree from an index and files a fenced command can write.",
		"Evaluate inside first (`nix eval --raw <flake>#<attribute>.drvPath`, or `nix path-info --derivation <flake>#<attribute>`), then run `nix-offload there <drv>^*` with each path written out as printed. A --run goes out again once nix-offload sends only a tree's committed objects.",
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
