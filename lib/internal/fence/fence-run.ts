/**
 * A command fenced for a caller outside pi (`scripts/pi-fence.ts`), such
 * as the mycelium node starting an agent's `mycelium run`: the same
 * fence pi's own commands get, so nothing outside keeps a copy of its
 * rules to drift (ISXEG8, a735ba8b).
 *
 * - **fence** is the agent fence as a fenced session's bash has it
 *   (`sandbox.ts`'s `wrapFor`): bubblewrap's root, then landrun with
 *   every path and only the listed sockets.
 * - **strict** is the strict profile's landrun, which reads and runs only
 *   what it lists and writes only the folder and its own, inside the
 *   fence's bubblewrap root: the runtime folder emptied, X's sockets
 *   gone, the home's secrets hidden. Either layer alone refuses the
 *   person's sockets on a current kernel; both stand, so an older
 *   kernel's Landlock that let a connect through still finds nothing
 *   there.
 *
 * On a Mac, fence is a sandbox-exec profile read from the same mounts
 * (`fence-seatbelt.ts`), and a Mac without sandbox-exec refuses. Strict
 * is refused there: its profile reads the whole home folder but what it
 * hides, so it can't keep strict's promise to read only what it lists,
 * and a caller sending strict work to it would get the weaker fence
 * (ISXEG8, 16 November).
 *
 * The folder is where the command runs and what it may write, the
 * working directory when none is named. One that is the home folder,
 * holds it, or holds its repository's git folder is refused, since its
 * writes would reach what runs outside later. So is one inside a path
 * the fence hides or keeps read-only, but the work broker's trees: the
 * folder is granted to the command, which would reopen what the fence
 * closed there. A machine without
 * bubblewrap or landrun in the system's own profile refuses too: nothing
 * runs unfenced because the fence couldn't be laid.
 */

import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { quoted } from "../sandbox/sandbox-shell.ts";
import { sessionWorktrees } from "../sandbox/sandbox-trees.ts";
import {
	SANDBOX_VARIABLE,
	type Sandbox,
	STRICT,
	sandboxedCommand,
	sandboxFolders,
	sandboxFor,
	strictRules,
	unfencedFolder,
	wrapFor,
} from "../sandbox.ts";
import { real, worktreeRepository } from "../tree-git.ts";
import { cutTreeDir } from "../work-records.ts";
import { fenceArgs } from "./fence.ts";
import { dockerHoldsCredentials } from "./fence-docker.ts";
import { FENCE_HIDDEN } from "./fence-hidden.ts";
import { readOnlyPaths } from "./fence-home.ts";
import { fenceNpmrc } from "./fence-npmrc.ts";
import {
	SANDBOX_EXEC,
	seatbeltProfile,
	seatbeltText,
} from "./fence-seatbelt.ts";

/** The fences a caller may ask for, by the names pi's sessions use. */
export const FENCE_RUN_KINDS = ["fence", STRICT] as const;

/** A fence a caller may ask for. */
export type FenceRunKind = (typeof FENCE_RUN_KINDS)[number];

/** What a caller asked to run, and in which fence. */
export interface FenceRunAsk {
	readonly kind: FenceRunKind;
	/** Where it runs and what it may write, as asked. */
	readonly folder: string;
	/** The program and its arguments, as given after `--`. */
	readonly words: readonly string[];
}

/** How pi-fence is asked, said when it was asked wrongly. */
export const FENCE_RUN_USAGE =
	"usage: pi-fence --kind fence|strict [--folder DIR] -- PROGRAM [ARGUMENT...], or pi-fence census [--proc DIR]";

/** What `pi-fence --help` says, each line within 60 columns. */
export const FENCE_RUN_HELP = `pi-fence runs one command in pi's own agent fence.

Usage:
  pi-fence --kind KIND [--folder DIR] -- PROGRAM [ARG...]
  pi-fence census [--proc DIR]

Kinds:
  fence    the agent fence a pi session lays
  strict   the strict Landlock profile inside its root

On a Mac fence runs under sandbox-exec, and strict is
refused.

Options:
  --folder DIR   where it runs and may write, the working
                 directory unless named
  --help         say this

It exits with the command's status, 126 when it refuses
to run, saying why, and 2 when asked wrongly.

The census judges every live session on this machine
by what its commands' processes show: proven fenced,
claimed by its environment while it runs none, or
unfenced. It reads /proc unless --proc names another.
It exits 0 only when it found a session and each was
seen fenced, a claimed one by a census in the last
day; 1 otherwise, or when the processes can't be read.
Linux only: on macOS it can't judge and exits 1.
`;

/**
 * What `args` ask for, run from `cwd`, or what is wrong with them, or
 * for its help when they open with `--help`: a kind is required, the folder is the working directory unless named,
 * and every word after `--` is the command's, flags included.
 */
export function fenceRunAsked(
	args: readonly string[],
	cwd: string,
):
	| FenceRunAsk
	| { readonly wrong: string }
	| { readonly help: true }
	| { readonly census: string } {
	if (args[0] === "--help" || args[0] === "-h") return { help: true };
	if (args[0] === "census") return censusAsked(args.slice(1));
	const split = args.indexOf("--");
	if (split === -1) return { wrong: `nothing follows --. ${FENCE_RUN_USAGE}` };
	const words = args.slice(split + 1);
	if (words.length === 0) {
		return { wrong: `no program follows --. ${FENCE_RUN_USAGE}` };
	}
	const options = args.slice(0, split);
	let kind: string | undefined;
	let folder: string | undefined;
	for (let at = 0; at < options.length; at += 2) {
		const [name, value] = [options[at], options[at + 1]];
		if (value === undefined) {
			return { wrong: `${name} needs a value. ${FENCE_RUN_USAGE}` };
		}
		if (name === "--kind") kind = value;
		else if (name === "--folder") folder = value;
		else return { wrong: `${name} is no option. ${FENCE_RUN_USAGE}` };
	}
	const known = FENCE_RUN_KINDS.find((each) => each === kind);
	if (known === undefined) {
		return {
			wrong: `--kind ${kind ?? "is missing"}: it is fence or strict. ${FENCE_RUN_USAGE}`,
		};
	}
	return { kind: known, folder: folder ?? cwd, words };
}

/** The /proc a census was asked to read, or what is wrong with asking. */
function censusAsked(
	args: readonly string[],
): { readonly census: string } | { readonly wrong: string } {
	if (args.length === 0) return { census: "/proc" };
	const [name, value, ...rest] = args;
	if (name !== "--proc" || value === undefined || rest.length > 0) {
		return { wrong: `census takes only --proc DIR. ${FENCE_RUN_USAGE}` };
	}
	return { census: value };
}

/** Where a fenced run takes its machine from; tests give their own. */
export interface FenceRunPlace {
	readonly env: NodeJS.ProcessEnv;
	readonly home: string;
	/** The fence this machine can lay, `sandbox.ts`'s reading of it. */
	readonly sandbox?: Sandbox;
	/** The system it runs on, this one's unless given. */
	readonly platform?: NodeJS.Platform;
	/** On a Mac, sandbox-exec, or nothing where it isn't there. */
	readonly sandboxExec?: string | undefined;
	/** Where the work broker cuts trees, its own unless given. */
	readonly treesRoot?: string;
}

/** The Nix daemon's socket on a Mac, which a fenced command builds through. */
const MAC_NIX_DAEMON = "/nix/var/nix/daemon-socket/socket";

/**
 * The shell text that runs `ask` fenced, to be run by bash in its
 * folder, or why it can't be.
 */
export function fenceRunText(
	ask: FenceRunAsk,
	place: FenceRunPlace,
):
	| { readonly folder: string; readonly text: string }
	| { readonly refused: string } {
	const folder = real(ask.folder);
	const { home } = place;
	const env: NodeJS.ProcessEnv = {
		...place.env,
		[SANDBOX_VARIABLE]: "fence",
	};
	const asker = `pi-fence --kind ${ask.kind}`;
	const unfenced =
		unfencedFolder(folder, home, asker) ??
		fencedAway(folder, home, asker, place.treesRoot ?? cutTreeDir());
	if (unfenced) return { refused: unfenced };
	if ((place.platform ?? process.platform) === "darwin") {
		if (ask.kind === STRICT) return { refused: MAC_NOT_STRICT };
		return macFenceText(ask, folder, place);
	}
	const sandbox = place.sandbox ?? sandboxFor(env);
	if (sandbox.kind !== "fence") {
		return {
			refused:
				sandbox.kind === "refused"
					? sandbox.reason
					: "this machine lays no fence, so nothing runs",
		};
	}
	const command = ask.words.map(quoted).join(" ");
	if (ask.kind === "fence") {
		const wrap = wrapFor(sandbox, { cwd: folder, env }, home);
		return wrap
			? { folder, text: wrap(command) }
			: { refused: "this machine lays no fence, so nothing runs" };
	}
	// landrun skips a path that isn't there, and nothing inside could
	// make one, so the strict profile's own folders are made first.
	for (const own of Object.values(sandboxFolders(home))) {
		mkdirSync(own, { recursive: true, mode: 0o700 });
	}
	const runtimeDir = env.XDG_RUNTIME_DIR;
	const inner = sandboxedCommand(
		command,
		strictRules({
			home,
			runtimeDir,
			cwd: folder,
			repository: worktreeRepository(folder, home),
		}),
		sandbox.landrun,
	);
	const root = fenceArgs({
		home,
		runtimeDir,
		...sessionWorktrees(folder, undefined),
		npmrc: fenceNpmrc(home, runtimeDir),
		docker: dockerHoldsCredentials(home),
	});
	return {
		folder,
		text: [
			quoted(sandbox.bwrap),
			...root.map(quoted),
			"-- bash -c",
			quoted(inner),
		].join(" "),
	};
}

/** Why a Mac refuses strict, naming what it runs instead. */
const MAC_NOT_STRICT =
	"pi-fence --kind strict won't run on a Mac: its fence reads the whole home folder but what it hides, so it can't read only what strict lists. Ask for --kind fence.";

/**
 * Why a run can't have `folder`: it lies inside a path the fence hides
 * or keeps read-only, where granting the command its folder would reopen
 * what the fence closed (its keys in ~/.ssh, git's settings and hooks in
 * ~/.config). The work broker's trees, in pi's own state, are spared,
 * since the fence binds each writable for whoever works in it.
 */
function fencedAway(
	folder: string,
	home: string,
	asker: string,
	treesRoot: string,
): string | undefined {
	const inside = (path: string) =>
		folder === path || folder.startsWith(`${path}/`);
	if (inside(real(treesRoot)) && folder !== real(treesRoot)) return undefined;
	const hidden = FENCE_HIDDEN.home
		.filter((entry) => entry.endsWith("/"))
		.map((entry) => join(home, entry.slice(0, -1)));
	const closed = [...hidden, ...readOnlyPaths(home)].find(inside);
	return closed
		? `${asker} won't run in ${folder}, which lies in ${closed}, a path the fence hides or keeps read-only, so no command runs. Start it in the folder it works on, or in a tree the work tool cuts.`
		: undefined;
}

/**
 * The shell text that runs `ask` in the Mac's fence: the fence's own
 * mounts for `folder` as a sandbox-exec profile, reaching the Nix
 * daemon. A Mac without sandbox-exec refuses, so nothing runs unfenced.
 */
function macFenceText(
	ask: FenceRunAsk,
	folder: string,
	place: FenceRunPlace,
):
	| { readonly folder: string; readonly text: string }
	| { readonly refused: string } {
	const sandboxExec =
		"sandboxExec" in place
			? place.sandboxExec
			: existsSync(SANDBOX_EXEC)
				? SANDBOX_EXEC
				: undefined;
	if (sandboxExec === undefined) {
		return {
			refused: `the fence on a Mac needs ${SANDBOX_EXEC}, which isn't there, so nothing runs`,
		};
	}
	const { home } = place;
	// The Mac has no runtime folder, so the copy of npm's settings goes
	// in the person's own temporary folder, which commands there write
	// too, so pi's folder in it is kept from them below.
	const npmrc = fenceNpmrc(home, place.env.TMPDIR);
	const copy = npmrc === "/dev/null" ? undefined : npmrc;
	const mounts = fenceArgs({
		home,
		runtimeDir: undefined,
		...sessionWorktrees(folder, undefined),
		...(npmrc ? { npmrc } : {}),
		docker: dockerHoldsCredentials(home),
	});
	// The copy sits in the person's temporary folder, which commands
	// write: its folder is kept from writes, so none can change what the
	// next run reads, or put a link there for the next copy to follow.
	const kept = copy ? ["--ro-bind", dirname(copy), dirname(copy)] : [];
	const { profile } = seatbeltProfile([...mounts, ...kept], {
		sockets: [MAC_NIX_DAEMON],
		home,
		path: (place.env.PATH ?? "").split(":").filter(Boolean),
		folder,
	});
	return {
		folder,
		text: seatbeltText(
			[
				...macSettings(home, copy),
				// exec, so the command takes the sandbox's shell's place rather
				// than running as its child.
				`exec ${ask.words.map(quoted).join(" ")}`,
			].join("; "),
			profile,
			sandboxExec,
		),
	};
}

/**
 * What a command in the Mac's fence is pointed at before it runs. Caches
 * go to `~/.cache`, which the fence lets commands write, rather than
 * `~/Library/Caches`, which it keeps read-only beside the rest of
 * `~/Library`: go, pip and every program honouring XDG's settings would
 * otherwise fail to cache. npm reads its settings from the copy without
 * their tokens, since a Mac's fence can hide a file but not bind another
 * over it (ISXEG8, 16 November).
 */
function macSettings(home: string, npmCopy: string | undefined): string[] {
	const cache = join(home, ".cache");
	// Only where the fence lets commands write ~/.cache, and never over
	// the person's own choice of where a cache goes.
	const caches =
		existsSync(cache) && lstatSync(cache).isDirectory()
			? [
					["XDG_CACHE_HOME", cache],
					["GOCACHE", join(cache, "go-build")],
					["PIP_CACHE_DIR", join(cache, "pip")],
				].map(
					([name, path]) =>
						`[ -n "\${${name}:-}" ] || export ${name}=${quoted(path ?? "")}`,
				)
			: [];
	return [
		...caches,
		...(npmCopy ? [`export NPM_CONFIG_USERCONFIG=${quoted(npmCopy)}`] : []),
	];
}
