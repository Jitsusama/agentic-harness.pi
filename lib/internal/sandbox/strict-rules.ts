/**
 * What the strict profile lets a command reach: the paths it may run,
 * read and write, the sockets it may use, and the sandbox's own folders
 * beside them, as landrun's rules and as pi's file tools read them.
 *
 * The working folder and the sandbox's temporary folder let a command
 * run what it wrote there too, since a build runs what it builds: cargo's
 * build scripts failed with "Permission denied (os error 13)" in rooms
 * while those folders were only writable. That adds no reach. A strict
 * command could already run any code from them through the store's
 * interpreters (bash, python, node, ctypes), and what any of it touches
 * is still bounded by Landlock's path, socket and network rules and,
 * under the fence, by bubblewrap's binds. The temporary folder is the
 * session's own, so what one session reading a stranger's text writes
 * there is no program another runs. The cache, gcloud's settings and
 * the devices stay only writable, since nothing is built there.
 */
import { basename, dirname, join } from "node:path";
import { workerSocketRule } from "../fence/fence-worker-socket.ts";

/** The Nix daemon's door for sandboxes, in the account's runtime folder. */
export const NIX_DOOR = "nix-untrusted.sock";

/**
 * The sandbox's own folder in the home folder, beneath the person's cache,
 * which it never reaches: its cache, shared by every sandboxed command,
 * and a temporary folder for each session, used by nothing outside.
 */
const SANDBOX_FOLDER = ".cache/pi-sandbox";

/** A name a folder may take whole: a session's id, or a process's. */
const FOLDER_NAME = /^[A-Za-z0-9-]{1,64}$/;

/** A session's name as a folder may take it, or the process's where there is none. */
export function sessionFolderName(env: NodeJS.ProcessEnv): string {
	const session = env.PI_SESSION_ID ?? "";
	return FOLDER_NAME.test(session) ? session : `pid-${process.pid}`;
}

/**
 * The temporary folder a strict command in the session `env` names is
 * given: one of the session's own, since a command runs what it writes
 * there and one shared folder would let a session reading a stranger's
 * text plant a program another runs. A command already inside one, as
 * a strict pi's own commands are, keeps it: it can make no other.
 */
function temporaryFolder(home: string, env: NodeJS.ProcessEnv): string {
	const every = join(home, SANDBOX_FOLDER, "tmp");
	const inherited = env.TMPDIR;
	if (
		inherited !== undefined &&
		dirname(inherited) === every &&
		FOLDER_NAME.test(basename(inherited))
	) {
		return inherited;
	}
	return join(every, sessionFolderName(env));
}

/**
 * The sandbox's cache, temporary folder and gcloud's settings, for the
 * home folder `home` and the session `env` names. gcloud writes its logs
 * and settings where it's pointed, so each session gets a folder of its
 * own within `gcloud`, as it does a temporary folder.
 */
export function sandboxFolders(
	home: string,
	env: NodeJS.ProcessEnv,
): {
	cache: string;
	temporary: string;
	gcloud: string;
} {
	return {
		cache: join(home, SANDBOX_FOLDER, "cache"),
		temporary: temporaryFolder(home, env),
		gcloud: join(home, SANDBOX_FOLDER, "gcloud"),
	};
}

/** Where a command runs, as the sandbox's rules need it. */
export interface SandboxPlace {
	readonly home: string;
	/** The command's environment, which names its session. */
	readonly env: NodeJS.ProcessEnv;
	/** `XDG_RUNTIME_DIR`, where the Nix door is. */
	readonly runtimeDir: string | undefined;
	readonly cwd: string;
	/** The git folder of the repository `cwd` is a worktree of, if it is one. */
	readonly repository?: string;
	/**
	 * Drawn for a language server, which reaches none of gcloud's
	 * settings: the session's next command with the cloud's grant reads
	 * them.
	 */
	readonly served?: boolean;
	/** The node's worker socket, the one of its sockets a command may reach. */
	readonly workerSocket?: string;
}

/** A rule landrun takes: what it is, and the path or value it is for. */
export type Rule = readonly [flag: string, value: string];

/** The paths the strict profile gives, by what it lets a command do there. */
interface StrictPaths {
	readonly runnable: readonly string[];
	readonly readable: readonly string[];
	/** Written, and what is written there run: where a command builds. */
	readonly buildable: readonly string[];
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
	const own = sandboxFolders(place.home, place.env);
	const buildable = [place.cwd, own.temporary];
	const writable = [
		own.cache,
		...(place.served ? [] : [own.gcloud]),
		"/dev/null",
		"/dev/full",
		"/dev/zero",
		"/dev/shm",
	];
	const sockets = [
		"/run/nscd/socket",
		...(place.runtimeDir ? [join(place.runtimeDir, NIX_DOOR)] : []),
		...(place.workerSocket ? [workerSocketRule(place.workerSocket)] : []),
	];
	return { runnable, readable, buildable, writable, sockets };
}

/**
 * The strict profile's rules. Paths that don't exist on a machine are
 * passed anyway and skipped (`--ignore-missing`), so one list serves
 * every machine.
 */
export function strictRules(place: SandboxPlace): Rule[] {
	const { runnable, readable, buildable, writable, sockets } =
		strictPaths(place);
	const own = sandboxFolders(place.home, place.env);
	return [
		...runnable.map((path): Rule => ["--rox", path]),
		...readable.map((path): Rule => ["--ro", path]),
		...buildable.map((path): Rule => ["--rwx", path]),
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

/** What one of pi's own file tools does with the path it names. */
export type FileUse = "read" | "write";

/**
 * Where pi's file tools may `use` a path under the strict profile: where
 * a command may, less `/proc` and the devices. pi's tools run in pi's own
 * process, unfenced, and its `/proc/self/environ` holds every token the
 * sandbox keeps from commands.
 */
export function fileReach(place: SandboxPlace, use: FileUse): string[] {
	const { runnable, readable, buildable, writable } = strictPaths(place);
	const ours = (path: string) => path !== "/proc" && !path.startsWith("/dev/");
	const written = [...buildable, ...writable].filter(ours);
	if (use === "write") return written;
	return [...runnable, ...readable.filter(ours), ...written];
}

/**
 * What a strict command may read in the home on a Mac, where seatbelt
 * refuses the rest: what landrun lets it run and read there on Linux,
 * and its folder. Not Linux's own temporary and cache folders, which a
 * Mac's strict command never uses and a fenced one could plant as links.
 * Kept apart from `fileReach`, pi's own tools' reach, so widening theirs
 * widens no command's.
 */
export function strictHomeReads(place: SandboxPlace): string[] {
	const { runnable, readable } = strictPaths(place);
	const inHome = (path: string) =>
		path === place.home || path.startsWith(`${place.home}/`);
	return [...runnable, ...readable, place.cwd].filter(inHome);
}
