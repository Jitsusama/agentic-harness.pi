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
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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

/**
 * Folders that may hold repositories, and how many levels down: the
 * home folder's own entries, `src` as deep as `src/github.com/org/repo`
 * and a level more, and `world`.
 */
const REPOSITORY_HOMES = [
	{ where: "", depth: 1 },
	{ where: "src", depth: 4 },
	{ where: "world", depth: 1 },
] as const;

/** A repository's git folder, working or bare, or nothing when `path` holds none. */
function gitFolderOf(path: string, disk: Disk): string | undefined {
	if (disk.kind(join(path, ".git")) === "folder") return join(path, ".git");
	const bare =
		disk.kind(join(path, "HEAD")) === "file" &&
		disk.kind(join(path, "objects")) === "folder";
	return bare ? path : undefined;
}

/**
 * The git folders in the home folder's repositories, working and bare.
 * A walk stops at a repository, and below the top goes only into plain
 * folders, never a hidden one or a link.
 */
export function gitFolders(home: string, disk: Disk = DISK): string[] {
	const found = new Set<string>();
	const walk = (folder: string, depth: number) => {
		for (const entry of disk.entries(folder)) {
			const path = join(folder, entry);
			const git = gitFolderOf(path, disk);
			if (git) found.add(git);
			else if (
				depth > 1 &&
				!entry.startsWith(".") &&
				disk.kind(path) === "folder" &&
				disk.kind(join(path, ".git")) === undefined
			) {
				walk(path, depth - 1);
			}
		}
	};
	for (const { where, depth } of REPOSITORY_HOMES)
		walk(join(home, where), depth);
	return [...found].sort();
}

/**
 * Whether `git` is a git folder `gitFolders` finds, without walking
 * every repository: what pi asks before it runs git outside the fence,
 * once a call, so it follows the walk's rules rather than its listing.
 */
export function guardsGitFolder(
	git: string,
	home: string,
	disk: Disk = DISK,
): boolean {
	const working = basename(git) === ".git" && disk.kind(git) === "folder";
	const repository = working ? dirname(git) : git;
	if (gitFolderOf(repository, disk) !== git) return false;
	return REPOSITORY_HOMES.some(({ where, depth }) => {
		const top = join(home, where);
		const parts = relative(top, repository).split(sep);
		const first = parts[0] ?? "";
		if (first === "" || first === ".." || parts.length > depth) return false;
		let folder = top;
		return parts.slice(0, -1).every((entry) => {
			folder = join(folder, entry);
			return (
				!entry.startsWith(".") &&
				disk.kind(folder) === "folder" &&
				disk.kind(join(folder, ".git")) === undefined
			);
		});
	});
}

/**
 * bubblewrap's arguments for git: what runs code in each repository's
 * git folder read-only, since git runs outside the fence there (the
 * person, pi's work tool). A repository's whole `worktrees` folder is
 * read-only too, one mount rather than hundreds, so no command changes
 * another tree's settings or makes a git folder of its own in there for
 * a tree to be pointed at; the session's own is bound back writable,
 * with its settings and links still read-only, and so is its tree's
 * `.git` file.
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
		kept.push(join(git, "worktrees"));
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

/** A word with no meaning to a shell: no quote, expansion, glob or redirect. */
const PLAIN_WORD = /^[A-Za-z0-9._/@:=+^*-]+$/;

/** A `nix-offload there` call alone, its arguments plain words. */
const OFFLOAD_CALL =
	/^nix-offload[ \t]+there(?:[ \t]+[A-Za-z0-9._/@:=+^*-]+)*$/;

/** One `cd` into a folder, then the call: the form changed-checks needs. */
const CD_CALL = /^cd[ \t]+(\S+)[ \t]*&&[ \t]*(nix-offload[ \t].*)$/;

/**
 * Flags that build, wait or keep running on this machine rather than a
 * builder, which the exemption never lets out: what runs here should run
 * fenced, as any other command here does. `--out` copies a build's files
 * into any folder it names, which outside the fence would write where a
 * fenced command can't, such as `~/.config/systemd/user`.
 */
const LOCAL_FLAGS = [
	"--here",
	"--here-when-idle",
	"--outlive",
	"--out",
] as const;

/**
 * A git folder no account can make, given as `GIT_DIR` to a call outside
 * any held tree, so no git it runs reads a `.git` a fenced command wrote.
 */
export const NO_GIT_DIR = "/var/empty/no-git";

/** What the work tool vouches for in a held tree: it and its git folder. */
export interface HeldGit {
	readonly folder: string;
	readonly gitDir: string;
}

/** Whether `word` names a path in the Nix store, through every link. */
function storeWord(word: string): boolean {
	return (
		word.startsWith("/nix/store/") &&
		!word.split("/").includes("..") &&
		inStore(word) !== undefined
	);
}

/**
 * Whether a call's arguments may run outside the fence: none of the flags
 * that work here, and a `--run` only when everything it copies and the
 * command it runs are the store's, which a fenced command can't change.
 * The builder runs a `--run` as an account its Nix doesn't trust.
 */
function letOut(words: readonly string[]): boolean {
	const here = (word: string) =>
		LOCAL_FLAGS.some((flag) => word === flag || word.startsWith(`${flag}=`));
	if (words.some(here)) return false;
	if (!words.includes("--run")) return true;
	const end = words.indexOf("--");
	if (end === -1) return false;
	const options = words.slice(0, end);
	if (options.some((word) => word.startsWith("--copy="))) return false;
	for (const [at, word] of options.entries()) {
		if (word !== "--copy") continue;
		const copied = options[at + 1];
		if (copied === undefined || !storeWord(copied)) return false;
	}
	const command = words[end + 1];
	return command !== undefined && storeWord(command);
}

/** The only folders on the exemption's `PATH`: the system's own programs. */
function systemPath(user: string | undefined): string {
	const own =
		user && /^[a-z_][a-z0-9_-]*$/.test(user)
			? [`/etc/profiles/per-user/${user}/bin`]
			: [];
	return [...own, "/run/current-system/sw/bin"].join(":");
}

/** Where an exempt call runs, and how a `cd` folder is vouched for. */
export interface OffloadPlace {
	readonly home: string;
	readonly env: NodeJS.ProcessEnv;
	/**
	 * The folder as it really is, when it is a tree the work tool holds
	 * for this session, named without a link, whose git links check out;
	 * nothing otherwise, and nothing when it isn't given.
	 */
	readonly heldTree?: (folder: string) => HeldGit | undefined;
	/** The folder the command runs in, where a bare call runs. */
	readonly cwd?: string;
	/**
	 * The folder as it really is, with its git folder, when it is a tree
	 * the session holds or a checkout whose git folder the fence keeps
	 * read-only; nothing otherwise.
	 */
	readonly folderGit?: (folder: string) => HeldGit | undefined;
}

/**
 * The shell text that runs a `nix-offload there` call outside the fence,
 * or nothing for any other command, which stays fenced. Only a call
 * alone, of plain words, is let out, or one `cd` into a tree the session
 * holds before it, which changed-checks needs, since it finds its
 * repository from the folder it runs in: anything else chained on,
 * quoted, substituted or expanded stays in, and so does a call with a
 * flag that works on this machine, or a `--run` of anything but the
 * store's (`letOut`). It runs the store's binary by its path with the
 * call's own words, in an environment of its own: the home and runtime
 * folders, the account's name, the system's `PATH`, and nothing from
 * the shell that asked.
 *
 * The checks hold only as they run, while nix-offload and changed-checks
 * run git for minutes after, and a fenced command could point the tree's
 * `.git` at a git folder it made, whose config names a program to run.
 * So git is told where to look and never reads `.git` again: the held
 * tree's own git folder, which the fence keeps read-only. A bare call
 * runs in the command's own folder, and `--run` always sends the commit
 * there, so that folder is held the same way when it is a held tree or
 * a checkout the fence guards. In any other folder git is given one that
 * can't exist, so a flake named by a path, or a `--run`, fails rather
 * than read a `.git` a command wrote. `core.fsmonitor` is off either way.
 */
export function offloadedOutside(
	command: string,
	offload: Offload | undefined,
	place: OffloadPlace,
): string | undefined {
	if (!offload) return undefined;
	let call = command.trim();
	let held: HeldGit | undefined;
	const cd = CD_CALL.exec(call);
	if (cd) {
		const [, named = "", rest = ""] = cd;
		if (!(PLAIN_WORD.test(named) && named.startsWith("/"))) return undefined;
		held = place.heldTree?.(named);
		if (held === undefined) return undefined;
		call = rest.trim();
	} else if (place.cwd !== undefined) {
		held = place.folderGit?.(place.cwd);
	}
	if (!OFFLOAD_CALL.test(call)) return undefined;
	const words = call.split(/[ \t]+/).slice(1);
	if (!letOut(words.slice(1))) return undefined;
	const user = place.env.USER;
	const environment = [
		`HOME=${place.home}`,
		`PATH=${systemPath(user)}`,
		...(user ? [`USER=${user}`, `LOGNAME=${user}`] : []),
		...(place.env.XDG_RUNTIME_DIR
			? [`XDG_RUNTIME_DIR=${place.env.XDG_RUNTIME_DIR}`]
			: []),
		...(held
			? [`GIT_DIR=${held.gitDir}`, `GIT_WORK_TREE=${held.folder}`]
			: [`GIT_DIR=${NO_GIT_DIR}`, "GIT_CEILING_DIRECTORIES=/"]),
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0=core.fsmonitor",
		"GIT_CONFIG_VALUE_0=false",
	];
	// Named env, since the store's may be coreutils' one binary for every
	// program, which acts by the name it is started with.
	return [
		...(held ? ["cd", quoted(held.folder), "&&"] : []),
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
	// Resolved first, so a `..` can't climb out of the store by name.
	let own = resolve(path);
	try {
		own = realpathSync(own);
	} catch {
		// Not there to follow: judged by its name, since nothing runs from it.
	}
	return own.startsWith("/nix/store/") ? own : undefined;
}
