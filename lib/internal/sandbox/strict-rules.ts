/**
 * What the strict profile lets a command reach: the paths it may run,
 * read and write, the sockets it may use, and the sandbox's own folders
 * beside them, as landrun's rules and as pi's file tools read them.
 */
import { join } from "node:path";
import type { BuildersReach } from "../fence/fence-builders.ts";

/** The Nix daemon's door for sandboxes, in the account's runtime folder. */
export const NIX_DOOR = "nix-untrusted.sock";

/**
 * The sandbox's own folder in the home folder, beneath the person's cache,
 * which it never reaches: its cache and its temporary folder, shared by
 * every sandboxed command and used by nothing outside.
 */
const SANDBOX_FOLDER = ".cache/pi-sandbox";

/**
 * The sandbox's cache, temporary folder and gcloud's settings, for the
 * home folder `home`. gcloud writes its logs and settings where it's
 * pointed, so each session gets a folder of its own within `gcloud`.
 */
export function sandboxFolders(home: string): {
	cache: string;
	temporary: string;
	gcloud: string;
} {
	return {
		cache: join(home, SANDBOX_FOLDER, "cache"),
		temporary: join(home, SANDBOX_FOLDER, "tmp"),
		gcloud: join(home, SANDBOX_FOLDER, "gcloud"),
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
	/**
	 * Drawn for a language server, which reaches none of gcloud's
	 * settings: the session's next command with the cloud's grant reads
	 * them.
	 */
	readonly served?: boolean;
	/**
	 * What nix-offload needs of the lent builders, so a strict command can
	 * send work to them; pi's own file tools are never given it.
	 */
	readonly builders?: BuildersReach;
}

/** A rule landrun takes: what it is, and the path or value it is for. */
export type Rule = readonly [flag: string, value: string];

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
		...(place.builders?.readable ?? []),
	];
	const own = sandboxFolders(place.home);
	const writable = [
		place.cwd,
		own.temporary,
		own.cache,
		...(place.served ? [] : [own.gcloud]),
		"/dev/null",
		"/dev/full",
		"/dev/zero",
		"/dev/shm",
		...(place.builders?.writable ?? []),
	];
	const sockets = [
		"/run/nscd/socket",
		...(place.runtimeDir ? [join(place.runtimeDir, NIX_DOOR)] : []),
		...(place.builders?.agent ? [place.builders.agent] : []),
	];
	return { runnable, readable, writable, sockets };
}

/**
 * `place` without the builders' paths, for what pi's own tools reach:
 * only a command sends work to the builders.
 */
function withoutBuilders(place: SandboxPlace): SandboxPlace {
	const { builders: _builders, ...rest } = place;
	return rest;
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
		...(place.builders?.agent
			? [["--env", `SSH_AUTH_SOCK=${place.builders.agent}`] as Rule]
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
	const { runnable, readable, writable } = strictPaths(withoutBuilders(place));
	const ours = (path: string) => path !== "/proc" && !path.startsWith("/dev/");
	const written = writable.filter(ours);
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
	const { runnable, readable } = strictPaths(withoutBuilders(place));
	const inHome = (path: string) =>
		path === place.home || path.startsWith(`${place.home}/`);
	return [...runnable, ...readable, place.cwd].filter(inHome);
}
