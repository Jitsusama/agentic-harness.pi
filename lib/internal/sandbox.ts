/**
 * The agent's commands fenced off from what the person holds, for a
 * session that reads what a stranger wrote.
 *
 * Every command an agent runs runs as the person: it can read each token
 * and key they keep, reach every socket they can, and write code that runs
 * later as them. A session reviewing an outside change, reading the web or
 * running as a subagent is handed text a stranger wrote, and that text can
 * tell the agent what to run. Set `PI_SANDBOX=strict` in such a session and
 * each command runs under Landlock, through landrun, with:
 *
 * - **No credentials:** nothing in the home folder is readable but git's
 *   and Nix's settings, so keys, tokens, browser profiles and session logs
 *   are out of reach, and only variables known to be harmless are passed
 *   in, since a session's environment holds tokens too.
 * - **No sockets but one:** no session or system bus (the way into the
 *   keyring and to root), no SSH or signing agent, no terminal's remote
 *   control, and no abstract socket. Nix answers through its door for
 *   sandboxes, which takes its caller as untrusted, since the daemon's own
 *   socket trusts the person's account and so hands over root.
 * - **Writes only to the work:** the working folder, and a temporary
 *   folder and a cache of the sandbox's own, which `TMPDIR` and
 *   `XDG_CACHE_HOME` name. The person's own cache and `/tmp` stay out of
 *   reach both ways: they hold tokens, code their shell runs at every
 *   start, and scripts other sessions run unfenced. No signal reaches a
 *   process outside the sandbox.
 * - **The network,** since fetching is most of what such a session does.
 *
 * Landlock alone does this in 20 to 35 ms a command, with no namespaces,
 * so the person's own tools run as they do. Unlike bwrap alone, it also
 * refuses abstract Unix sockets, which a mount namespace leaves reachable
 * while the network is shared. A session that asks for the sandbox where it can't be
 * had (not Linux, or no landrun) runs no command at all rather than run
 * one unfenced.
 *
 * A working folder that is the home folder, or holds it, would hand over
 * the person's startup files, and one holding its repository's git folder
 * would hand over the hooks and settings git runs outside, so the sandbox
 * runs no command in either; a worktree keeps its git folder elsewhere.
 * Its repository is readable, so git works, and never writable: a
 * worktree's own folder there names the repository git uses and may hold
 * its settings, so writing it would hand over the person's next git
 * command in that tree.
 * Code written in the working folder can still run later outside, an
 * `.envrc` once the person allows it. The sandbox narrows what a command
 * reaches now, not what the person later runs from what it wrote.
 *
 * pi's own file tools run in pi's process, outside Landlock, so
 * `fileToolRefusal` holds them to the same paths for the
 * `sandbox-file-interceptor` extension, less `/proc` and the devices.
 */

import {
	accessSync,
	constants,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	statSync,
} from "node:fs";
import {
	basename,
	delimiter,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./record.ts";

/** The variable that asks for the sandbox, and the one value it takes. */
export const SANDBOX_VARIABLE = "PI_SANDBOX";
export const STRICT = "strict";

/** The variable the command travels in through landrun, as through the shell. */
export const SANDBOXED_COMMAND = "PI_SANDBOXED_COMMAND";

/** The Nix daemon's door for sandboxes, in the account's runtime folder. */
export const NIX_DOOR = "nix-untrusted.sock";

/**
 * Variables kept from the sandbox whatever their names: the bus's address
 * names a socket it can't reach anyway, and Nix and the cache are pointed
 * at the sandbox's own instead.
 */
const WITHHELD = [
	"DBUS_SESSION_BUS_ADDRESS",
	"NIX_REMOTE",
	"TMPDIR",
	"XDG_CACHE_HOME",
] as const;

/**
 * The variables a command keeps, as the shell's patterns: where things
 * are, how to show them, and what the queue sets. A session's environment
 * holds registry, gateway and cloud tokens under names nobody could list
 * ahead, so the sandbox passes the names it knows are harmless rather
 * than withholding the ones it knows are not. `PI_SANDBOX` is kept, so a
 * pi started inside stays fenced.
 */
const KEPT = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"SHLVL",
	"PWD",
	"OLDPWD",
	"HOSTNAME",
	"TERM",
	"TERMINFO",
	"COLORTERM",
	"NO_COLOR",
	"FORCE_COLOR",
	"CLICOLOR",
	"CLICOLOR_FORCE",
	"LANG",
	"LANGUAGE",
	"LC_*",
	"TZ",
	"TZDIR",
	"LOCALE_ARCHIVE",
	"EDITOR",
	"VISUAL",
	"PAGER",
	"GIT_PAGER",
	"LESS",
	"CI",
	"NIX_PROFILES",
	"NIX_SSL_CERT_FILE",
	"NIX_USER_CONF_FILES",
	"NIX_BUILD_CORES",
	"SSL_CERT_FILE",
	"CURL_CA_BUNDLE",
	"GIT_SSL_CAINFO",
	"CARGO_BUILD_JOBS",
	"PI_SANDBOX",
	"*_HOME",
	"*PATH",
	"*_DIR",
	"*_DIRS",
] as const;

/** Words no kept variable's name may hold, even one `KEPT` lets through. */
const NEVER = [
	"*TOKEN*",
	"*KEY*",
	"*SECRET*",
	"*PASS*",
	"*AUTH*",
	"*CRED*",
	"*COOKIE*",
	"*SESSION*",
	"*SOCK*",
] as const;

/**
 * The sandbox's own folder in the home folder, beneath the person's cache,
 * which it never reaches: its cache and its temporary folder, shared by
 * every sandboxed command and used by nothing outside.
 */
export const SANDBOX_FOLDER = ".cache/pi-sandbox";

/** The sandbox's cache and temporary folder, for the home folder `home`. */
export function sandboxFolders(home: string): {
	cache: string;
	temporary: string;
} {
	return {
		cache: join(home, SANDBOX_FOLDER, "cache"),
		temporary: join(home, SANDBOX_FOLDER, "tmp"),
	};
}

/** Where a command runs, as the sandbox's rules need it. */
export interface SandboxPlace {
	readonly home: string;
	/** `XDG_RUNTIME_DIR`, where the Nix door is. */
	readonly runtimeDir: string | undefined;
	readonly cwd: string;
	/** The git folder of the repository `cwd` is a worktree of, if it is one. */
	readonly repository?: string;
}

/** A rule landrun takes: what it is, and the path or value it is for. */
type Rule = readonly [flag: string, value: string];

/** The paths the strict profile gives, by what it lets a command do there. */
interface StrictPaths {
	readonly runnable: readonly string[];
	readonly readable: readonly string[];
	readonly writable: readonly string[];
	readonly sockets: readonly string[];
}

/** The strict profile's paths, for the place a command runs in. */
function strictPaths(place: SandboxPlace): StrictPaths {
	const home = (path: string) => join(place.home, path);
	const runnable = [
		"/nix/store",
		"/run/current-system",
		"/run/booted-system",
		"/run/opengl-driver",
		"/run/wrappers",
		"/etc/profiles",
		"/nix/var/nix/profiles",
		"/usr",
		"/bin",
		home(".nix-profile"),
		home(".local/state/nix/profile"),
	];
	const readable = [
		"/etc",
		"/proc",
		"/sys",
		"/nix/var/nix/db",
		"/run/systemd/resolve",
		"/dev/urandom",
		"/dev/random",
		home(".gitconfig"),
		home(".config/git"),
		home(".config/dev"),
		home(".config/nix/nix.conf"),
		...(place.repository ? [place.repository] : []),
	];
	const own = sandboxFolders(place.home);
	const writable = [
		place.cwd,
		own.temporary,
		own.cache,
		"/dev/null",
		"/dev/full",
		"/dev/zero",
		"/dev/shm",
	];
	const sockets = [
		"/run/nscd/socket",
		...(place.runtimeDir ? [join(place.runtimeDir, NIX_DOOR)] : []),
	];
	return { runnable, readable, writable, sockets };
}

/**
 * The strict profile's rules. Paths that don't exist on a machine are
 * passed anyway and skipped (`--ignore-missing`), so one list serves
 * every machine.
 */
export function strictRules(place: SandboxPlace): Rule[] {
	const { runnable, readable, writable, sockets } = strictPaths(place);
	const own = sandboxFolders(place.home);
	return [
		...runnable.map((path): Rule => ["--rox", path]),
		...readable.map((path): Rule => ["--ro", path]),
		...writable.map((path): Rule => ["--rw", path]),
		...sockets.map((path): Rule => ["--unix", path]),
		["--env", `TMPDIR=${own.temporary}`],
		["--env", `XDG_CACHE_HOME=${own.cache}`],
		...(place.runtimeDir
			? [
					[
						"--env",
						`NIX_REMOTE=unix://${join(place.runtimeDir, NIX_DOOR)}`,
					] as Rule,
				]
			: []),
	];
}

/** `text` as one word to the shell, whatever it holds. */
export function quoted(text: string): string {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * The shell text that runs `command` under landrun with `rules`.
 *
 * landrun passes only the variables it is told to, so the shell names
 * each one it exports that `KEPT` allows, as it stands once the queue has
 * had its say, less those withheld and any whose name `NEVER` matches. The command travels in a variable, as it does through
 * the shell, so `pkill -f` matches only what it names (see
 * `command-line.ts`), and it is unset before it runs.
 */
export function sandboxedCommand(
	command: string,
	rules: readonly Rule[],
	landrun: string,
): string {
	const refused = [...WITHHELD, ...NEVER].join("|");
	const kept = KEPT.join("|");
	const flags = rules.map(([flag, value]) => `${flag} ${quoted(value)}`);
	const stub = `eval "unset ${SANDBOXED_COMMAND}; $${SANDBOXED_COMMAND}"`;
	return [
		`__pi_env=(); for __pi_name in $(compgen -e); do case $__pi_name in ${refused}) ;; ${kept}) __pi_env+=(--env "$__pi_name");; esac; done`,
		[
			`${SANDBOXED_COMMAND}=${quoted(command)}`,
			quoted(landrun),
			...flags,
			"--unrestricted-network --ignore-missing",
			`"\${__pi_env[@]}" --env ${SANDBOXED_COMMAND}`,
			`-- bash -c ${quoted(stub)}`,
		].join(" "),
	].join("\n");
}

/** The shell text that refuses to run a command, saying why. */
export function refusedCommand(reason: string): string {
	return `printf '%s\\n' ${quoted(reason)} >&2; exit 126`;
}

/** A program's path from `PATH`, when it is there and runnable. */
export function onPath(
	program: string,
	path: string | undefined = process.env.PATH,
): string | undefined {
	for (const folder of (path ?? "").split(delimiter)) {
		if (!folder) continue;
		const candidate = join(folder, program);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Not here; the next folder may hold it.
		}
	}
	return undefined;
}

/** A path as it really is, or as given when it can't be resolved. */
function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Whether `path` is `folder` or lies inside it, as both really are. */
function within(path: string, folder: string): boolean {
	const between = relative(real(folder), real(path));
	return (
		between === "" || !(between.startsWith("..") || between.startsWith("/"))
	);
}

/**
 * Why the sandbox can't let commands write `cwd`, when it can't: its
 * writes would reach what runs outside the sandbox later.
 */
export function unfencedFolder(cwd: string, home: string): string | undefined {
	if (within(home, cwd)) {
		return `${SANDBOX_VARIABLE}=${STRICT} won't let commands write ${cwd}, which holds the home folder and the startup files that run outside the sandbox, so no command runs. Start the session in the folder it works on.`;
	}
	try {
		if (statSync(join(cwd, ".git")).isDirectory()) {
			return `${SANDBOX_VARIABLE}=${STRICT} won't let commands write ${cwd}, which holds its repository's git folder, whose hooks and settings git runs outside the sandbox, so no command runs. Work in a tree the work tool cuts (\`work tree\`) or a snapshot, whose git folder lies elsewhere; a plain clone won't do.`;
		}
	} catch {
		// No git folder here, or a worktree's .git file pointing elsewhere.
	}
	return undefined;
}

/**
 * The git folder of the repository `cwd` is a worktree of, for the
 * sandbox to read, or nothing when it isn't one.
 *
 * The `.git` file naming it lies in the working folder, which commands
 * write, so it is taken only when the folder it names is a worktree's
 * own, in its repository's `worktrees`, and points back at this `.git`;
 * a command can make neither outside its work. A repository holding the
 * home folder is never given.
 */
export function worktreeRepository(
	cwd: string,
	home: string,
): string | undefined {
	try {
		const dotGit = join(cwd, ".git");
		const named = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
		if (!named) return undefined;
		const own = real(resolve(cwd, named.trim()));
		if (basename(dirname(own)) !== "worktrees") return undefined;
		const repository = dirname(dirname(own));
		const back = readFileSync(join(own, "gitdir"), "utf8").trim();
		if (real(resolve(own, back)) !== real(dotGit)) return undefined;
		if (!statSync(join(repository, "objects")).isDirectory()) return undefined;
		return within(home, repository) ? undefined : repository;
	} catch {
		// No .git file here, or one naming no worktree of a repository.
		return undefined;
	}
}

/** How a session's commands run: as they are, fenced, or not at all. */
export type Sandbox =
	| { readonly kind: "none" }
	| { readonly kind: "strict"; readonly landrun: string }
	| { readonly kind: "refused"; readonly reason: string };

/** Why a sandbox that isn't there is refused, for what it would fence. */
function noSuchSandbox(asked: string, what: string): string {
	return `${SANDBOX_VARIABLE}=${asked} names no sandbox; the one there is is "${STRICT}". No ${what} runs until it is set right or unset.`;
}

/** What the session asked for, and whether this machine can give it. */
export function sandboxFor(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	find: (program: string) => string | undefined = onPath,
): Sandbox {
	const asked = env[SANDBOX_VARIABLE]?.trim();
	if (!asked) return { kind: "none" };
	if (asked !== STRICT) {
		return { kind: "refused", reason: noSuchSandbox(asked, "command") };
	}
	if (platform !== "linux") {
		return {
			kind: "refused",
			reason: `${SANDBOX_VARIABLE}=${STRICT} asks for a Landlock sandbox, which only Linux has, so no command runs unfenced here.`,
		};
	}
	const landrun = find("landrun");
	if (!landrun) {
		return {
			kind: "refused",
			reason: `${SANDBOX_VARIABLE}=${STRICT} asks for a sandbox, but landrun isn't on PATH, so no command runs unfenced.`,
		};
	}
	return { kind: "strict", landrun };
}

/**
 * The wrap a sandbox puts around each command, for the place it runs in,
 * or nothing when the session runs commands as they are.
 */
export function wrapFor(
	sandbox: Sandbox,
	place: { cwd: string; env: NodeJS.ProcessEnv },
	home: string,
): ((command: string) => string) | undefined {
	switch (sandbox.kind) {
		case "none":
			return undefined;
		case "refused":
			return () => refusedCommand(sandbox.reason);
		case "strict": {
			const unfenced = unfencedFolder(place.cwd, home);
			if (unfenced) return () => refusedCommand(unfenced);
			// landrun skips a path that isn't there, and nothing inside could
			// make one, so the sandbox's folders are made before a command.
			for (const folder of Object.values(sandboxFolders(home))) {
				mkdirSync(folder, { recursive: true, mode: 0o700 });
			}
			const rules = strictRules({
				home,
				runtimeDir: place.env.XDG_RUNTIME_DIR,
				cwd: place.cwd,
				repository: worktreeRepository(place.cwd, home),
			});
			return (command) => sandboxedCommand(command, rules, sandbox.landrun);
		}
	}
}

/** What one of pi's own file tools does with the path it names. */
export type FileUse = "read" | "write";

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

/**
 * Where pi's file tools may `use` a path under the strict profile: where
 * a command may, less `/proc` and the devices. pi's tools run in pi's own
 * process, unfenced, and its `/proc/self/environ` holds every token the
 * sandbox keeps from commands.
 */
export function fileReach(place: SandboxPlace, use: FileUse): string[] {
	const { runnable, readable, writable } = strictPaths(place);
	const ours = (path: string) => path !== "/proc" && !path.startsWith("/dev/");
	const written = writable.filter(ours);
	if (use === "write") return written;
	return [...runnable, ...readable.filter(ours), ...written];
}

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

/**
 * Why the strict profile refuses a call to one of pi's file tools, when
 * it does: one naming a path that leads where a fenced command couldn't
 * reach, or that it couldn't write to for a tool that writes. Every path
 * the tool may open is checked, through its links, so a link made inside
 * the work leads nowhere it couldn't. A working folder holding its git
 * folder may be read but never written. Any other tool, or a session
 * with no sandbox, is let through.
 */
export function fileToolRefusal(
	call: ToolCall,
	place: { cwd: string; env: NodeJS.ProcessEnv; home: string },
): string | undefined {
	const asked = place.env[SANDBOX_VARIABLE]?.trim();
	const tool = FILE_TOOLS.get(call.toolName);
	if (!asked || !tool) return undefined;
	if (asked !== STRICT) return noSuchSandbox(asked, "file tool");
	const { cwd, home } = place;
	// A folder holding its git folder is refused for what writing there
	// would reach, which reading it doesn't, so a review that falls back
	// to a plain clone still reads it. The home folder is refused both ways.
	const unfenced = unfencedFolder(cwd, home);
	if (unfenced && (tool.use === "write" || within(home, cwd))) {
		return `${unfenced} pi's file tools don't ${tool.use} there either.`;
	}
	const path = pathOf(call.input, tool.searches);
	if (path === undefined) {
		return `${SANDBOX_VARIABLE}=${STRICT} checks the path each file tool names, and this ${call.toolName} named none it could check, so it didn't run.`;
	}
	let candidates: string[];
	try {
		candidates = toolPaths(path, cwd, home);
	} catch {
		return `${SANDBOX_VARIABLE}=${STRICT} couldn't tell where ${path} leads, so ${call.toolName} didn't run.`;
	}
	const reach = fileReach(
		{
			home,
			runtimeDir: place.env.XDG_RUNTIME_DIR,
			cwd,
			repository: worktreeRepository(cwd, home),
		},
		tool.use,
	).flatMap((folder) => leadsTo(folder) ?? []);
	for (const candidate of candidates) {
		const real = leadsTo(candidate);
		if (real !== undefined && reach.some((folder) => inside(real, folder))) {
			continue;
		}
		const where =
			real === undefined ? "through a loop of links" : `to ${real}, outside it`;
		const what =
			tool.use === "write"
				? "may write only in the working folder and the sandbox's own cache and temporary folder"
				: "may read only what its commands may: the work, the store, and the system's and git's settings";
		return `${SANDBOX_VARIABLE}=${STRICT} holds pi's file tools to its fence: ${call.toolName} ${what}, and ${path} leads ${where}, so it didn't run.`;
	}
	return undefined;
}
