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
 * which it keeps from its commands for the same reason. A folder holding
 * a link on such a path's way is refused too, since a command could
 * point the path elsewhere, and so is one holding another repository's
 * git folder a few levels down. Strict makes a
 * command's folder writable, on Linux and the Mac alike, and pi's file
 * tools write it, so each asks here first, as pi-fence does for each kind:
 * one list, the fence's own, so what strict grants can't drift from what
 * the fence closes. Closing these to the fence's other commands is its own
 * lists' work: the node's records and pi's state are read-only there, and
 * node's and jiti's caches in the temporary folder are the fence's own
 * (fence-temp-caches.ts).
 */
import {
	type Dirent,
	lstatSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { compileCacheFolder } from "../fence/compile-cache-place.ts";
import { lenderFolders } from "../fence/fence-builders.ts";
import { DISK } from "../fence/fence-disk.ts";
import { DOCKER_CONFIG } from "../fence/fence-docker.ts";
import { FENCE_HIDDEN } from "../fence/fence-hidden.ts";
import { keptHomeAbove, readOnlyPaths } from "../fence/fence-home.ts";
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
	elsewhere: FolderPlace | undefined,
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
		...(elsewhere ? closedElsewhere(hidden, elsewhere) : []),
	]);
}

/**
 * What the fence hides outside the home folder, which strict's own reach
 * leaves out but a working folder there would let in: each nix-offload
 * lender's folder, whose cloud token is Joel's own (fence-builders.ts),
 * the runtime folders, the system bus and X's sockets, each where it is
 * there, so a machine with none refuses no folder for them. With
 * `hidden`, not the bus's or X's, which hold only sockets, so reading
 * beside them hands over nothing.
 */
function closedElsewhere(hidden: boolean, place: FolderPlace): string[] {
	const sockets = hidden ? [] : ["/run/dbus", "/tmp/.X11-unix"];
	return [
		...lenderFolders(DISK, place.run),
		...runtimeFolders(place).keys(),
		...sockets.filter(isThere),
	];
}

/**
 * The runtime folders the fence hides: the session's own, which its
 * commands are given and the fence is drawn from, pi's, should the two
 * differ, and on Linux the login's own, /run/user/<uid>, which pi's
 * quest locks and the session bus use where no variable names it, since
 * refusing one more costs only a refused folder. A relative value names
 * none, as the variable's own rules say, rather than one beside pi.
 */
function runtimeFolders(place: FolderPlace): Map<string, RuntimeName> {
	const mac = place.mac ?? process.platform === "darwin";
	const uid = process.getuid?.();
	const named: [string | undefined, RuntimeName][] = [
		[place.runtimeDir, "variable"],
		[process.env.XDG_RUNTIME_DIR, "variable"],
		[
			mac || uid === undefined
				? undefined
				: join(place.run ?? "/run", "user", String(uid)),
			"login",
		],
	];
	const folders = new Map<string, RuntimeName>();
	for (const [folder, name] of named) {
		if (!folder || !isAbsolute(folder)) continue;
		const path = resolve(folder);
		if (!folders.has(path) && isThere(path)) folders.set(path, name);
	}
	return folders;
}

/** How a runtime folder is named: by XDG_RUNTIME_DIR, or as the login's own. */
type RuntimeName = "variable" | "login";

/** How many links a path's way may pass, as the kernel counts, before it loops. */
const MOST_LINKS = 40;

/** Where a path leads past its links, and each link on the way there. */
interface Way {
	/** Where it leads, or nothing where its links loop or pass `MOST_LINKS`. */
	readonly leads: string | undefined;
	/** Each link it passes, where the link itself lies. */
	readonly links: readonly string[];
}

/**
 * Where `path` leads, past its links, even where it isn't there yet: a
 * link whose target isn't written, or one in a linked folder, leads
 * where a command writing it would land, so a link can't walk round a
 * closed path by pointing at one still to be made. With every link it
 * passes, each a step its path could be sent elsewhere from by whoever
 * may replace it, which judging only the two ends would miss. Each part
 * of a link's target is taken from where the walk has got to, as the
 * kernel takes it, so a `..` after a link climbs from where that link
 * leads, not from where its name lies.
 */
function wayOf(path: string): Way {
	const links: string[] = [];
	const walk = (from: string, parts: readonly string[]): string | undefined => {
		let at: string | undefined = from;
		for (const part of parts) {
			if (at === undefined) return undefined;
			if (part === "" || part === ".") continue;
			if (part === "..") {
				at = dirname(at);
				continue;
			}
			const here = join(at, part);
			let target: string;
			try {
				if (!lstatSync(here).isSymbolicLink()) {
					at = here;
					continue;
				}
				target = readlinkSync(here);
			} catch {
				// Nothing there: it would be made where its folder leads.
				at = here;
				continue;
			}
			links.push(here);
			if (links.length > MOST_LINKS) return undefined;
			at = walk(isAbsolute(target) ? sep : at, target.split(sep));
		}
		return at;
	};
	return { leads: walk(sep, resolve(path).split(sep)), links };
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

/**
 * Whether `folder` is a repository: its `.git` a git folder, or a file
 * naming one. A stray `.git`, a link to nothing or a file naming no
 * folder, makes none, so it can't open the folders below it.
 */
function holdsGit(folder: string): boolean {
	try {
		if (statSync(join(folder, ".git")).isDirectory()) return true;
		const named = namedGitFolder(folder);
		return named !== undefined && statSync(named).isDirectory();
	} catch {
		// No .git, one leading nowhere, or one naming nothing that is there.
		return false;
	}
}

/** How many levels below a working folder the walk looks for another repository. */
const NESTED_DEPTH = 3;

/**
 * How many folders the walk judges at most, so a large tree costs a call
 * little; a folder holding more is refused rather than granted unread.
 */
export const NESTED_MOST = 2000;

/**
 * Folders the walk passes by: a git folder, which its repository answers
 * for, and node_modules, where npm keeps no clone git is run in.
 */
const NESTED_PASSED = new Set([".git", "node_modules"]);

/** What the walk below a folder found: another repository's git folder, or too much to judge. */
type Nested = { readonly git: string } | { readonly wide: true };

/**
 * Another repository's git folder below `folder` that a command there
 * could write, up to `NESTED_DEPTH` levels down through folders, hidden
 * ones included but never a link, judging at most `NESTED_MOST`: a
 * vendored clone's hooks, or one pip keeps in `.venv/src`, run outside
 * the sandbox at the next git. A submodule or worktree whose git folder
 * lies outside `folder` puts none in reach. Each level is read in name
 * order, so every machine finds the same. Deeper ones, and any a command
 * makes, go unjudged, as the README says.
 */
function nestedGit(folder: string): Nested | undefined {
	let judged = 0;
	let level = [folder];
	for (let depth = 1; depth <= NESTED_DEPTH; depth += 1) {
		const next: string[] = [];
		for (const at of level) {
			let entries: Dirent[];
			try {
				entries = readdirSync(at, { withFileTypes: true });
			} catch {
				// A folder it can't read, a command there can't write either.
				continue;
			}
			const names = entries
				.filter((each) => each.isDirectory() && !NESTED_PASSED.has(each.name))
				.map((each) => each.name)
				.sort();
			for (const name of names) {
				judged += 1;
				if (judged > NESTED_MOST) return { wide: true };
				const path = join(at, name);
				const git = gitFolderIn(path);
				if (git !== undefined && within(git, folder)) {
					return { git: join(path, ".git") };
				}
				if (isBare(path)) return { git: path };
				next.push(path);
			}
		}
		level = next;
	}
	return undefined;
}

/**
 * Where the git folder of the repository at `folder` really lies: its
 * `.git` folder, where that link leads, or the folder its `.git` file
 * names; nothing where it has none, or one naming nothing there.
 */
function gitFolderIn(folder: string): string | undefined {
	const dotGit = join(folder, ".git");
	try {
		const found = lstatSync(dotGit);
		if (found.isDirectory()) return dotGit;
		if (found.isSymbolicLink()) {
			const led = realpathSync(dotGit);
			return statSync(led).isDirectory() ? led : undefined;
		}
		const named = namedGitFolder(folder);
		return named !== undefined && statSync(named).isDirectory()
			? real(named)
			: undefined;
	} catch {
		return undefined;
	}
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

/** A closed path a folder meets, and how. */
interface Closed {
	readonly path: string;
	/** Whether the folder lies in it, rather than holding it. */
	readonly within: boolean;
	/** A link on its way that the folder holds, when that is what it holds. */
	readonly link?: string;
	/** How it is named, where it is a runtime folder. */
	readonly runtime: RuntimeName | undefined;
}

/** Whether `cwd` lies in a tree the broker cut, which the fence grants to whoever works in it. */
function inTrees(cwd: string, place: FolderPlace, mac: boolean): boolean {
	const spelled = (path: string) => (mac ? path.toLowerCase() : path);
	const really = spelled(reallyAt(cwd, mac));
	const trees = spelled(real(resolve(place.treesRoot ?? cutTreeDir())));
	return spelledWithin(really, trees) && really !== trees;
}

/**
 * The closed path `cwd` lies in or holds, and which, unless it lies in a
 * tree the broker cut. On a Mac each is matched folded, as its volumes
 * fold names, so `.SSH` is `.ssh`: folded only after its links are
 * followed, since a link's own target keeps the case it was written in.
 * For a write, a folder holding a link on a closed path's way counts
 * too, since a command there could point the path elsewhere.
 */
function closedHere(
	cwd: string,
	home: string,
	place: FolderPlace,
	hidden = false,
): Closed | undefined {
	const mac = place.mac ?? process.platform === "darwin";
	const spelled = (path: string) => (mac ? path.toLowerCase() : path);
	const at = spelled(resolve(cwd));
	const really = spelled(reallyAt(cwd, mac));
	if (inTrees(cwd, place, mac)) return undefined;
	// A closed path the folder lies in before one it holds, so ~/.config
	// is named, not a hidden folder within it; each matched as the folder
	// is spelled first, so the refusal names it the way the folder reached
	// it, then as both really are, past links, still naming the first
	// closed path as the list spells it.
	// pi-fence's bubblewrap lays what it hides outside the home as its own.
	const elsewhere = bubblewrapped(place, mac) ? undefined : place;
	const runtimes = runtimeFolders(place);
	const closed = closedPaths(home, mac, hidden, elsewhere).map((path) => {
		const way = wayOf(path);
		return {
			path,
			as: spelled(path),
			is: way.leads === undefined ? undefined : spelled(way.leads),
			links: way.links,
			runtime: runtimes.get(path),
		};
	});
	const found = (each: (typeof closed)[number], within: boolean) => ({
		path: each.path,
		within,
		runtime: each.runtime,
	});
	const leadsIn = (each: (typeof closed)[number], folder: string) =>
		each.is !== undefined && spelledWithin(each.is, folder);
	const lies =
		closed.find((each) => spelledWithin(at, each.as)) ??
		closed.find(
			(each) => each.is !== undefined && spelledWithin(really, each.is),
		);
	if (lies) return found(lies, true);
	// One that is there before one that isn't, so the refusal sends no
	// one looking for a key this machine never had.
	const there = (each: { readonly path: string }) => isThere(each.path);
	const holds = (each: (typeof closed)[number]) =>
		spelledWithin(each.as, at) || leadsIn(each, really);
	const held =
		closed.find((each) => holds(each) && there(each)) ??
		closed.find((each) => spelledWithin(each.as, at)) ??
		closed.find((each) => leadsIn(each, really));
	if (held) return found(held, false);
	// Reading beside a link hands over nothing; writing could repoint it.
	if (hidden) return undefined;
	// The shortest closed path behind the link, so the refusal names the
	// folder it leads to (~/.config), not a file deep within it.
	const linked = closed
		.flatMap((each) => {
			const link = heldLink(each.links, at, really, spelled);
			return link === undefined ? [] : [{ each, link }];
		})
		.sort((one, other) => one.each.path.length - other.each.path.length)[0];
	return linked && { ...found(linked.each, false), link: linked.link };
}

/** The first of `links` that the folder, as spelled or as it really is, holds. */
function heldLink(
	links: readonly string[],
	at: string,
	really: string,
	spelled: (path: string) => string,
): string | undefined {
	return links.find(
		(path) =>
			spelledWithin(spelled(path), at) || spelledWithin(spelled(path), really),
	);
}

/** Whether the run's own fence is bubblewrap, which lays its own mounts, never on a Mac. */
function bubblewrapped(place: FolderPlace, mac: boolean): boolean {
	return place.bubblewrap === true && !mac;
}

/** A closed path as a refusal names it, a runtime folder by its variable. */
function named(closed: Closed): string {
	switch (closed.runtime) {
		case "variable":
			return `${closed.path}, the runtime folder XDG_RUNTIME_DIR names`;
		case "login":
			return `${closed.path}, the runtime folder the login is given`;
		default:
			return closed.path;
	}
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
	return `${asker} won't let pi's file tools read in ${cwd}, which ${closed.within ? "lies in" : "holds"} ${named(closed)}, a path the fence hides. Start it in the folder it works on.`;
}

/** Whether `path` is `folder` or lies inside it, as both are spelled. */
function spelledWithin(path: string, folder: string): boolean {
	return path === folder || path.startsWith(`${folder}/`);
}

/** Where a folder is judged: the broker's trees, the machine, and the run's own fence. */
export interface FolderPlace {
	/**
	 * Where the work broker cuts its trees, each of which the fence binds
	 * back writable inside pi's read-only state, so a folder in one is
	 * spared the fence's closed paths; the broker's own by default. Any
	 * tree is spared here, held or not: pi-fence refuses one its asker
	 * doesn't hold (fence-run.ts), but strict leaves that open, since a
	 * strict session started in its quest's tree may hold it by no record
	 * of its own, and the tree's git is guarded apart (tree-git.ts).
	 */
	readonly treesRoot?: string;
	/** Whether on a Mac, whose volumes fold case; this process's by default. */
	readonly mac?: boolean;
	/**
	 * The session's runtime folder, its `XDG_RUNTIME_DIR`, which the fence
	 * hides; pi's own is closed too, should the two differ.
	 */
	readonly runtimeDir?: string;
	/** Where the lenders' folders lie, /run by default. */
	readonly run?: string;
	/**
	 * Whether the run's own fence lays the temporary folder's code caches
	 * as its own mounts, as pi-fence's does, on Linux and a Mac alike, so a
	 * folder holding one is its to grant; strict's shell and file tools lay
	 * none, so they refuse them here, and every other compiled-code folder
	 * is refused for both.
	 */
	readonly cachesLaid?: boolean;
	/**
	 * Whether the run's own fence is bubblewrap, as pi-fence's is on Linux,
	 * which lays what it hides outside the home folder as its own mounts and
	 * keeps the repository homes read-only itself, so a folder such as /tmp,
	 * holding X's sockets, or one in ~/src outside a repository's work, is
	 * its to grant. Never so on a Mac.
	 */
	readonly bubblewrap?: boolean;
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
	const caches = new Set(place.cachesLaid ? tempCodeCaches() : []);
	const code = compiledCode(home).filter((folder) => !caches.has(folder));
	if (code.some(meets)) {
		return refusing(
			"or lies in the code pi and its host compiled, which the next one runs outside the sandbox",
		);
	}
	// A link on the way to either, which a command there could point at a
	// folder of its own, as closedHere judges the fence's own paths.
	const fold = (path: string) => (mac ? path.toLowerCase() : path);
	const really = reallyAt(cwd, mac);
	for (const folder of [...records, ...code]) {
		const link = heldLink(
			wayOf(folder).links,
			fold(resolve(cwd)),
			fold(really),
			fold,
		);
		if (link) {
			return `${asker} won't let commands write ${cwd}, which holds ${link}, a link on the way to ${folder}, which pi or its node reads outside the sandbox: a command there could point it elsewhere, so no command runs. Start it in a folder beside the link, or in a tree the work tool cuts.`;
		}
	}
	const closed = closedHere(cwd, home, place);
	if (closed?.link) {
		return `${asker} won't let commands write ${cwd}, which holds ${closed.link}, a link on the way to ${closed.path}, a path the fence hides or keeps read-only: a command there could point it elsewhere, so no command runs. Start it in a folder beside the link, or in a tree the work tool cuts.`;
	}
	if (closed) {
		return closed.within
			? `${asker} won't let commands write ${cwd}, which lies in ${named(closed)}, a path the fence hides or keeps read-only, so no command runs. Start it in the folder it works on, or in a tree the work tool cuts.`
			: `${asker} won't let commands write ${cwd}, which holds ${named(closed)}, a path the fence hides or keeps read-only, so no command runs. Start it in a folder within, beside none of them, or in a tree the work tool cuts.`;
	}
	// Folded on a Mac too, whose volumes would reach ~/src spelled ~/SRC,
	// but only to compare: the disk is asked as the folders are spelled,
	// which a case-sensitive volume needs.
	// Any git folder it lies in, wherever: its hooks and settings run
	// outside the sandbox at the next git, and the fence keeps them
	// read-only. A folder further above one is judged as any other.
	const git = gitFolderOf(cwd, really, fold);
	if (git) {
		return `${asker} won't let commands write ${cwd}, which lies in ${git}, a repository's git folder, whose hooks and settings git runs outside the sandbox, so no command runs. Work in the repository's tree the work tool cuts (\`work tree\`) or a snapshot.`;
	}
	// pi-fence's bubblewrap keeps the repository homes read-only itself.
	const above = bubblewrapped(place, mac)
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
	// Another repository below, a vendored clone's say, but in a broker's
	// tree, which the fence grants whole to whoever works in it.
	const nested = inTrees(cwd, place, mac) ? undefined : nestedGit(really);
	if (nested && "wide" in nested) {
		return `${asker} won't let commands write ${cwd}, which holds more than ${NESTED_MOST} folders within ${NESTED_DEPTH} levels, too many to judge for another repository's git folder, whose hooks git runs outside the sandbox, so no command runs. Start it in a narrower folder, or in a tree the work tool cuts (\`work tree\`).`;
	}
	if (nested) {
		return `${asker} won't let commands write ${cwd}, which holds ${nested.git}, another repository's git folder, whose hooks and settings git runs outside the sandbox, so no command runs. Start it in a folder beside it, or in a tree the work tool cuts (\`work tree\`).`;
	}
	return undefined;
}
