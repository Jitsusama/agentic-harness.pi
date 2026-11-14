/**
 * pi's own file tools, held to the fence a session's commands run in.
 *
 * pi's read, edit and write run in pi's own process, outside Landlock
 * and bubblewrap, so a session whose commands are fenced would still
 * reach everything through them. `fileToolRefusal` holds them to the
 * same paths for the `sandbox-file-interceptor` extension: under the
 * strict profile, where a command may reach, less `/proc` and the
 * devices; under the agent fence, nowhere a fenced command can't write,
 * and no other process's `/proc` or the runtime folder.
 */

import { readlinkSync, realpathSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { FENCE, fenceRefusesRead, fenceRefusesWrite } from "./fence.ts";
import { isRecord } from "./record.ts";
import {
	type FileUse,
	fileReach,
	noSuchSandbox,
	OFF,
	questScratch,
	SANDBOX_VARIABLE,
	STRICT,
	unfencedFolder,
} from "./sandbox.ts";
import { treeGit, within, worktreeRepository } from "./tree-git.ts";

/**
 * pi's file tools, by what each does with its `path`. Those that search
 * a folder search the working folder when given none.
 */
const FILE_TOOLS: ReadonlyMap<
	string,
	{ readonly use: FileUse; readonly searches: boolean }
> = new Map([
	["read", { use: "read", searches: false }],
	["grep", { use: "read", searches: true }],
	["find", { use: "read", searches: true }],
	["ls", { use: "read", searches: true }],
	["edit", { use: "write", searches: false }],
	["write", { use: "write", searches: false }],
]);

/** Unicode spaces pi reads as plain ones in a path a tool is given. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Every file a tool may open for `path`, as pi resolves it: spaces made
 * plain, a leading `@` dropped, `~` and `file://` expanded, against the
 * working folder, with each spelling pi tries when the first is missing
 * (a screenshot's narrow space, decomposed accents, a curly apostrophe).
 */
export function toolPaths(path: string, cwd: string, home: string): string[] {
	let given = path.replace(UNICODE_SPACES, " ");
	if (given.startsWith("@")) given = given.slice(1);
	if (given === "~") given = home;
	else if (given.startsWith("~/")) given = join(home, given.slice(2));
	if (given.startsWith("file://")) given = fileURLToPath(given);
	const first = isAbsolute(given) ? resolve(given) : resolve(cwd, given);
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

/** How many links a path may pass through before it counts as a loop. */
const MOST_LINKS = 40;

/**
 * Where `path` really leads, through every link in it, a dangling one
 * too, since writing through a link to nothing makes the file it names;
 * nothing when its links loop.
 */
export function leadsTo(path: string, links = 0): string | undefined {
	if (links > MOST_LINKS) return undefined;
	try {
		return realpathSync(path);
	} catch {
		// Not all there, or looping: follow what is, a step at a time.
	}
	try {
		return leadsTo(resolve(dirname(path), readlinkSync(path)), links + 1);
	} catch {
		// Not a link either, so a name yet to be made.
	}
	const parent = dirname(path);
	if (parent === path) return path;
	const above = leadsTo(parent, links);
	return above === undefined ? undefined : join(above, basename(path));
}

/** Whether `path` is `folder` or lies inside it, both already resolved. */
function inside(path: string, folder: string): boolean {
	const between = relative(folder, path);
	return between === "" || !(between.startsWith("..") || isAbsolute(between));
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
	const asked = place.env[SANDBOX_VARIABLE]?.trim();
	const tool = FILE_TOOLS.get(call.toolName);
	if (!asked || asked === OFF || !tool) return undefined;
	if (asked !== STRICT && asked !== FENCE) {
		return noSuchSandbox(asked, "file tool");
	}
	if (asked === STRICT) {
		// A folder holding its git folder is refused for what writing there
		// would reach, which reading it doesn't, so a review that falls back
		// to a plain clone still reads it. The home folder is refused both
		// ways.
		const unfenced = unfencedFolder(place.cwd, place.home);
		if (unfenced && (tool.use === "write" || within(place.home, place.cwd))) {
			return `${unfenced} pi's file tools don't ${tool.use} there either.`;
		}
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
	const fence = {
		home: place.home,
		runtimeDir: place.env.XDG_RUNTIME_DIR,
		cwd: place.cwd,
		ownGitFolder: treeGit(place.cwd, place.home)?.gitDir,
		scratch: questScratch(place.env.TMPDIR),
	};
	for (const candidate of candidates) {
		const real = leadsTo(candidate);
		if (real === undefined) {
			return `${SANDBOX_VARIABLE}=${FENCE} couldn't follow ${path} through its links, so ${toolName} didn't run.`;
		}
		// The path as named counts as well as where it leads: writing a
		// link in a read-only place may replace the link itself.
		if (
			use === "write" &&
			(fenceRefusesWrite(candidate, fence) || fenceRefusesWrite(real, fence))
		) {
			return `${SANDBOX_VARIABLE}=${FENCE} keeps the settings and startup files that run as the person, the checkouts under ~/src and ~/world, the folders the person browses in the home folder but the one the session works in, and other quests' scratch folders read-only, and the runtime folder out of reach: ${path} leads to ${real}, so ${toolName} didn't run. Work in a tree the work tool cuts (\`work tree\`), change settings through core and a switch, and another quest's files through its sessions.`;
		}
		if (fenceRefusesRead(real, fence)) {
			return `${SANDBOX_VARIABLE}=${FENCE} keeps other processes, the runtime folder and the files holding keys or registry tokens out of reach: ${path} leads to ${real}, so ${toolName} didn't run. A command reads ~/.npmrc without its tokens.`;
		}
	}
	return undefined;
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
			real === undefined ? "through a loop of links" : `to ${real}, outside it`;
		const what =
			use === "write"
				? "may write only in the working folder and the sandbox's own cache and temporary folder"
				: "may read only what its commands may, and the session's skills: the work, the store, and the system's and git's settings";
		return `${SANDBOX_VARIABLE}=${STRICT} holds pi's file tools to its fence: ${toolName} ${what}, and ${path} leads ${where}, so it didn't run.`;
	}
	return undefined;
}
