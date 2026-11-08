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
 *   are out of reach.
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
 * Code written in the working folder can still run later outside, an
 * `.envrc` once the person allows it. The sandbox narrows what a command
 * reaches now, not what the person later runs from what it wrote.
 */

import {
	accessSync,
	constants,
	mkdirSync,
	realpathSync,
	statSync,
} from "node:fs";
import { delimiter, join, relative } from "node:path";

/** The variable that asks for the sandbox, and the one value it takes. */
export const SANDBOX_VARIABLE = "PI_SANDBOX";
export const STRICT = "strict";

/** The variable the command travels in through landrun, as through the shell. */
export const SANDBOXED_COMMAND = "PI_SANDBOXED_COMMAND";

/** The Nix daemon's door for sandboxes, in the account's runtime folder. */
export const NIX_DOOR = "nix-untrusted.sock";

/**
 * Variables kept from the sandbox: the bus's address names a socket it
 * can't reach anyway, and Nix and the cache are pointed at the sandbox's
 * own instead.
 */
const WITHHELD = [
	"DBUS_SESSION_BUS_ADDRESS",
	"NIX_REMOTE",
	"TMPDIR",
	"XDG_CACHE_HOME",
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
}

/** A rule landrun takes: what it is, and the path or value it is for. */
type Rule = readonly [flag: string, value: string];

/**
 * The strict profile's rules. Paths that don't exist on a machine are
 * passed anyway and skipped (`--ignore-missing`), so one list serves
 * every machine.
 */
export function strictRules(place: SandboxPlace): Rule[] {
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
 * every one it exports, as it stands once the queue has had its say, less
 * those withheld. The command travels in a variable, as it does through
 * the shell, so `pkill -f` matches only what it names (see
 * `command-line.ts`), and it is unset before it runs.
 */
export function sandboxedCommand(
	command: string,
	rules: readonly Rule[],
	landrun: string,
): string {
	const withheld = WITHHELD.join("|");
	const flags = rules.map(([flag, value]) => `${flag} ${quoted(value)}`);
	const stub = `eval "unset ${SANDBOXED_COMMAND}; $${SANDBOXED_COMMAND}"`;
	return [
		`__pi_env=(); for __pi_name in $(compgen -e); do case $__pi_name in ${withheld}) ;; *) __pi_env+=(--env "$__pi_name");; esac; done`,
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
			return `${SANDBOX_VARIABLE}=${STRICT} won't let commands write ${cwd}, which holds its repository's git folder, whose hooks and settings git runs outside the sandbox, so no command runs. Work in a worktree, whose git folder lies elsewhere.`;
		}
	} catch {
		// No git folder here, or a worktree's .git file pointing elsewhere.
	}
	return undefined;
}

/** How a session's commands run: as they are, fenced, or not at all. */
export type Sandbox =
	| { readonly kind: "none" }
	| { readonly kind: "strict"; readonly landrun: string }
	| { readonly kind: "refused"; readonly reason: string };

/** What the session asked for, and whether this machine can give it. */
export function sandboxFor(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	find: (program: string) => string | undefined = onPath,
): Sandbox {
	const asked = env[SANDBOX_VARIABLE]?.trim();
	if (!asked) return { kind: "none" };
	if (asked !== STRICT) {
		return {
			kind: "refused",
			reason: `${SANDBOX_VARIABLE}=${asked} names no sandbox; the one there is is "${STRICT}". No command runs until it is set right or unset.`,
		};
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
			});
			return (command) => sandboxedCommand(command, rules, sandbox.landrun);
		}
	}
}
