/**
 * The agent fence: every command an agent runs kept off the person's
 * desktop, so nothing it runs can reach what they see, type or unlock.
 *
 * Within one account every check a desktop daemon could make is forged
 * by a process running as the person: the uid a socket reports, the
 * binary a pid runs, the cgroup it sits in, a pipe another process holds
 * (`/proc/<pid>/fd/N` opens it). niri hands every client a virtual
 * keyboard, the clipboard and the screen. So the fence doesn't ask the
 * daemons to tell agents apart; it keeps agents from reaching them. Set
 * `PI_SANDBOX=fence` and each command runs in bubblewrap, around
 * Landlock through landrun, with:
 *
 * - **No other process:** a pid namespace of its own and a `/proc` to
 *   match, so no other process's files, memory or open pipes.
 * - **No desktop:** the runtime folder is an empty one of its own, with
 *   only the Nix daemon's door for sandboxes bound back in. The display,
 *   niri, the shell's ipc, the session bus, sound, the keyring, the
 *   password and clipboard daemons and kitty's socket are named in
 *   `NEVER_THROUGH`, and Landlock refuses any socket it wasn't told of,
 *   abstract ones and signals outside too, so one elsewhere isn't
 *   reachable either.
 * - **No startup files:** the settings and startup files that run code
 *   as the person later (`READ_ONLY`) are read-only, from this command
 *   and from pi's own file tools (`sandbox-files.ts`).
 * - **No new privileges:** bubblewrap and Landlock both set
 *   NoNewPrivs, so a setgid wrapper such as 1Password's `op` gains
 *   nothing, and 1Password refuses it.
 *
 * Everything else is as it was: the home folder, the work, the network
 * and the environment, less what names the desktop. The strict profile
 * is for text a stranger wrote; the fence is for every session.
 */

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { quoted, SANDBOXED_COMMAND } from "./sandbox-shell.ts";

/** The value of `PI_SANDBOX` that asks for the fence. */
export const FENCE = "fence";

/**
 * What in the runtime folder a fenced command may reach: the Nix
 * daemon's door for sandboxes, which takes its caller as untrusted.
 */
const LET_THROUGH = ["nix-untrusted.sock"] as const;

/** Sockets outside the runtime folder a fenced command may reach. */
const SOCKETS_ELSEWHERE = ["/run/nscd/socket"] as const;

/**
 * What must never be reachable inside, as paths from the runtime folder
 * (a trailing `*` for any name it begins) or absolute. Each is checked
 * live; the fence lets through only `LET_THROUGH`, so these are the
 * names a change to it must keep out.
 */
export const NEVER_THROUGH = [
	"wayland-*",
	"niri.*",
	"quickshell",
	"quickshell-launcher",
	"launcher.sock",
	"passwords.sock",
	"op-daemon.sock",
	"1Password-BrowserSupport.sock",
	"onepassword",
	"clipboard-history.sock",
	"clipboard-history",
	"bus",
	"/run/dbus/system_bus_socket",
	"pipewire-*",
	"pulse",
	"keyring",
	"gnupg",
	"ssh-tpm-agent.sock",
	"agent-signing.sock",
	"github-broker.sock",
	"gcloud-broker",
] as const;

/**
 * The person's files that run code as them later, or say what does,
 * read-only inside: the shell's startup files, every program's settings
 * (systemd's units and quickshell's code among them), git's and npm's,
 * SSH's, what is on their path (their own bin, the Nix profile, dev's
 * toolchain), the launcher's entries, direnv's allow list, pi's own
 * settings and packages, and the skills and settings every agent loads.
 *
 * The home folder itself is read-only too, with every other entry in
 * it bound back writable, since a dotfile is often a link into the
 * store: one a command could delete, and put a file of its own in its
 * place, if it could write the folder holding it.
 */
export const READ_ONLY = [
	".config",
	".zshrc",
	".zshenv",
	".zprofile",
	".zlogin",
	".profile",
	".bashrc",
	".bash_profile",
	".gitconfig",
	".npmrc",
	".ssh",
	".agents",
	".claude",
	".claude-personal",
	".claude.json",
	".codex",
	".local/bin",
	".local/share/applications",
	".local/share/direnv/allow",
	".local/share/systemd",
	".local/share/pi-packages",
	".local/state/nix",
	".local/state/tec/toolchain",
	".pi/agent",
] as const;

/** What the fence needs to know of the disk: what a path is, and what a folder holds. */
export interface Disk {
	kind(path: string): "folder" | "file" | "link" | undefined;
	entries(folder: string): readonly string[];
}

/** The disk as it is. */
const DISK: Disk = {
	kind(path) {
		try {
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) return "link";
			return stat.isDirectory() ? "folder" : "file";
		} catch {
			// Not there, so nothing to bind.
			return undefined;
		}
	},
	entries(folder) {
		try {
			return readdirSync(folder);
		} catch {
			// No folder to read, so nothing in it to bind.
			return [];
		}
	},
};

/**
 * Variables that name the desktop, left out so a command fails at once
 * rather than looking for a socket it can't reach.
 */
const UNSET = [
	"WAYLAND_DISPLAY",
	"DISPLAY",
	"XAUTHORITY",
	"DBUS_SESSION_BUS_ADDRESS",
	"SSH_AUTH_SOCK",
	"NIRI_SOCKET",
	"SWAYSOCK",
	"KITTY_LISTEN_ON",
	"KITTY_WINDOW_ID",
	"NIX_REMOTE",
] as const;

/** Where a fenced command runs. */
export interface FencePlace {
	readonly home: string;
	/** `XDG_RUNTIME_DIR`, which the fence empties. */
	readonly runtimeDir: string | undefined;
	/** The working folder, when it is a worktree, for its `.git` file. */
	readonly cwd?: string;
	/** The worktree's own folder in its repository's `worktrees`. */
	readonly ownGitFolder?: string;
}

/** The read-only paths, for the home folder `home`. */
export function readOnlyPaths(home: string): string[] {
	return READ_ONLY.map((path) => join(home, path));
}

/**
 * bubblewrap's arguments for the home folder: itself read-only, every
 * entry but the read-only ones bound back writable, then each read-only
 * path deeper down bound read-only over its writable parent. A link
 * can't be bound over, so an entry that is one stays as the read-only
 * home folder holds it, and a deeper read-only path that is one makes
 * its folder read-only instead.
 */
function homeArgs(home: string, disk: Disk): string[] {
	if (disk.kind(home) !== "folder") return [];
	const top = new Set<string>(READ_ONLY.filter((path) => !path.includes("/")));
	const args = ["--ro-bind", home, home];
	for (const entry of [...disk.entries(home)].sort()) {
		const path = join(home, entry);
		const kind = disk.kind(path);
		if (top.has(entry) || kind === "link" || kind === undefined) continue;
		args.push("--bind", path, path);
	}
	for (const deeper of READ_ONLY.filter((path) => path.includes("/"))) {
		const path = join(home, deeper);
		const kind = disk.kind(path);
		if (kind === undefined) continue;
		const kept = kind === "link" ? dirname(path) : path;
		args.push("--ro-bind", kept, kept);
	}
	return args;
}

/**
 * bubblewrap's arguments for the fence. A path that isn't on this
 * machine is left out, since bubblewrap refuses to bind one, and
 * nothing inside could make it.
 */
export function fenceArgs(place: FencePlace, disk: Disk = DISK): string[] {
	const exists = (path: string) => disk.kind(path) !== undefined;
	// A /dev of its own, with only what any program needs (null, zero,
	// random, a tty): the TPM, the camera, the microphone and the
	// security keys are devices the person's account opens.
	const args = [
		"--die-with-parent",
		"--new-session",
		"--unshare-pid",
		"--bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--tmpfs",
		"/dev/shm",
		"--proc",
		"/proc",
	];
	if (place.runtimeDir) {
		args.push("--perms", "0700", "--tmpfs", place.runtimeDir);
		for (const name of LET_THROUGH) {
			const path = join(place.runtimeDir, name);
			if (exists(path)) args.push("--bind", path, path);
		}
	}
	// The system bus and X's sockets live outside the runtime folder.
	for (const folder of ["/run/dbus", "/tmp/.X11-unix"]) {
		if (exists(folder)) args.push("--tmpfs", folder);
	}
	return [
		...args,
		...homeArgs(place.home, disk),
		...sshArgs(place.home, disk),
		...gitArgs(place, disk),
	];
}

/** The files in `~/.ssh` a command may read: public keys, settings and known hosts. */
const SSH_KEPT =
	/^(config|known_hosts(\.old)?|google_compute_known_hosts(\.old)?|.*\.pub)$/;

/**
 * bubblewrap's arguments for `~/.ssh`: emptied, with only what names
 * hosts and keys bound back read-only, so no private key or TPM key
 * handle can be read.
 */
function sshArgs(home: string, disk: Disk): string[] {
	const ssh = join(home, ".ssh");
	if (disk.kind(ssh) !== "folder") return [];
	const args = ["--tmpfs", ssh];
	for (const entry of [...disk.entries(ssh)].sort()) {
		const path = join(ssh, entry);
		if (SSH_KEPT.test(entry) && disk.kind(path) === "file") {
			args.push("--ro-bind", path, path);
		}
	}
	return [...args, "--remount-ro", ssh];
}

/**
 * What in a git folder makes git run code, read-only: its settings, a
 * worktree's own, its hooks and `info` (attributes naming filters).
 * Objects, refs and the index stay writable, so commits still work.
 */
const GIT_CODE = ["config", "config.worktree", "hooks", "info"] as const;

/** Folders whose entries may be repositories: the home folder, and its `src` and `world`. */
const REPOSITORY_HOMES = ["", "src", "world"] as const;

/** The git folders in the home folder's repositories, working and bare. */
function gitFolders(home: string, disk: Disk): string[] {
	const found = new Set<string>();
	for (const where of REPOSITORY_HOMES) {
		const folder = join(home, where);
		for (const entry of disk.entries(folder)) {
			const path = join(folder, entry);
			if (disk.kind(join(path, ".git")) === "folder") {
				found.add(join(path, ".git"));
			} else if (
				disk.kind(join(path, "HEAD")) === "file" &&
				disk.kind(join(path, "objects")) === "folder"
			) {
				found.add(path);
			}
		}
	}
	return [...found].sort();
}

/**
 * bubblewrap's arguments for git: what runs code in each repository's
 * git folder read-only, since git runs outside the fence there (the
 * person, pi's work tool). Where a repository's worktrees keep settings
 * of their own (World's sparse trees), its whole `worktrees` folder is
 * read-only, one mount rather than hundreds, and the session's own is
 * bound back writable. The session's own tree has its `.git` file and
 * its worktree folder's settings and links read-only, so it can't be
 * pointed at a git folder of a command's making.
 */
function gitArgs(place: FencePlace, disk: Disk): string[] {
	const there = (path: string) => {
		const kind = disk.kind(path);
		return kind === "file" || kind === "folder";
	};
	const bound = (flag: string, paths: readonly string[]) =>
		paths.filter(there).flatMap((path) => [flag, path, path]);
	const kept: string[] = [];
	for (const git of gitFolders(place.home, disk)) {
		for (const name of GIT_CODE) kept.push(join(git, name));
		const worktrees = join(git, "worktrees");
		const settled = disk
			.entries(worktrees)
			.some((tree) => there(join(worktrees, tree, "config.worktree")));
		if (settled) kept.push(worktrees);
	}
	const own = place.cwd ? place.ownGitFolder : undefined;
	const ownBack =
		own && kept.some((path) => own.startsWith(`${path}/`)) ? [own] : [];
	const ownKept =
		own && place.cwd
			? [
					join(place.cwd, ".git"),
					join(own, "commondir"),
					join(own, "gitdir"),
					join(own, "config.worktree"),
				]
			: [];
	return [
		...bound("--ro-bind", kept),
		...bound("--bind", ownBack),
		...bound("--ro-bind", ownKept),
	];
}

/** landrun's arguments for the fence: every path, and only the listed sockets. */
export function fenceRules(place: FencePlace): string[] {
	const sockets = [
		...SOCKETS_ELSEWHERE,
		...(place.runtimeDir
			? LET_THROUGH.map((name) => join(place.runtimeDir as string, name))
			: []),
	];
	return [
		"--rwx",
		"/",
		...sockets.flatMap((path) => ["--unix", path]),
		"--unrestricted-network",
		"--ignore-missing",
	];
}

/** The fence's door to Nix, for `NIX_REMOTE` inside. */
export function nixDoor(runtimeDir: string | undefined): string | undefined {
	return runtimeDir ? `unix://${join(runtimeDir, LET_THROUGH[0])}` : undefined;
}

/**
 * Whether an absolute path lies where the fence keeps pi's own file
 * tools from writing: a read-only path, the runtime folder, or the home
 * folder itself, where only an entry already there and bound back
 * writable may be written.
 */
export function fenceRefusesWrite(
	path: string,
	place: FencePlace,
	disk: Disk = DISK,
): boolean {
	const kept = [
		...readOnlyPaths(place.home),
		...(place.runtimeDir ? [place.runtimeDir] : []),
	];
	if (kept.some((folder) => path === folder || path.startsWith(`${folder}/`))) {
		return true;
	}
	if (path === place.home) return true;
	if (dirname(path) !== place.home) return false;
	const kind = disk.kind(path);
	return kind === undefined || kind === "link";
}

/**
 * Whether a path, already resolved, lies where the fence keeps pi's own
 * file tools from reading: another process's files in `/proc`, or the
 * runtime folder, which holds the clipboard's pictures and the
 * desktop's sockets.
 */
export function fenceRefusesRead(path: string, place: FencePlace): boolean {
	// pi's own /proc/self resolves to its pid, so it is refused too: its
	// open files are pipes and sockets no fenced command could reach.
	if (/^\/proc\/(\d+|thread-self)(\/|$)/.test(path)) return true;
	const runtime = place.runtimeDir;
	return (
		runtime !== undefined &&
		(path === runtime || path.startsWith(`${runtime}/`))
	);
}

/**
 * The shell text that runs `command` in the agent fence: bubblewrap
 * with `args`, around landrun with `rules`. Every variable the shell
 * exports goes in but those naming the desktop, and Nix is reached
 * through `door`, its daemon's door for sandboxes.
 */
export function fencedCommand(
	command: string,
	fence: {
		readonly bwrap: string;
		readonly landrun: string;
		readonly args: readonly string[];
		readonly rules: readonly string[];
		readonly door?: string;
	},
): string {
	const unset = [...UNSET, SANDBOXED_COMMAND].join("|");
	const stub = `eval "unset ${SANDBOXED_COMMAND}; $${SANDBOXED_COMMAND}"`;
	return [
		`__pi_env=(); for __pi_name in $(compgen -e); do case $__pi_name in ${unset}) ;; *) __pi_env+=(--env "$__pi_name");; esac; done`,
		[
			`${SANDBOXED_COMMAND}=${quoted(command)}`,
			quoted(fence.bwrap),
			...fence.args.map(quoted),
			"--",
			quoted(fence.landrun),
			...fence.rules.map(quoted),
			`"\${__pi_env[@]}" --env ${SANDBOXED_COMMAND}`,
			...(fence.door ? [`--env ${quoted(`NIX_REMOTE=${fence.door}`)}`] : []),
			`-- bash -c ${quoted(stub)}`,
		].join(" "),
	].join("\n");
}

/**
 * nix-offload, run outside the fence until the SSH agent's proxy lets
 * the fence reach the builders: the store's own binary, and the store's
 * `env` to start it with an environment of its own.
 */
export interface Offload {
	readonly program: string;
	readonly env: string;
}

/**
 * The day the nix-offload exemption is due out: the SSH agent's proxy
 * (the fence's fourth piece) lets the fence reach the builders by then,
 * and a test fails from this day while the exemption is still here.
 */
export const OFFLOAD_EXEMPTION_ENDS = "2026-11-13";

/** A `nix-offload there` call alone, its arguments plain words. */
const OFFLOAD_CALL =
	/^nix-offload[ \t]+there(?:[ \t]+[A-Za-z0-9_./=:@%+,-]+)*$/;

/** The only folders on the exemption's `PATH`: the system's own programs. */
function systemPath(user: string | undefined): string {
	const own =
		user && /^[a-z_][a-z0-9_-]*$/.test(user)
			? [`/etc/profiles/per-user/${user}/bin`]
			: [];
	return [...own, "/run/current-system/sw/bin"].join(":");
}

/**
 * The shell text that runs a `nix-offload there` call outside the fence,
 * or nothing for any other command, which stays fenced. Only a call
 * alone, of plain words, is let out: anything chained on, quoted,
 * substituted or expanded stays in. It runs the store's binary by its
 * path with the call's own words, in an environment of its own: the
 * home and runtime folders, the account's name, the system's `PATH`,
 * and nothing from the shell that asked.
 */
export function offloadedOutside(
	command: string,
	offload: Offload | undefined,
	place: { home: string; env: NodeJS.ProcessEnv },
): string | undefined {
	const call = command.trim();
	if (!offload || !OFFLOAD_CALL.test(call)) return undefined;
	const words = call.split(/[ \t]+/).slice(1);
	const user = place.env.USER;
	const environment = [
		`HOME=${place.home}`,
		`PATH=${systemPath(user)}`,
		...(user ? [`USER=${user}`, `LOGNAME=${user}`] : []),
		...(place.env.XDG_RUNTIME_DIR
			? [`XDG_RUNTIME_DIR=${place.env.XDG_RUNTIME_DIR}`]
			: []),
	];
	// Named env, since the store's may be coreutils' one binary for every
	// program, which acts by the name it is started with.
	return [
		"exec -a env",
		quoted(offload.env),
		"-i",
		...environment.map(quoted),
		quoted(offload.program),
		...words.map(quoted),
	].join(" ");
}

/** A program's own path in the Nix store, through every link, or nothing. */
export function inStore(path: string | undefined): string | undefined {
	if (!path) return undefined;
	let own: string;
	try {
		own = realpathSync(path);
	} catch {
		// Not there, so not the store's.
		return undefined;
	}
	return own.startsWith("/nix/store/") ? own : undefined;
}
