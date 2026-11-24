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
 * On a Mac, both are a sandbox-exec profile read from the same mounts
 * (`fence-seatbelt.ts`): strict also keeps the home folder read-only
 * but for the folder, and a Mac without sandbox-exec refuses. Neither
 * reads pi's state, pi's agent folder or mycelium's, which hold every
 * realm's messages and sessions (ISXEG8, 16 November).
 *
 * The folder is where the command runs and what it may write, the
 * working directory when none is named. One that is the home folder,
 * holds it, or holds its repository's git folder is refused, since its
 * writes would reach what runs outside later. So is one inside a path
 * the fence hides or keeps read-only, but the work broker's trees: the
 * folder is granted to the command, which would reopen what the fence
 * closed there; so is one that holds such a path (unfenced-folder.ts,
 * which strict asks too). A machine without
 * bubblewrap or landrun in the system's own profile refuses too: nothing
 * runs unfenced because the fence couldn't be laid.
 */

import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	makeScratches,
	makeShares,
	questScratch,
} from "../sandbox/quest-folders.ts";
import {
	makeFoldersFirst,
	SANDBOX_VARIABLE,
	type Sandbox,
	STRICT,
	sandboxedCommand,
	sandboxFor,
	tooLong,
	wrapFor,
} from "../sandbox/sandbox.ts";
import { quoted } from "../sandbox/sandbox-shell.ts";
import { brokerTrees, sessionWorktrees } from "../sandbox/sandbox-trees.ts";
import {
	sandboxFolders,
	strictHomeReads,
	strictRules,
} from "../sandbox/strict-rules.ts";
import { real, worktreeRepository } from "../sandbox/tree-git.ts";
import { onDisk, unfencedFolder } from "../sandbox/unfenced-folder.ts";
import { cutTreeDir, treeRecordDir } from "../work-records.ts";
import { fenceArgs } from "./fence.ts";
import { BWRAP_MOST_ARGS, bwrapArgsFile } from "./fence-args-file.ts";
import { ARGS_FD } from "./fence-command.ts";
import type { Disk } from "./fence-disk.ts";
import { dockerHoldsCredentials } from "./fence-docker.ts";
import { REPOSITORY_HOMES } from "./fence-home.ts";
import { fenceNpmrc } from "./fence-npmrc.ts";
import {
	SANDBOX_EXEC,
	seatbeltProfile,
	seatbeltText,
} from "./fence-seatbelt.ts";
import {
	makeCachesFirst,
	plantedCache,
	setAsidePlanted,
	tempCodeCaches,
} from "./fence-temp-caches.ts";

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
	/**
	 * The caller's word that the asker holds the work broker's tree the
	 * folder lies in: the mycelium node's, for a quest's tree shared to
	 * whoever asked it. A fenced command saying it gains nothing, since a
	 * fence inside a fence only narrows.
	 */
	readonly shared?: boolean;
}

/** How pi-fence is asked, said when it was asked wrongly. */
export const FENCE_RUN_USAGE =
	"usage: pi-fence --kind fence|strict [--folder DIR] [--shared-tree] -- PROGRAM [ARGUMENT...], or pi-fence census [--proc DIR]";

/** What `pi-fence --help` says, each line within 60 columns. */
export const FENCE_RUN_HELP = `pi-fence runs one command in pi's own agent fence.

Usage:
  pi-fence --kind KIND [--folder DIR] [--shared-tree]
           -- PROGRAM [ARG...]
  pi-fence census [--proc DIR]

Kinds:
  fence    the agent fence a pi session lays
  strict   the strict Landlock profile inside its root

On a Mac both run under sandbox-exec. In the home,
strict reads what it reads on Linux, and also the git
folder of the tree it runs in, a held work tree whole,
and npm's settings without tokens; it writes there only
its folder. Outside the home it reads and writes what the
account can, /tmp and the Mac's temporary folder among
them, but for what the fence hides and the code caches
it keeps read-only there, and writes no program folder
outside its own.

Options:
  --folder DIR   where it runs and may write, the working
                 directory unless named
  --shared-tree  the folder lies in a work tree the asker
                 was shared; otherwise a work tree runs
                 only for the session holding it
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
	let shared = false;
	for (let at = 0; at < options.length; at += 2) {
		const [name, value] = [options[at], options[at + 1]];
		if (name === "--shared-tree") {
			shared = true;
			// A flag alone, so the next option starts one word on.
			at -= 1;
			continue;
		}
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
	return {
		kind: known,
		folder: folder ?? cwd,
		words,
		...(shared ? { shared } : {}),
	};
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

/** The text that runs what was asked and the folder it runs in, or why it can't run. */
type FenceRunMade =
	| { readonly folder: string; readonly text: string }
	| { readonly refused: string };

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
	/** The trees the asking session holds, by the broker's records unless given. */
	readonly heldTrees?: readonly string[];
	/** Where the work broker records who holds each tree, its own unless given. */
	readonly treeRecords?: string;
	/** The disk a Mac's profile is read from, the machine's unless given. */
	readonly disk?: Disk;
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
): FenceRunMade {
	const mac = (place.platform ?? process.platform) === "darwin";
	// On a Mac, as the volume spells it, so a name in other case or
	// folded otherwise is the folder it opens and no neighbour.
	const folder = mac ? onDisk(real(ask.folder)) : real(ask.folder);
	const { home } = place;
	const env: NodeJS.ProcessEnv = {
		...place.env,
		[SANDBOX_VARIABLE]: "fence",
	};
	const asker = `pi-fence --kind ${ask.kind}`;
	// Every path the held match compares spelled one way, the folder's,
	// so a home spelled otherwise than its volume neither refuses its
	// own trees nor loses a tree's .git to a root spelled apart.
	const spelling = (path: string) =>
		mac ? onDisk(real(resolve(path))) : real(resolve(path));
	const treesRoot = spelling(place.treesRoot ?? cutTreeDir());
	// The fence lays the temporary folder's code caches as its own, and a
	// Mac's profile denies them again, so a folder such as /tmp that holds
	// one is still its to grant; the compiled code anywhere else is refused
	// as strict refuses it. On Linux it lays the runtime folder, the system
	// bus and X's sockets as its own too, so /tmp, holding those sockets, is
	// granted; a Mac's unchecked profile keeps them refused.
	const unfenced = unfencedFolder(folder, home, asker, {
		treesRoot,
		mac,
		cachesClosed: true,
	});
	if (unfenced) return { refused: unfenced };
	const away = fencedAway(folder, asker, {
		treesRoot,
		held: () =>
			ask.shared === true
				? "shared"
				: place.heldTrees
					? { trees: place.heldTrees }
					: heldBy(
							place.env.PI_SESSION_ID,
							treesRoot,
							place.treeRecords ?? treeRecordDir(),
						),
		spelling,
		mac,
	});
	if ("refused" in away) return away;
	if (mac) return macFenceText(ask, folder, place, treesRoot, away.tree);
	// fence-child.ts hands the text to bash in a variable, never as its
	// argument, since it can hold Delta's token (`delta-token.ts`).
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
	setAsidePlanted();
	const planted = plantedCache();
	if (planted) return { refused: planted };
	const root = fenceArgs({
		home,
		runtimeDir,
		...sessionWorktrees(folder, undefined, treesRoot),
		npmrc: fenceNpmrc(home, runtimeDir),
		docker: dockerHoldsCredentials(home),
	});
	return strictText(sandbox.bwrap, root, inner, command, {
		home,
		runtimeDir,
		folder,
	});
}

/**
 * The text that runs `inner` in bubblewrap with the strict fence's root
 * `root`, or why it can't start. The root is read from a file, as the
 * fence's is (`fence-args-file.ts`), since it grows with the
 * repositories under the home, each bound for what git writes, and in
 * the text can pass the 128 KiB Linux takes in one string; it is in the text only where no file can be had. What
 * bubblewrap or Linux would refuse anyway is said instead.
 */
function strictText(
	bwrap: string,
	root: readonly string[],
	inner: string,
	command: string,
	{
		home,
		runtimeDir,
		folder,
	}: { home: string; runtimeDir: string | undefined; folder: string },
): FenceRunMade {
	const listed = bwrapArgsFile(runtimeDir, root);
	const homes = REPOSITORY_HOMES.map(({ where }) => join(home, where)).join(
		", ",
	);
	// Every word after bubblewrap's name counts, the file's and the
	// command's after `--` alike.
	const counted =
		root.length +
		(listed ? ["--args", `${ARGS_FD}`] : []).length +
		["--", "bash", "-c", inner].length;
	if (counted > BWRAP_MOST_ARGS) {
		return {
			refused: `The strict fence would hand bubblewrap ${counted} arguments, past the ${BWRAP_MOST_ARGS} it takes; they grow with the repositories in ${homes}, each bound for what git writes there, and with the fence's hidden list.`,
		};
	}
	const text = [
		quoted(bwrap),
		...(listed
			? [`--args ${ARGS_FD} ${ARGS_FD}<${quoted(listed.path)}`]
			: root.map(quoted)),
		"-- bash -c",
		// Closed before landrun starts, so nothing inside holds the file.
		quoted(listed ? `exec ${ARGS_FD}<&-; ${inner}` : inner),
	].join(" ");
	const long = tooLong(text, command, listed ?? root);
	return long === undefined ? { folder, text } : { refused: long };
}

/**
 * Why a run can't have `folder`, a tree the work broker cut: the fence
 * grants a tree to whoever works in it, so a tree is spared the fence's
 * closed paths (unfenced-folder.ts) for the one holding it alone, a
 * session by the broker's records, or an asker the caller says it was
 * shared to; anyone else's is refused (ISXEG8, 16 November). A folder
 * outside the trees is judged there.
 */
function fencedAway(
	folder: string,
	asker: string,
	where: {
		readonly treesRoot: string;
		/**
		 * The trees the asker holds, or "shared" for the one the caller says
		 * it was shared, asked only of a folder in the trees.
		 */
		readonly held: () => Held | "shared";
		/** A path as the folder is spelled, for the held match. */
		readonly spelling: (path: string) => string;
		readonly mac: boolean;
	},
): { readonly refused: string } | { readonly tree?: string } {
	const spelled = (path: string) => (where.mac ? path.toLowerCase() : path);
	const named = resolve(folder);
	const at = spelled(named);
	const resolved = (path: string) => spelled(real(resolve(path)));
	const trees = resolved(where.treesRoot);
	if (within(at, trees) && at !== trees) {
		// The tree is the trees root's child the folder lies in.
		const below = named.slice(trees.length + 1).split("/")[0] ?? "";
		const tree = named.slice(0, trees.length + 1 + below.length);
		const held = where.held();
		if (held === "shared") return { tree };
		// Only the tree itself, spelled exactly, so a record naming more,
		// or a neighbour named in other case, never widens it.
		if (held.trees.some((each) => where.spelling(each) === tree)) {
			return { tree };
		}
		const why = held.why ? ` (${held.why})` : "";
		return {
			refused: `${asker} won't run in ${folder}, a work tree its asker doesn't hold${why}, so no command runs. Start it in a tree your session holds, or, from the mycelium node, one shared to the asker, said with --shared-tree.`,
		};
	}
	return {};
}

/** The trees an asker holds, and why it holds none where that isn't plain. */
interface Held {
	readonly trees: readonly string[];
	readonly why?: string;
}

/**
 * The trees the work broker's records give `session`; none when no
 * session is named or the records can't be read, as inside a fence that
 * keeps them, so its tree is refused saying why rather than crashing.
 */
function heldBy(
	session: string | undefined,
	treesRoot: string,
	records: string,
): Held {
	if (!session) return { trees: [], why: "no PI_SESSION_ID names its session" };
	try {
		return { trees: brokerTrees(session, treesRoot, records).held };
	} catch (error) {
		// Unread records hold nothing, so the tree is refused, never run.
		const said = error instanceof Error ? error.message : String(error);
		return {
			trees: [],
			why: `the work broker's records at ${records} couldn't be read: ${said}`,
		};
	}
}

/** Whether `path` is `holder` or lies in it. */
function within(path: string, holder: string): boolean {
	return path === holder || path.startsWith(`${holder}/`);
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
	treesRoot: string,
	tree: string | undefined,
): FenceRunMade {
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
	// As on Linux (sandbox.ts): the read-only folders nothing inside could
	// make are made first, and a link or file planted where a cache goes
	// is moved aside, so neither stays writable or refuses every run.
	makeFoldersFirst(home);
	// The Mac's, asked once, so the account's own temporary folder is
	// held whatever TMPDIR this process was handed.
	const caches = tempCodeCaches("darwin");
	setAsidePlanted(caches);
	makeCachesFirst(caches);
	const macPlanted = plantedCache(caches);
	if (macPlanted) return { refused: macPlanted };
	// The Mac's runtime folder (AGENTS_RUNTIME_DIR, else the cache folder)
	// is laid nothing over here yet, a risk ISXEG8 holds to close, so the
	// copy of npm's settings goes in the person's own temporary folder, which commands there write
	// too, so pi's folder in it is kept from them below.
	const npmrc = fenceNpmrc(home, place.env.TMPDIR);
	const copy = npmrc === "/dev/null" ? undefined : npmrc;
	// As on Linux (sandbox.ts): every quest's scratch and share read-only
	// but the session's own quest's, so a command can't write in another's,
	// nor in the staging a carry keeps beside them (stage.ts), though the
	// Mac's fence lets it write the rest of ~/.cache.
	makeScratches();
	const scratch = questScratch(place.env.TMPDIR);
	const share = makeShares(scratch);
	// A broker's tree is laid from its root, whichever folder in it the
	// run starts in, so its .git stays read-only as the fence keeps it.
	const mounts = fenceArgs(
		{
			home,
			runtimeDir: undefined,
			...sessionWorktrees(tree ?? folder, undefined, treesRoot),
			scratch,
			share,
			...(npmrc ? { npmrc } : {}),
			docker: dockerHoldsCredentials(home),
			tempCaches: caches,
		},
		place.disk,
	);
	// The copy sits in the person's temporary folder, which commands
	// write: its folder is kept from writes, so none can change what the
	// next run reads, or put a link there for the next copy to follow.
	const kept = copy ? ["--ro-bind", dirname(copy), dirname(copy)] : [];
	// Writes only, last: a read-only mount of the home folder here would
	// let back what the fence's mounts hid in it.
	const strict =
		ask.kind === STRICT ? ["--remount-ro", home, "--bind", folder, folder] : [];
	// And reads in the home what landrun lets it read there on Linux: its
	// folder, git's and Nix's settings and the profiles, so no other
	// session's scratch or cache reads (VRZKID, 21 November). Beyond
	// Linux's, the git folder of the tree it runs in, from any folder in
	// it, and the whole held tree, granted again below, since git needs
	// them; and npm's copy without tokens, which macSettings points npm
	// at. The home as its volume spells it, as the folder is, so a home
	// named in other case neither drops the folder nor names no path.
	const homeOnDisk = onDisk(real(home));
	const homeReads =
		ask.kind === STRICT
			? [
					...strictHomeReads({
						home: homeOnDisk,
						runtimeDir: undefined,
						cwd: folder,
						repository: worktreeRepository(tree ?? folder, homeOnDisk),
					}),
					...(copy ? [onDisk(real(dirname(copy)))] : []),
				].filter((path) => within(path, homeOnDisk))
			: undefined;
	const { profile } = seatbeltProfile([...mounts, ...strict, ...kept], {
		sockets: [MAC_NIX_DAEMON],
		home: homeOnDisk,
		heldFromRoot: caches,
		path: (place.env.PATH ?? "").split(":").filter(Boolean),
		folder,
		...(homeReads ? { homeReads } : {}),
		// A tree the work broker cut lies in pi's state, which the profile
		// hides last of all, so the asker's is granted again after: read
		// whole, and written where the kind writes.
		...(tree
			? { regranted: [{ tree, writes: ask.kind === STRICT ? folder : tree }] }
			: {}),
	});
	return {
		folder,
		text: seatbeltText(
			[
				...macSettings(home, copy, ask.kind !== STRICT),
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
function macSettings(
	home: string,
	npmCopy: string | undefined,
	cachesWritten: boolean,
): string[] {
	const cache = join(home, ".cache");
	// Only where the fence lets commands write ~/.cache, and never over
	// the person's own choice of where a cache goes.
	const caches =
		cachesWritten && existsSync(cache) && lstatSync(cache).isDirectory()
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
