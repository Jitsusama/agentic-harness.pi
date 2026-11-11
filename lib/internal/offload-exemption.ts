/**
 * The agent fence's one exemption: a `nix-offload there` call, alone and
 * of plain words, run outside the fence, since its ssh logs in to the
 * lent builders with a key the fence hides (`HIDDEN` in `fence.ts`), to
 * builders whose host keys are new each time. What may go out, and the
 * environment and git it is given there, is decided here.
 *
 * Only what reads nothing a fenced command chose goes out: derivations
 * already in the store, and a held tree's commit. A flake never does.
 * nix-offload sends a flake that isn't a git tree here, or any `path:`
 * one, as its whole folder, read as the person, so a fenced command
 * naming `path:~/.config/gh` would have shipped that folder to a
 * builder. So a flake and a tree's named checks are evaluated inside the
 * fence, through the untrusted daemon's socket, and what they name is
 * handed on as derivations (ISXEG8, 11 November).
 *
 * A tree's commit goes out as `--changed` alone or a `--run` of programs
 * in the store, from a tree the work tool holds for the session, whose
 * `.git` file, way back and `commondir` the fence keeps read-only and
 * `heldTree` checks at the call. nix-offload sends that commit's objects
 * alone, refusing alternates and changes not committed, so nothing the
 * index or files say is read (core #3331). Each such call goes with
 * `NIX_OFFLOAD_LENT_ONLY=1`, set here rather than left to the caller,
 * so it reaches a lent builder or nothing: never an evaluator of the
 * person's own, whose `--impure` evaluation of a flake the command wrote
 * would read that machine's files as the person, and never this machine,
 * where `--changed` would run the commit's own changed-checks (ISXEG8,
 * 11 November). A checkout's refs are a fenced command's to write, so
 * only a held tree's commit goes.
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

/**
 * What a call sending a held tree's commit carries, so nix-offload keeps
 * it, and everything it starts, to the lent builders (core #3331).
 */
export const LENT_ONLY = "NIX_OFFLOAD_LENT_ONLY=1";

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

/**
 * Whether a call sends a tree's commit to a builder in a way the fence
 * lets out: `--changed` alone, the checks the commit changes, or `--run`
 * of a program in the store with only store paths copied up, after the
 * flags that say how it waits its turn.
 */
function sendsCommit(words: readonly string[]): boolean {
	let at = words[0] === "--never-ask" ? 1 : 0;
	while (words[at] === "--first" || words[at] === "--lent-only") at++;
	const [verb, ...rest] = words.slice(at);
	if (verb === "--changed") return rest.length === 0;
	return verb === "--run" && runsFromStore(rest);
}

/**
 * Whether a `--run`'s words copy up only store paths and run a program
 * in the store, with plain words after it for the program alone.
 */
function runsFromStore(words: readonly string[]): boolean {
	let at = 0;
	while (words[at] === "--copy" && storeWord(words[at + 1] ?? "")) at += 2;
	if (words[at] === "--longest" && /^\d+$/.test(words[at + 1] ?? "")) {
		at += 2;
	}
	return words[at] === "--" && storeWord(words[at + 1] ?? "");
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
 * expanded stays in, and so does anything but derivations (`letOut`) or,
 * from a held tree, its commit (`sendsCommit`), which goes to the lent
 * builders alone. It runs the store's binary by its path with the call's own words, in an environment of its own: the home and runtime
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
	// Only a tree the session holds sends its commit: a checkout's refs
	// are a fenced command's to point anywhere.
	let tree: HeldGit | undefined;
	const cd = CD_CALL.exec(call);
	if (cd) {
		const [, named = "", rest = ""] = cd;
		if (!(PLAIN_WORD.test(named) && named.startsWith("/"))) return undefined;
		held = place.heldTree?.(named);
		if (held === undefined) return undefined;
		tree = held;
		call = rest.trim();
	} else if (place.cwd !== undefined) {
		held = place.folderGit?.(place.cwd);
		tree = place.heldTree?.(place.cwd);
	}
	if (!OFFLOAD_CALL.test(call)) return undefined;
	const words = call.split(/[ \t]+/).slice(1);
	const sends = tree !== undefined && sendsCommit(words.slice(1));
	if (!(sends || letOut(words.slice(1)))) return undefined;
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
		...(sends ? [LENT_ONLY] : []),
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
		"The agent fence sends the builders only derivations, and the commit of a tree the work tool holds for this session: a flake or a path: folder would be read as the person outside it, and a checkout's commit is one a fenced command can point anywhere.",
		"Evaluate inside first (`nix eval --raw <flake>#<attribute>.drvPath`, or `nix path-info --derivation <flake>#<attribute>`), then run `nix-offload there <drv>^*` with each path written out as printed.",
		"From a held tree, `cd <tree> && nix-offload there --changed` alone, or `--run --copy <store path> -- <store path> <words>`, sends its commit to a lent builder.",
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
