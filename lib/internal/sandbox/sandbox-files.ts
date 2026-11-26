/**
 * pi's own file tools, held to the fence a session's commands run in.
 *
 * pi's read, edit and write run in pi's own process, outside Landlock
 * and bubblewrap, so a session whose commands are fenced would still
 * reach everything through them. `fileToolRefusal` holds them to the
 * same paths for the `sandbox-file-interceptor` extension: under the
 * strict profile, where a command may reach, less `/proc` and the
 * devices; under the agent fence, nowhere a fenced command can't write,
 * and no other process's `/proc` or the runtime folder. On a Mac, whose
 * seatbelt closes more than Linux's lists, the fence also keeps them from
 * the Mac's own secrets and from writing what runs later as the person,
 * each path matched as its volume folds case.
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { FenceKind } from "../../mesh/presence.ts";
import {
	FENCE,
	fenceHidesBeneath,
	fenceRefusesRead,
	fenceRefusesWrite,
} from "../fence/fence.ts";
import {
	MAC_PROGRAMS,
	MAC_READ_ONLY,
	MAC_SECRETS,
} from "../fence/fence-seatbelt.ts";
import { askedSandbox } from "../fence/fence-stage.ts";
import { toolPath } from "../files/tool-path.ts";
import { isRecord } from "../record.ts";
import { leadsTo } from "./leads-to.ts";
import { makeScratches, makeShares, questScratch } from "./quest-folders.ts";
import { SANDBOX_NAMES, SANDBOX_VARIABLE, STRICT } from "./sandbox.ts";
import { brokerTrees, heldWorktrees } from "./sandbox-trees.ts";
import { type FileUse, fileReach } from "./strict-rules.ts";
import {
	real as pastLinks,
	treeGit,
	within,
	worktreeRepository,
} from "./tree-git.ts";
import {
	closedPaths,
	hiddenFolder,
	unfencedFolder,
} from "./unfenced-folder.ts";

/**
 * pi's file tools, by what each does with its `path`. Those that search
 * a folder search the working folder when given none. A tool that walks
 * goes down through every folder under it, opening each file (`contents`,
 * grep) or each folder (`names`, find); `ls` lists one folder.
 */
const FILE_TOOLS: ReadonlyMap<
	string,
	{
		readonly use: FileUse;
		readonly searches: boolean;
		readonly walks?: "contents" | "names";
	}
> = new Map([
	["read", { use: "read", searches: false }],
	["grep", { use: "read", searches: true, walks: "contents" }],
	["find", { use: "read", searches: true, walks: "names" }],
	["ls", { use: "read", searches: true }],
	["edit", { use: "write", searches: false }],
	["write", { use: "write", searches: false }],
]);

/**
 * Every file a tool may open for `path`, as pi resolves it: spaces made
 * plain, a leading `@` dropped, `~` and `file://` expanded, against the
 * working folder, with each spelling pi tries when the first is missing
 * (a screenshot's narrow space, decomposed accents, a curly apostrophe).
 */
export function toolPaths(path: string, cwd: string, home: string): string[] {
	const first = toolPath(path, cwd, home);
	const decomposed = first.normalize("NFD");
	const curly = (text: string) => text.replaceAll("'", "\u2019");
	return [
		...new Set([
			first,
			first.replace(/ (AM|PM)\./gi, "\u202F$1."),
			decomposed,
			curly(first),
			curly(decomposed),
		]),
	];
}

/** Why a path's way can't be followed, as leads-to.ts gives up on it. */
const CANT_FOLLOW =
	"a loop of links, more links than the system follows, a link it couldn't read or whose target isn't UTF-8, or a name it couldn't look at";

/** Whether `path` is `folder` or lies inside it, both already resolved. */
function inside(path: string, folder: string): boolean {
	const between = relative(folder, path);
	// A child named `..x` lies inside; only `..` itself or `../` leads out.
	return !(
		between === ".." ||
		between.startsWith(`..${sep}`) ||
		isAbsolute(between)
	);
}

/** The path a file tool's call names, or the working folder for a search. */
function pathOf(input: unknown, searches: boolean): string | undefined {
	const path = isRecord(input) ? input.path : undefined;
	if (typeof path === "string") return path;
	return path === undefined && searches ? "." : undefined;
}

/** A call to one of pi's tools, as it is about to run. */
export interface ToolCall {
	readonly toolName: string;
	readonly input: unknown;
}

/** Where a file tool runs, as the fences need it. */
interface FilePlace {
	cwd: string;
	env: NodeJS.ProcessEnv;
	home: string;
	/**
	 * The folders of the skills pi offered this session. pi names each
	 * skill's file and leaves the model to read it, so a fence that
	 * refused them would quietly strip a reviewer of its output
	 * contract; they are read, never written.
	 */
	skills?: readonly string[];
	/** Whether the fence's first stage takes it unasked; by default, as it started. */
	staged?: (env: NodeJS.ProcessEnv) => boolean;
	/**
	 * Judged for a language server, whose strict fence reaches none of
	 * gcloud's settings, so pi reads and writes for it only where the
	 * server itself could.
	 */
	served?: boolean;
	/** Whether on a Mac, whose volumes fold case; this process's by default. */
	mac?: boolean;
}

/**
 * The fence pi's file tools hold `call` to, read as `fileToolRefusal`
 * reads it, as a host's record names it; nothing for another tool.
 */
export function fileToolFence(
	call: ToolCall,
	env: NodeJS.ProcessEnv,
	staged?: (env: NodeJS.ProcessEnv) => boolean,
): FenceKind | undefined {
	return FILE_TOOLS.has(call.toolName) ? filesFence(env, staged) : undefined;
}

/** The fence pi's file tools run under in `env`, as fileToolRefusal judges them. */
export function filesFence(
	env: NodeJS.ProcessEnv,
	staged?: (env: NodeJS.ProcessEnv) => boolean,
): FenceKind {
	const asked = askedSandbox(env, SANDBOX_NAMES, staged).name;
	if (asked === STRICT) return "strict";
	return asked === FENCE ? "fence" : "none";
}

/**
 * Why a sandbox refuses a call to one of pi's file tools, when it does.
 * Every path the tool may open is checked, through its links, so a link
 * made inside the work leads nowhere it couldn't. Any other tool, or a
 * session with no sandbox, is let through.
 */
export function fileToolRefusal(
	call: ToolCall,
	place: FilePlace,
): string | undefined {
	const tool = FILE_TOOLS.get(call.toolName);
	if (!tool) return undefined;
	// Read as the shell's commands read it, the first stage's default and a
	// stray value included, so pi's file tools are fenced as they are.
	const asked = askedSandbox(place.env, SANDBOX_NAMES, place.staged).name;
	if (!asked) return undefined;
	if (asked === STRICT) {
		// A folder holding its git folder is refused for what writing there
		// would reach, which reading it doesn't, so a review that falls back
		// to a plain clone still reads it. The home folder is refused both
		// ways, and a folder lying in or holding what the fence hides, since
		// reading there hands it over.
		const unfenced = unfencedFolder(place.cwd, place.home);
		if (unfenced && (tool.use === "write" || within(place.home, place.cwd))) {
			return `${unfenced} pi's file tools don't ${tool.use} there either.`;
		}
		const hidden = unfenced && hiddenFolder(place.cwd, place.home);
		if (hidden) return hidden;
	}
	const path = pathOf(call.input, tool.searches);
	if (path === undefined) {
		return `${SANDBOX_VARIABLE}=${asked} checks the path each file tool names, and this ${call.toolName} named none it could check, so it didn't run.`;
	}
	let candidates: string[];
	try {
		candidates = toolPaths(path, place.cwd, place.home);
	} catch {
		return `${SANDBOX_VARIABLE}=${asked} couldn't tell where ${path} leads, so ${call.toolName} didn't run.`;
	}
	return asked === FENCE
		? fenceRefusal(call.toolName, tool.use, path, candidates, place)
		: strictRefusal(call.toolName, tool.use, path, candidates, place);
}

/**
 * The agent fence's refusal: a write where a fenced command couldn't
 * write, or a read of another process's `/proc` or the runtime folder.
 */
function fenceRefusal(
	toolName: string,
	use: FileUse,
	path: string,
	candidates: readonly string[],
	place: FilePlace,
): string | undefined {
	const trees = brokerTrees(place.env.PI_SESSION_ID);
	makeScratches();
	const scratch = questScratch(place.env.TMPDIR);
	const fence = {
		home: place.home,
		runtimeDir: place.env.XDG_RUNTIME_DIR,
		cwd: place.cwd,
		ownGitFolder: treeGit(place.cwd, place.home)?.gitDir,
		heldWorktrees: heldWorktrees(trees.held),
		scratch,
		// Made as a command's wrap makes them, so a first write before any
		// command finds the session's own share its own.
		share: makeShares(scratch),
		trees,
	};
	// A linked home is judged as it's named and as it leads, since the
	// lists are built from the home as named and a path from where it leads.
	// Its work is led past its links with it, so a work named through the
	// link stays the entry it works in.
	const led = pastLinks(place.home);
	const fences =
		led === place.home
			? [fence]
			: [fence, { ...fence, home: led, cwd: pastLinks(place.cwd) }];
	const mac = place.mac ?? process.platform === "darwin";
	const spelling = mac ? listSpelling(place.home) : undefined;
	const lists = mac ? macLists(place) : undefined;
	for (const candidate of candidates) {
		const reached = leadsTo(candidate);
		if (reached === undefined) {
			return `${SANDBOX_VARIABLE}=${FENCE} couldn't say where ${path} leads (${CANT_FOLLOW}), so ${toolName} didn't run.`;
		}
		// On a Mac each is judged as the lists spell it too, since its
		// volumes open ~/.NPMRC as ~/.npmrc.
		// The path as named keeps its own links, so only its case is the
		// lists'; where it leads is as the volume spells it, then the lists.
		const named = spelling ? spelling(candidate) : candidate;
		const real = spelling ? spelling(spelledOnDisk(reached)) : reached;
		// A write may replace a link where it sits rather than write
		// through it, so that place counts too, its folder as the volume
		// spells it, since the lists compare case as they're spelled.
		const sits = spelling
			? spelling(join(spelledOnDisk(dirname(candidate)), basename(candidate)))
			: candidate;
		const judged = use === "write" ? [real, named, sits] : [real];
		const macRefusal = lists && macRefuses(judged, use, lists);
		if (macRefusal === "secret") {
			return `${SANDBOX_VARIABLE}=${FENCE} keeps the Mac's own secrets out of reach, as its commands' seatbelt does: the keychains, 1Password's, the browsers' profiles and cookies, Mail, Messages, and gh's and op's settings. ${path} leads to ${real}, so ${toolName} didn't run. A command that needs a key or token gets it through secret_run, which asks the person to release it to that one command.`;
		}
		if (macRefusal === "kept") {
			return `${SANDBOX_VARIABLE}=${FENCE} keeps what the Mac runs later as the person read-only, as its commands' seatbelt does: the launch agents, preferences, services, scripts, apps' containers, the apps, Homebrew, /usr/local and every folder on the commands' PATH outside the work. ${path} leads to ${real}, so ${toolName} didn't run. Change them through core and a switch, or put a program the session makes in its own work.`;
		}
		// The path as named counts as well as where it leads: writing a
		// link in a read-only place may replace the link itself.
		if (
			use === "write" &&
			fences.some((each) =>
				[named, sits, real].some((path) => fenceRefusesWrite(path, each)),
			)
		) {
			return `${SANDBOX_VARIABLE}=${FENCE} keeps the settings and startup files that run as the person, the checkouts under ~/src and ~/world, the work tool's trees but the session's own, the folders the person browses in the home folder but the one the session works in, and other quests' scratch and shared folders read-only, and the runtime folder out of reach: ${path} leads to ${real}, so ${toolName} didn't run. Work in a tree the work tool cuts (\`work tree\`), change settings through core and a switch, and another quest's files through its sessions.`;
		}
		if (fences.some((each) => fenceRefusesRead(real, each))) {
			return `${SANDBOX_VARIABLE}=${FENCE} keeps other processes, the runtime folder and the files holding keys or registry tokens out of reach: ${path} leads to ${real}, so ${toolName} didn't run. ${readRoute(real, place)}`;
		}
		// pi's grep and find run rg and fd in pi's own process, outside the
		// fence, so a walk of a folder holding what the fence hides would
		// open it: grep would hand its lines to the model, and on a Mac
		// either would open what Santa watches.
		const walks = FILE_TOOLS.get(toolName)?.walks;
		const hidden =
			(walks === "contents"
				? fences
						.map((each) => fenceHidesBeneath(real, each))
						.find((found) => found !== undefined)
				: undefined) ??
			(lists && walks !== undefined
				? macSecretBeneath(real, lists.secrets)
				: undefined);
		if (hidden !== undefined) {
			return `${SANDBOX_VARIABLE}=${FENCE} keeps keys, tokens, other processes and the runtime folder from pi's searches, as from every command, and ${path} holds ${hidden}, so ${toolName} didn't walk it. Search the folder inside it that you mean, or run rg or fd in bash, where the fence hides what it holds.`;
		}
	}
	return undefined;
}

/**
 * A name as a Mac's volume compares it, or wider: composed, and folded
 * up then down, so `ß` meets `SS` and `ſ` meets `s`. Folding wider than
 * the volume refuses a name it would keep apart, which fails closed, as
 * on a volume made case-sensitive, where these lists refuse more than
 * the seatbelt does.
 */
function folded(name: string): string {
	return name.normalize("NFC").toUpperCase().toLowerCase();
}

/** A path folded a part at a time, as `folded` folds each name. */
function foldedPath(path: string): string {
	return path.split("/").map(folded).join("/");
}

/** Whether `path` lies in `folder`, as a Mac's volume compares names. */
function insideFolded(path: string, folder: string): boolean {
	return inside(foldedPath(path), foldedPath(folder));
}

/** What the Mac's seatbelt closes that Linux's lists don't, by place. */
interface MacLists {
	/** Closed to reading and writing alike. */
	readonly secrets: readonly string[];
	/** Closed to writing: what runs later as the person. */
	readonly kept: readonly string[];
}

/**
 * Each place the seatbelt closes, from the home as named and as it
 * leads, and where each place leads too: the seatbelt closes the place
 * a list's entry links to (~/.config/gh to ~/dotfiles/gh), so the file
 * tools do, and one not made yet where its folder leads, as the
 * seatbelt names it. The folders on the commands' PATH outside the work are kept
 * as the seatbelt keeps them, since a program written there runs later
 * by name.
 */
function macLists(place: FilePlace): MacLists {
	const homes = [...new Set([place.home, pastLinks(place.home)])];
	const withLeads = (paths: readonly string[]) => [
		...new Set(paths.flatMap((path) => [path, spelledOnDisk(path)])),
	];
	const fromHomes = (entries: readonly string[]) =>
		homes.flatMap((from) => entries.map((entry) => join(from, entry)));
	const onPath = (place.env.PATH ?? "")
		.split(":")
		.filter((entry) => entry.startsWith("/") && !within(entry, place.cwd));
	return {
		secrets: withLeads(fromHomes(MAC_SECRETS)),
		kept: withLeads([...fromHomes(MAC_READ_ONLY), ...MAC_PROGRAMS, ...onPath]),
	};
}

/**
 * The first of the Mac's own secrets inside `path` that is there, as the
 * volume compares names: a walk of `path` would open it.
 */
function macSecretBeneath(
	path: string,
	secrets: readonly string[],
): string | undefined {
	const walked = foldedPath(path);
	return secrets.find(
		(secret) =>
			foldedPath(secret) !== walked &&
			insideFolded(secret, path) &&
			existsSync(secret),
	);
}

/**
 * What the Mac's seatbelt closes that Linux's lists don't, for any of
 * `paths`: a secret is closed to reading and writing alike, and what runs
 * later as the person to writing.
 */
function macRefuses(
	paths: readonly string[],
	use: FileUse,
	lists: MacLists,
): "secret" | "kept" | undefined {
	const inAny = (places: readonly string[]) =>
		paths.some((path) => places.some((at) => insideFolded(path, at)));
	if (inAny(lists.secrets)) return "secret";
	return use === "write" && inAny(lists.kept) ? "kept" : undefined;
}

/**
 * How a Mac's paths are spelled for the fence's lists: a name that folds
 * to a closed path's as the list spells it, since a Mac's volumes fold
 * case and would open ~/Library/keychains as ~/Library/Keychains. Each
 * part is folded on its own, so a fold that changes a name's length
 * (`ß` to `ss`) still meets the list's spelling rather than letting it
 * through. Closed paths nested in others are spelled after them, the
 * shortest first, so each part takes the list's own spelling.
 */
function listSpelling(home: string): (path: string) => string {
	const closed = closedPaths(home, true, false, true)
		.concat(closedPaths(home, true, true, true))
		.map((entry) => entry.split("/"))
		.sort((a, b) => a.length - b.length);
	return (path) =>
		closed.reduce((spelled, entry) => {
			const parts = spelled.split("/");
			const meets =
				entry.length <= parts.length &&
				entry.every((part, at) => folded(part) === folded(parts[at] ?? ""));
			return meets
				? [...entry, ...parts.slice(entry.length)].join("/")
				: spelled;
		}, path);
}

/**
 * `path` as its volume spells what of it is there, the rest as given: on
 * a Mac, realpath answers in the case the folder was made in.
 */
function spelledOnDisk(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		// Not there: spell its folder, and keep its own name as given.
	}
	const parent = dirname(path);
	return parent === path ? path : join(spelledOnDisk(parent), basename(path));
}

/**
 * The way to what a fenced read was refused, for the file it named: a
 * command reads npm's settings without their tokens, and a key or token
 * reaches one command through `secret_run`, which asks the person.
 */
function readRoute(real: string, place: FilePlace): string {
	const npmrcs = [place.home, pastLinks(place.home)].map((from) =>
		join(from, ".npmrc"),
	);
	if (npmrcs.includes(real)) {
		return "A command reads ~/.npmrc without its tokens.";
	}
	const runtime = place.env.XDG_RUNTIME_DIR;
	if (real.startsWith("/proc/") || (runtime && inside(real, runtime))) {
		return "Nothing inside reaches it; ask the person for what it holds.";
	}
	return "A command that needs the key or token it holds gets it through secret_run, which asks the person to release it to that one command.";
}

/**
 * The strict profile's refusal: a path that leads where a fenced command
 * couldn't reach, or couldn't write to for a tool that writes.
 */
function strictRefusal(
	toolName: string,
	use: FileUse,
	path: string,
	candidates: readonly string[],
	place: FilePlace,
): string | undefined {
	const { cwd, home } = place;
	const reach = fileReach(
		{
			home,
			runtimeDir: place.env.XDG_RUNTIME_DIR,
			cwd,
			repository: worktreeRepository(cwd, home),
			...(place.served ? { served: true } : {}),
		},
		use,
	)
		.concat(use === "read" ? (place.skills ?? []) : [])
		.flatMap((folder) => leadsTo(folder) ?? []);
	for (const candidate of candidates) {
		const real = leadsTo(candidate);
		if (real !== undefined && reach.some((folder) => inside(real, folder))) {
			continue;
		}
		const where =
			real === undefined
				? `where it couldn't be followed: ${CANT_FOLLOW}`
				: `to ${real}, outside it`;
		const what =
			use === "write"
				? "may write only in the working folder and the sandbox's own cache and temporary folder"
				: "may read only what its commands may, and the session's skills: the work, the store, and the system's and git's settings";
		return `${SANDBOX_VARIABLE}=${STRICT} holds pi's file tools to its fence: ${toolName} ${what}, and ${path} leads ${where}, so it didn't run.`;
	}
	return undefined;
}
