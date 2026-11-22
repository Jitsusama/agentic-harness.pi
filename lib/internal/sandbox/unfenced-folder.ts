/**
 * Folders a sandbox won't let a command take as its own to write, since
 * what's written there is read later outside every sandbox: the home
 * folder's startup files, a repository's git folder, the records a
 * machine's mycelium node trusts, and the code pi's host compiled for
 * the next one, the folders in ~/src and ~/world outside a repository's
 * work (but for pi-fence on Linux, whose bubblewrap keeps them read-only),
 * every path in the home folder the agent fence hides or keeps read-only,
 * npm's and Docker's configs among them, wherever their links lead,
 * and what it hides outside it, such as nix-offload's lenders' tokens,
 * which it keeps from its commands for the same reason. Strict makes a
 * command's folder writable, on Linux and the Mac alike, and pi's file
 * tools write it, so each asks here first, as pi-fence does for each kind:
 * one list, the fence's own, so what strict grants can't drift from what
 * the fence closes. Closing these to the fence's other commands is its own
 * lists' work: the node's records and pi's state are read-only there, and
 * node's and jiti's caches in the temporary folder are the fence's own
 * (fence-temp-caches.ts).
 */
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { compileCacheFolder } from "../fence/compile-cache-place.ts";
import { lenderFolders } from "../fence/fence-builders.ts";
import { DISK } from "../fence/fence-disk.ts";
import { DOCKER_CONFIG } from "../fence/fence-docker.ts";
import { FENCE_HIDDEN } from "../fence/fence-hidden.ts";
import {
	fenceFolders,
	keptHomeAbove,
	readOnlyPaths,
} from "../fence/fence-home.ts";
import { NPMRC } from "../fence/fence-npmrc.ts";
import {
	MAC_HIDDEN,
	MAC_PROGRAMS,
	MAC_READ_ONLY,
} from "../fence/fence-seatbelt.ts";
import { tempCodeCaches } from "../fence/fence-temp-caches.ts";
import { cacheDir, stateDir } from "../paths.ts";
import { cutTreeDir } from "../work-records.ts";
import { namedGitFolder, real, within } from "./tree-git.ts";

/**
 * What a session's own refusal of its folder names as refusing: the
 * sandbox's variable set to strict, as `sandbox.ts` names them.
 */
export const ASKED = "PI_SANDBOX=strict";

/**
 * Where a machine's node reads what it trusts: pi's host records, which
 * say each hosted session's fence, and the node's own state. A command
 * that could write one could tell the node a session is fenced tighter
 * than it is (ISXEG8, 19 November). Strict refuses both as a command's
 * folder, and the agent fence keeps both read-only (fence-home.ts).
 */
export function nodeRecords(home: string): string[] {
	return unique([
		join(home, ".local/state/pi/agentic-harness.pi/hosts"),
		join(home, ".local/state/mycelium"),
		stateDir("hosts"),
	]);
}

/**
 * Where pi and its host keep the code they compiled, which the next one
 * started outside every sandbox runs as its own (ISXEG8, 19 November):
 * the host's cache and node's in pi's state, where they now lie, and
 * in the cache folder, where an older install kept the host's, and
 * node's and jiti's in the temporary folder, where a pi left to itself
 * keeps them. The fence holds each closed to its other commands; strict
 * would make one writable as a command's own folder.
 */
export function compiledCode(home: string): string[] {
	return unique([
		join(home, ".local/state/pi/agentic-harness.pi/host-compile"),
		join(home, ".local/state/pi/agentic-harness.pi/node-compile-cache"),
		stateDir("host-compile"),
		compileCacheFolder(),
		join(home, ".cache/pi/agentic-harness.pi/host-compile"),
		cacheDir("host-compile"),
		...tempCodeCaches(),
	]);
}

/**
 * The paths the agent fence hides or keeps read-only, for the home folder
 * as spelled and as its links lead, and each as its own links lead: what
 * the fence keeps from its commands, on a Mac as its own fence closes
 * more, its programs' folders outside the home among them. Its hidden
 * files count too, since strict lays no hide of its own, so a folder
 * holding one would grant the file itself. With `hidden`, only what the
 * fence hides, which reading would already hand over: ~/.ssh among them,
 * which the fence empties but for what `FENCE_HIDDEN.sshKept` keeps.
 * Each is spelled as the list spells it; closedHere follows its links.
 */
function closedPaths(
	home: string,
	mac: boolean,
	hidden: boolean,
	elsewhere: boolean,
): string[] {
	const closedFrom = (from: string) => [
		...FENCE_HIDDEN.home.map((entry) =>
			join(from, entry.endsWith("/") ? entry.slice(0, -1) : entry),
		),
		...(mac ? MAC_HIDDEN.map((entry) => join(from, entry)) : []),
		// The fence hands its commands an npm config without its tokens and
		// a Docker config without its logins, so reading either hands them over.
		join(from, NPMRC),
		join(from, DOCKER_CONFIG),
		...(hidden ? [join(from, ".ssh")] : readOnlyPaths(from)),
		...(mac && !hidden ? MAC_READ_ONLY.map((entry) => join(from, entry)) : []),
	];
	return unique([
		...unique([home, real(home)]).flatMap(closedFrom),
		...(mac && !hidden ? MAC_PROGRAMS : []),
		...(elsewhere ? closedElsewhere(hidden) : []),
	]);
}

/**
 * What the fence hides outside the home folder, which strict's own reach
 * leaves out but a working folder there would let in: each nix-offload
 * lender's folder, whose cloud token is Joel's own (fence-builders.ts),
 * the runtime folder, the system bus and X's sockets, each where it is
 * there, so a machine with none refuses no folder for them. With
 * `hidden`, not the bus's or X's, which hold only sockets, so reading
 * beside them hands over nothing.
 */
function closedElsewhere(hidden: boolean): string[] {
	const runtime = process.env.XDG_RUNTIME_DIR;
	const sockets = hidden ? [] : ["/run/dbus", "/tmp/.X11-unix"];
	return [
		...lenderFolders(DISK),
		...[...(runtime ? [runtime] : []), ...sockets].filter(isThere),
	];
}

/**
 * Where `path` leads, past its links, even where it isn't there yet: a
 * link whose target isn't written, or one in a linked folder, leads
 * where a command writing it would land, so a link can't walk round a
 * closed path by pointing at one still to be made.
 */
function leadsTo(path: string, hops = 0): string {
	try {
		return realpathSync(path);
	} catch {
		// Not there; where it would be is judged below.
	}
	const parent = dirname(path);
	if (parent === path) return path;
	const within = leadsTo(parent, hops);
	try {
		if (hops < 40 && lstatSync(path).isSymbolicLink())
			return leadsTo(resolve(within, readlinkSync(path)), hops + 1);
	} catch {
		// Nothing there at all: it would be made where its folder leads.
	}
	return join(within, basename(path));
}

function unique(paths: string[]): string[] {
	return [...new Set(paths)];
}

/**
 * Whether anything is at `path`. A path whose folder is a file, or one
 * it can't look in, has nothing there, rather than throwing out of the
 * check: a command can turn a linked folder into a file.
 */
function isThere(path: string): boolean {
	try {
		return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
	} catch {
		return false;
	}
}

/** Whether `folder` is a repository, as a `.git` of any kind in it says. */
function holdsGit(folder: string): boolean {
	return isThere(join(folder, ".git"));
}

/**
 * `path` as its volume spells it, or as given where it isn't there: on a
 * Mac a name in other case, or folded otherwise, is the folder it opens.
 */
export function onDisk(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		// Not there yet: nothing on disk to spell it otherwise.
		return path;
	}
}

/** Where `path` really is, past its links, and on a Mac as its volume spells it. */
function reallyAt(path: string, mac: boolean): string {
	const really = real(resolve(path));
	return mac ? onDisk(really) : really;
}

/**
 * The git folder `cwd` lies in, as spelled or past its links: one named
 * `.git`, or a bare repository's, which holds `HEAD` and `objects`. The
 * search for a bare one stops at the first folder holding a `.git`, as
 * tree-git's foundGit does, so a worktree kept inside its bare
 * repository's folder is judged by its own git, not the repository's.
 */
function gitFolderOf(
	cwd: string,
	really: string,
	fold: (path: string) => string,
): string | undefined {
	const named = (path: string): string | undefined => {
		const parts = path.split(sep);
		const at = parts.findIndex((part) => fold(part) === ".git");
		return at < 0 ? undefined : parts.slice(0, at + 1).join(sep);
	};
	const found = named(resolve(cwd)) ?? named(really);
	if (found) return found;
	for (let folder = really; ; folder = dirname(folder)) {
		if (isBare(folder)) return folder;
		if (isThere(join(folder, ".git")) || dirname(folder) === folder) {
			return undefined;
		}
	}
}

/** Whether `folder` is a bare repository: a `HEAD` file and an `objects` folder. */
function isBare(folder: string): boolean {
	try {
		return (
			statSync(join(folder, "HEAD")).isFile() &&
			statSync(join(folder, "objects")).isDirectory()
		);
	} catch {
		return false;
	}
}

/**
 * The closed path `cwd` lies in or holds, and which, unless it lies in a
 * tree the broker cut. On a Mac each is matched folded, as its volumes
 * fold names, so `.SSH` is `.ssh`: folded only after its links are
 * followed, since a link's own target keeps the case it was written in.
 */
function closedHere(
	cwd: string,
	home: string,
	place: FolderPlace,
	hidden = false,
): { readonly path: string; readonly within: boolean } | undefined {
	const mac = place.mac ?? process.platform === "darwin";
	const spelled = (path: string) => (mac ? path.toLowerCase() : path);
	const at = spelled(resolve(cwd));
	const really = spelled(reallyAt(cwd, mac));
	const trees = spelled(real(resolve(place.treesRoot ?? cutTreeDir())));
	if (spelledWithin(really, trees) && really !== trees) return undefined;
	// A closed path the folder lies in before one it holds, so ~/.config
	// is named, not a hidden folder within it; each matched as the folder
	// is spelled first, so the refusal names it the way the folder reached
	// it, then as both really are, past links, still naming the first
	// closed path as the list spells it.
	// pi-fence's bubblewrap lays what it hides outside the home as its own.
	const elsewhere = !(place.cachesClosed && !mac);
	const closed = closedPaths(home, mac, hidden, elsewhere).map((path) => ({
		path,
		as: spelled(path),
		is: spelled(leadsTo(path)),
	}));
	const lies =
		closed.find((each) => spelledWithin(at, each.as)) ??
		closed.find((each) => spelledWithin(really, each.is));
	if (lies) return { path: lies.path, within: true };
	// One that is there before one that isn't, so the refusal sends no
	// one looking for a key this machine never had.
	const there = (each: { readonly path: string }) => isThere(each.path);
	const holds = (each: (typeof closed)[number]) =>
		spelledWithin(each.as, at) || spelledWithin(each.is, really);
	const held =
		closed.find((each) => holds(each) && there(each)) ??
		closed.find((each) => spelledWithin(each.as, at)) ??
		closed.find((each) => spelledWithin(each.is, really));
	return held ? { path: held.path, within: false } : undefined;
}

/**
 * Why pi's file tools can't read in `cwd` either, when it lies in or holds
 * a path the fence hides: reading there hands over what the fence empties.
 */
export function hiddenFolder(
	cwd: string,
	home: string,
	asker = ASKED,
	place: FolderPlace = {},
): string | undefined {
	const closed = closedHere(cwd, home, place, true);
	if (!closed) return undefined;
	return `${asker} won't let pi's file tools read in ${cwd}, which ${closed.within ? "lies in" : "holds"} ${closed.path}, a path the fence hides. Start it in the folder it works on.`;
}

/** Whether `path` is `folder` or lies inside it, as both are spelled. */
function spelledWithin(path: string, folder: string): boolean {
	return path === folder || path.startsWith(`${folder}/`);
}

/** Where a folder is judged: the broker's trees, and whether on a Mac. */
export interface FolderPlace {
	/**
	 * Where the work broker cuts its trees, each of which the fence binds
	 * back writable inside pi's read-only state, so a folder in one is
	 * spared the fence's closed paths; the broker's own by default.
	 */
	readonly treesRoot?: string;
	/** Whether on a Mac, whose volumes fold case; this process's by default. */
	readonly mac?: boolean;
	/**
	 * Whether the run's own fence lays the temporary folder's code caches
	 * as its own mounts, as pi-fence's does, so a folder holding one is its
	 * to grant; strict's shell and file tools lay none, so they refuse
	 * them here, and every other compiled-code folder is refused for both.
	 * On Linux that fence also lays what it hides outside the home folder,
	 * so a folder such as /tmp, holding X's sockets, is its to grant too.
	 */
	readonly cachesClosed?: boolean;
}

/**
 * Why the sandbox can't let commands write `cwd`, when it can't: its
 * writes would reach what runs outside the sandbox later, as `asker` says.
 */
export function unfencedFolder(
	cwd: string,
	home: string,
	asker = ASKED,
	place: FolderPlace = {},
) {
	const refusing = (holds: string) =>
		`${asker} won't let commands write ${cwd}, which holds ${holds}, so no command runs. Start it in the folder it works on.`;
	// On a Mac, each also folded, as its volumes fold names.
	const mac = place.mac ?? process.platform === "darwin";
	const folded = (path: string) => reallyAt(path, mac).toLowerCase();
	const meets = (folder: string) =>
		within(folder, cwd) ||
		within(cwd, folder) ||
		(mac &&
			(spelledWithin(folded(cwd), folded(folder)) ||
				spelledWithin(folded(folder), folded(cwd))));
	if (within(home, cwd) || (mac && spelledWithin(folded(home), folded(cwd)))) {
		return refusing(
			"the home folder and the startup files that run outside the sandbox",
		);
	}
	const records = nodeRecords(home);
	if (records.some(meets)) {
		return refusing(
			"or lies in the records this machine's node trusts (its own and pi's host records)",
		);
	}
	const caches = new Set(place.cachesClosed ? tempCodeCaches() : []);
	const code = compiledCode(home).filter((folder) => !caches.has(folder));
	if (code.some(meets)) {
		return refusing(
			"or lies in the code pi and its host compiled, which the next one runs outside the sandbox",
		);
	}
	// The fence's cargo and gradle run what their homes hold, and its
	// gcloud reads its settings folder (fence-home.ts).
	if (Object.values(fenceFolders(home)).some(meets)) {
		return refusing(
			"or lies in the agent fence's own state, which its commands run later",
		);
	}
	const closed = closedHere(cwd, home, place);
	if (closed) {
		return closed.within
			? `${asker} won't let commands write ${cwd}, which lies in ${closed.path}, a path the fence hides or keeps read-only, so no command runs. Start it in the folder it works on, or in a tree the work tool cuts.`
			: `${asker} won't let commands write ${cwd}, which holds ${closed.path}, a path the fence hides or keeps read-only, so no command runs. Start it in a folder within, beside none of them, or in a tree the work tool cuts.`;
	}
	// Folded on a Mac too, whose volumes would reach ~/src spelled ~/SRC,
	// but only to compare: the disk is asked as the folders are spelled,
	// which a case-sensitive volume needs.
	const fold = (path: string) => (mac ? path.toLowerCase() : path);
	const really = reallyAt(cwd, mac);
	// Any git folder it lies in, wherever: its hooks and settings run
	// outside the sandbox at the next git, and the fence keeps them
	// read-only. A folder further above one is judged as any other.
	const git = gitFolderOf(cwd, really, fold);
	if (git) {
		return `${asker} won't let commands write ${cwd}, which lies in ${git}, a repository's git folder, whose hooks and settings git runs outside the sandbox, so no command runs. Work in the repository's tree the work tool cuts (\`work tree\`) or a snapshot.`;
	}
	// pi-fence's bubblewrap keeps the repository homes read-only itself.
	const above =
		place.cachesClosed && !mac
			? undefined
			: unique([home, real(home)])
					.map((from) => keptHomeAbove(really, from, holdsGit, fold))
					.find((top) => top !== undefined);
	if (above) {
		return `${asker} won't let commands write ${cwd}, which lies in ${above} outside any repository's work, where a command could write the hooks and settings git runs outside the sandbox, so no command runs. Work in a repository's tree the work tool cuts (\`work tree\`) or a snapshot.`;
	}
	// Its own git folder, or one its .git file names inside it, as where a
	// bare repository's worktrees sit beside it (`gitdir: ./.bare`).
	try {
		const named = namedGitFolder(cwd);
		if (
			statSync(join(cwd, ".git")).isDirectory() ||
			(named !== undefined && within(named, cwd))
		) {
			return `${asker} won't let commands write ${cwd}, which holds its repository's git folder, whose hooks and settings git runs outside the sandbox, so no command runs. Work in a tree the work tool cuts (\`work tree\`) or a snapshot, whose git folder lies elsewhere; a plain clone won't do.`;
		}
	} catch {
		// No git folder here, or a worktree's .git file pointing elsewhere.
	}
	return undefined;
}
