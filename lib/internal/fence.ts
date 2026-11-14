/**
 * The agent fence: every command an agent runs kept off the person's
 * desktop, so nothing it runs can reach what they see, type or unlock.
 *
 * Within one account every check a desktop daemon could make is forged
 * by a process running as the person: the uid a socket reports, the
 * binary a pid runs, the cgroup it sits in, a pipe another process holds
 * (`/proc/<pid>/fd/N` opens it). niri hands every client a virtual
 * keyboard, the clipboard and the screen. So the fence doesn't ask the
 * daemons to tell agents apart; it keeps agents from reaching them. With
 * `PI_SANDBOX=fence`, which a session naming none is given on Linux
 * (`fenceByDefault` in sandbox.ts), each command runs in bubblewrap,
 * around Landlock through landrun, with:
 *
 * - **No other process:** a pid namespace of its own and a `/proc` to
 *   match, so no other process's files, memory or open pipes.
 * - **No desktop:** the runtime folder is an empty one of its own, with
 *   only the Nix daemon's door for sandboxes, the SSH agent's proxy,
 *   the jobs broker and the clipboard door bound back in, read-only
 *   (`LET_THROUGH`). The display,
 *   niri, the shell's ipc, the session bus, sound, the keyring, the
 *   password and clipboard daemons and kitty's socket are named in
 *   `NEVER_THROUGH`, and Landlock refuses any socket it wasn't told of,
 *   abstract ones and signals outside too, so one elsewhere isn't
 *   reachable either.
 * - **A clipboard without the desktop:** `wl-copy` and `wl-paste` are
 *   the fence's own, first on `PATH`, which ask the clipboard door
 *   outside (`fence-clipboard.ts`). No window opens: niri would focus
 *   it on the person's workspace, so no display is let through, not
 *   even core's sandboxed one, until niri opens a sandboxed window
 *   unfocused elsewhere.
 * - **No startup files:** the settings and startup files that run code
 *   as the person later (`READ_ONLY`) are read-only, from this command
 *   and from pi's own file tools (`sandbox-files.ts`).
 * - **No repositories of its making:** `~/src` and `~/world`, where the
 *   repositories pi runs git in outside the fence live, are read-only
 *   but for the session's own tree and what a commit writes in each git
 *   folder (`GIT_WRITTEN`), so no command plants a repository, a
 *   setting or a `commondir` there for git outside to run. A worktree's
 *   shared git folder is writable but for what runs code, once a watch
 *   outside removes any `commondir` planted there and stops the session
 *   (`fence-git-root.ts`). The work tool's trees are read-only but
 *   the session's own, their `.git` files aside, and so are the records
 *   of who holds them (`fence-broker-trees.ts`). The folders
 *   the person browses, the home folder's visible entries, are
 *   read-only but the one the session works in, so no command plants a
 *   repository whose settings their prompt's git runs on entering it.
 * - **No registry tokens:** `~/.npmrc` is a copy without its tokens'
 *   lines (`fence-npmrc.ts`), and pi's own file tools are refused it.
 * - **No new privileges:** bubblewrap and Landlock both set
 *   NoNewPrivs, so a setgid wrapper such as 1Password's `op` gains
 *   nothing, and 1Password refuses it.
 *
 * Everything else is as it was: the home folder's hidden entries, where
 * programs keep their caches and state, the work, the network and the
 * environment, less what names the desktop. The strict profile
 * is for text a stranger wrote; the fence is for every session.
 */

import { basename, dirname, join, relative, sep } from "node:path";
import {
	type BrokerTrees,
	brokerTreeArgs,
	brokerTreesRefuseWrite,
} from "./fence-broker-trees.ts";
import { DISK, type Disk } from "./fence-disk.ts";
import { sharedRootArgs } from "./fence-git-root.ts";
import { renderNodeArgs } from "./fence-gpu.ts";
import { FENCE_HIDDEN } from "./fence-hidden.ts";
import {
	cachesWithin,
	READ_ONLY,
	readOnlyEntry,
	readOnlyPaths,
} from "./fence-home.ts";
import { NPMRC } from "./fence-npmrc.ts";

/** The value of `PI_SANDBOX` that asks for the fence. */
export const FENCE = "fence";

/**
 * What in the runtime folder a fenced command may reach: the Nix
 * daemon's door for sandboxes, which takes its caller as untrusted, and
 * the SSH agent's proxy, which signs only logins to the hosts it's told
 * of, each proved by the host's own signature over the session (core's
 * `modules/pi/agent-proxy`), and the jobs broker, which puts only the
 * process asking, as the kernel names it, into a scope of its own in
 * its quest's work, and says how named units stand (core's
 * `modules/jobs-broker`). The broker stands in for the user's bus,
 * which stays shut. And the clipboard door, in a folder of its own,
 * which copies and pastes for the fence's `wl-copy` and `wl-paste`,
 * answers only fenced commands and never reads what a password manager
 * marked secret (core's `modules/pi/clipboard-door`).
 *
 * The proxy's socket lives in a folder of its own, bound whole, so a
 * fenced command started before the proxy's socket comes back (a switch
 * restarts it) still reaches the new one: a socket bound on its own
 * would stay the old, dead one. `pi-agent.sock` beside it is the
 * proxy's old place, now a link into the folder, kept for a machine
 * whose proxy hasn't moved yet.
 */
const LET_THROUGH = [
	"nix-untrusted.sock",
	"pi-agent.sock",
	"pi-agent",
	"daemons/jobs-broker.sock",
	"pi-clipboard",
] as const;

/**
 * The cgroup tree, bound read-only inside: a fenced command may read
 * where it and its machine stand, but never move a process or change a
 * limit. Every move pi makes (its children's work slice, a queue's turn,
 * a World walk's shared slice) happens outside the fence, before the
 * command starts, and a command's own scope goes through the broker.
 */
const CGROUPS = "/sys/fs/cgroup";

/**
 * The SSH agent's proxy, in the runtime folder: in its own folder
 * first, else at its old place.
 */
const AGENT_PROXY = ["pi-agent/agent.sock", "pi-agent.sock"] as const;

/** The jobs broker, in the runtime folder. */
const JOBS_BROKER = "daemons/jobs-broker.sock";

/** Where the system's SSH settings are, which the fence's copy stands in for. */
export const SYSTEM_SSH_CONFIG = "/etc/ssh/ssh_config";

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
	// The sessions kitty's remote control, which reads and types into
	// every session window (core's modules/quickshell/home.nix).
	"pi-sessions*",
	// The keeper of nix-offload's passes: only the exempted call outside
	// the fence records one, so nothing inside can claim a check it ran.
	"/run/nix-offload-keep.sock",
	// nix-offload's door to the standing builders, which builds as the
	// person: a fenced command reaches Nix only untrusted (ISXEG8, 13
	// November, before the person leaves Nix's trusted users).
	"/run/nix-offload-standing.sock",
	// systemd's credential service, which opens what the person's account
	// sealed with `systemd-creds --user`: the login keyring's password and
	// eero's session among them (IDEGAT, 13 November).
	"/run/systemd/io.systemd.Credentials",
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
	/**
	 * The repository git folder that worktree shares, writable inside
	 * once a watch outside guards it (`fence-git-root.ts`).
	 */
	readonly sharedRoot?: string;
	/** Where quests' scratch folders live, and this session's quest's own. */
	readonly scratch?: { readonly root: string; readonly own?: string };
	/**
	 * A copy of the system's SSH settings with the files they include
	 * written in, bound over them (`fence-ssh.ts`): ssh refuses an
	 * included file its owner doesn't match, and root's files show inside
	 * as nobody's.
	 */
	readonly sshConfig?: string;
	/**
	 * A copy of `~/.npmrc` without its tokens' lines, bound over it
	 * (`fence-npmrc.ts`), or `/dev/null` where no copy could be made.
	 */
	readonly npmrc?: string;
	/** The work broker's trees, kept read-only but the session's own (`fence-broker-trees.ts`). */
	readonly trees?: BrokerTrees;
}

/**
 * Whether an entry of the home folder is one the person browses, a
 * visible one, which only the session working in it may write: a
 * repository a command made in `~/Downloads` would run its settings'
 * filters the moment their prompt's git entered it, and
 * `core.fsmonitor=false` stops no filter (ISXEG8, 11 November). Hidden
 * entries hold programs' caches and state, which commands write.
 */
function browsed(entry: string): boolean {
	return !entry.startsWith(".");
}

/**
 * The home folder's browsed entry the session works in, which stays
 * writable, or nothing: none when it works elsewhere, in the home
 * folder itself, or in a repository home the fence keeps read-only,
 * whose own tree `gitArgs` binds back.
 */
function workingEntry(place: FencePlace): string | undefined {
	if (!place.cwd) return undefined;
	const first = relative(place.home, place.cwd).split(sep)[0] ?? "";
	if (first === "" || first === ".." || !browsed(first)) return undefined;
	const kept = REPOSITORY_HOMES.some(
		({ where, kept }) => kept && where === first,
	);
	return kept ? undefined : first;
}

/**
 * bubblewrap's arguments for the home folder: itself read-only, every
 * hidden entry but the read-only ones bound back writable, and the
 * browsed one the session works in, then each read-only path deeper
 * down bound read-only over its writable parent. A link can't be bound
 * over, so an entry that is one stays as the read-only home folder
 * holds it, and a deeper read-only path that is one makes its folder
 * read-only instead.
 */
function homeArgs(place: FencePlace, disk: Disk): string[] {
	const home = place.home;
	if (disk.kind(home) !== "folder") return [];
	const working = workingEntry(place);
	const entries = [...disk.entries(home)].sort();
	const args = ["--ro-bind", home, home];
	for (const entry of entries) {
		const path = join(home, entry);
		const kind = disk.kind(path);
		if (readOnlyEntry(entry) || kind === "link" || kind === undefined) {
			continue;
		}
		if (browsed(entry) && entry !== working) continue;
		args.push("--bind", path, path);
	}
	for (const deeper of READ_ONLY.filter((path) => path.includes("/"))) {
		const path = join(home, deeper);
		const kind = disk.kind(path);
		if (kind === undefined) continue;
		const kept = kind === "link" ? dirname(path) : path;
		args.push("--ro-bind", kept, kept);
	}
	for (const path of cachesWithin(home)) {
		const entry = relative(home, path).split(sep)[0] ?? "";
		if (!entries.includes(entry)) continue;
		const kind = disk.kind(path);
		if (kind === "folder" || kind === "file") args.push("--bind", path, path);
	}
	return args;
}

/**
 * The file the system's SSH settings are in. bubblewrap won't mount on a
 * link, and NixOS makes `/etc/ssh/ssh_config` one into the store, so a
 * link's copy goes over the file it ends at: on 11 November every fenced
 * command failed with "Can't mount on symlink destination".
 */
function systemSshConfig(disk: Disk): string | undefined {
	return disk.kind(SYSTEM_SSH_CONFIG) === "link"
		? disk.real?.(SYSTEM_SSH_CONFIG)
		: SYSTEM_SSH_CONFIG;
}

/**
 * bubblewrap's arguments for the fence. A path that isn't on this
 * machine is left out, since bubblewrap refuses to bind one, and
 * nothing inside could make it.
 */
export function fenceArgs(place: FencePlace, disk: Disk = DISK): string[] {
	const exists = (path: string) => disk.kind(path) !== undefined;
	// A /dev of its own, with only what any program needs (null, zero,
	// random, a tty), and the GPU's render nodes, never its card nodes
	// (fence-gpu.ts): the TPM, the camera, the microphone and the security
	// keys are devices the person's account opens.
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
		...renderNodeArgs(disk),
	];
	if (place.runtimeDir) {
		args.push("--perms", "0700", "--tmpfs", place.runtimeDir);
		// Read-only, which a connect doesn't need written: bound writable,
		// the proxy's folder could be emptied and a command listen in the
		// proxy's place for every other session's signing (JMJ7J4).
		for (const name of LET_THROUGH) {
			const path = join(place.runtimeDir, name);
			if (exists(path)) args.push("--ro-bind", path, path);
		}
	}
	// The system bus and X's sockets live outside the runtime folder.
	for (const folder of ["/run/dbus", "/tmp/.X11-unix"]) {
		if (exists(folder)) args.push("--tmpfs", folder);
	}
	const settings = systemSshConfig(disk);
	if (place.sshConfig && exists(place.sshConfig) && settings !== undefined) {
		args.push("--ro-bind", place.sshConfig, settings);
	}
	return [
		...args,
		...homeArgs(place, disk),
		...brokerTreeArgs(place.trees, place.cwd, disk),
		...sshArgs(place.home, disk),
		...gitArgs(place, disk),
		...scratchArgs(place, disk),
		...hiddenArgs(place.home, disk),
		...npmrcArgs(place, disk),
		...(exists(CGROUPS) ? ["--ro-bind", CGROUPS, CGROUPS] : []),
	];
}

/**
 * Private keys and tokens outside `~/.ssh`, emptied inside, as paths from
 * the home folder, from `data/fence-hidden.json` (`fence-hidden.ts`, which
 * says why each is there).
 */
export const HIDDEN: readonly string[] = FENCE_HIDDEN.home;

/** A hidden path's place in the home folder, and whether it is a folder. */
function hiddenIn(home: string): { path: string; folder: boolean }[] {
	return HIDDEN.map((hidden) => {
		const folder = hidden.endsWith("/");
		// join keeps a trailing slash, which no resolved path has.
		return { path: join(home, folder ? hidden.slice(0, -1) : hidden), folder };
	});
}

/**
 * What the fence keeps from pi's file tools in the home folder, each
 * hidden path and npm's settings, and, where one is a link, the place it
 * leads, since a read is checked once its links are followed.
 */
function refusedIn(
	home: string,
	disk: Disk,
): { path: string; folder: boolean }[] {
	const kept = [...hiddenIn(home), { path: join(home, NPMRC), folder: false }];
	return kept.flatMap((entry) => {
		const real =
			disk.kind(entry.path) === "link" ? disk.real?.(entry.path) : undefined;
		return real === undefined
			? [entry]
			: [entry, { path: real, folder: entry.folder }];
	});
}

/**
 * bubblewrap's arguments binding the copy of `~/.npmrc` without its
 * tokens over it, or over the file it links to, since bubblewrap won't
 * mount on a link.
 */
function npmrcArgs(place: FencePlace, disk: Disk): string[] {
	if (!place.npmrc) return [];
	const path = join(place.home, NPMRC);
	const kind = disk.kind(path);
	const over = kind === "link" ? disk.real?.(path) : path;
	if (kind === undefined || over === undefined) return [];
	return ["--ro-bind", place.npmrc, over];
}

/**
 * bubblewrap's arguments emptying each hidden file and folder that is
 * there: a file bound over with `/dev/null`, a folder with an empty one
 * made read-only. A link's target is emptied instead, since bubblewrap
 * won't mount on a link and the link would still lead to it.
 */
function hiddenArgs(home: string, disk: Disk): string[] {
	return hiddenIn(home).flatMap(({ path, folder }) => {
		const link = disk.kind(path) === "link";
		const over = link ? disk.real?.(path) : path;
		if (over === undefined) return [];
		const kind = disk.kind(over);
		if (folder) {
			return kind === "folder" ? ["--tmpfs", over, "--remount-ro", over] : [];
		}
		return kind === "file" ? ["--ro-bind", "/dev/null", over] : [];
	});
}

/**
 * bubblewrap's arguments for quests' scratch folders: every one
 * read-only, this session's quest's own bound back writable. Other
 * quests keep clones there, whose settings pi's git, and their own
 * sessions', run outside the fence.
 */
function scratchArgs(place: FencePlace, disk: Disk): string[] {
	const scratch = place.scratch;
	if (!scratch || disk.kind(scratch.root) !== "folder") return [];
	const own =
		scratch.own && disk.kind(scratch.own) === "folder"
			? ["--bind", scratch.own, scratch.own]
			: [];
	return ["--ro-bind", scratch.root, scratch.root, ...own];
}

/** The files in `~/.ssh` a command may read: public keys, settings and known hosts. */
const SSH_KEPT = FENCE_HIDDEN.sshKept;

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
 * What a commit in a worktree writes in its repository's git folder,
 * bound back writable in a repository home the fence keeps read-only:
 * the rest of the folder stays read-only, so no command can add a
 * `commondir` that sends git to settings elsewhere, or a submodule's
 * git folder under `modules`.
 */
const GIT_WRITTEN = ["objects", "refs", "logs", "lfs", "rr-cache"] as const;

/**
 * Folders that may hold repositories, and how many levels down: the
 * home folder's own entries, `src` as deep as `src/github.com/org/repo`
 * and a level more, and `world`. `src` and `world` are kept read-only
 * inside, so no command can make a repository there, and only theirs
 * count as guarded: a command can still make a git folder in a hidden
 * entry of the home folder, or the browsed one its session works in,
 * and write its settings before the fence ever guards them.
 */
const REPOSITORY_HOMES = [
	{ where: "", depth: 1, kept: false },
	{ where: "src", depth: 4, kept: true },
	{ where: "world", depth: 1, kept: true },
] as const;

/** The repository homes the fence keeps read-only, that are folders here. */
function keptHomes(home: string, disk: Disk): string[] {
	return REPOSITORY_HOMES.filter(({ kept }) => kept)
		.map(({ where }) => join(home, where))
		.filter((top) => disk.kind(top) === "folder");
}

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
 * Whether `git` is a git folder `gitFolders` finds in a repository home
 * the fence keeps read-only, without walking every repository: what pi
 * asks before it runs git outside the fence, once a call, so it follows
 * the walk's rules rather than its listing.
 */
export function guardsGitFolder(
	git: string,
	home: string,
	disk: Disk = DISK,
): boolean {
	const working = basename(git) === ".git" && disk.kind(git) === "folder";
	const repository = working ? dirname(git) : git;
	if (gitFolderOf(repository, disk) !== git) return false;
	return REPOSITORY_HOMES.some(({ where, depth, kept }) => {
		if (!kept) return false;
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
 * bubblewrap's arguments for git, since git runs outside the fence in
 * each repository (the person, pi's work tool). `src` and `world` are
 * read-only, so no command makes a repository there, and so is each
 * git folder in them but what a commit writes (`GIT_WRITTEN`). In a
 * repository elsewhere, what runs code is read-only (`GIT_CODE`). A
 * repository's whole `worktrees` folder is read-only too, one mount
 * rather than hundreds, so no command changes another tree's settings
 * or makes a git folder of its own in there for a tree to be pointed
 * at. The session's own tree and its git folder are bound back
 * writable, with its settings and links still read-only, and so is its
 * tree's `.git` file.
 */
function gitArgs(place: FencePlace, disk: Disk): string[] {
	const there = (path: string) => {
		const kind = disk.kind(path);
		return kind === "file" || kind === "folder";
	};
	const bound = (flag: string, paths: readonly string[]) =>
		paths.filter(there).flatMap((path) => [flag, path, path]);
	const homes = keptHomes(place.home, disk);
	const inKept = (path: string) =>
		homes.some((top) => path.startsWith(`${top}/`));
	const kept: string[] = [];
	const written: string[] = [];
	const trees: string[] = [];
	for (const git of gitFolders(place.home, disk)) {
		trees.push(join(git, "worktrees"));
		if (inKept(git)) {
			for (const name of GIT_WRITTEN) written.push(join(git, name));
		} else {
			for (const name of GIT_CODE) kept.push(join(git, name));
			kept.push(join(git, "worktrees"));
		}
	}
	const own = place.cwd ? place.ownGitFolder : undefined;
	const ownBack =
		own && trees.some((path) => own.startsWith(`${path}/`)) ? [own] : [];
	const treeBack = own && place.cwd && inKept(place.cwd) ? [place.cwd] : [];
	const ownKept =
		own && place.cwd
			? [
					join(place.cwd, ".git"),
					join(own, "commondir"),
					join(own, "gitdir"),
					join(own, "config.worktree"),
				]
			: [];
	const shared =
		place.sharedRoot && inKept(place.sharedRoot) && there(place.sharedRoot)
			? sharedRootArgs(place.sharedRoot, there)
			: [];
	return [
		...homes.flatMap((top) => ["--ro-bind", top, top]),
		...bound("--bind", written),
		...bound("--ro-bind", kept),
		...shared,
		...bound("--bind", treeBack),
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

/**
 * The SSH agent's proxy, for `SSH_AUTH_SOCK` inside, when it's there;
 * without it no SSH agent is reachable inside at all.
 */
export function agentProxy(
	runtimeDir: string | undefined,
	disk: Disk = DISK,
): string | undefined {
	if (!runtimeDir) return undefined;
	return AGENT_PROXY.map((name) => join(runtimeDir, name)).find(
		(path) => disk.kind(path) !== undefined,
	);
}

/**
 * The jobs broker's socket, when it's there, so a fenced session is told
 * to ask it for what systemctl and systemd-run can't reach inside.
 */
export function jobsBroker(
	runtimeDir: string | undefined,
	disk: Disk = DISK,
): string | undefined {
	if (!runtimeDir) return undefined;
	const path = join(runtimeDir, JOBS_BROKER);
	return disk.kind(path) === undefined ? undefined : path;
}

/** The fence's door to Nix, for `NIX_REMOTE` inside. */
export function nixDoor(runtimeDir: string | undefined): string | undefined {
	return runtimeDir ? `unix://${join(runtimeDir, LET_THROUGH[0])}` : undefined;
}

/**
 * Whether an absolute path lies where the fence keeps pi's own file
 * tools from writing: a read-only path, the runtime folder, another
 * quest's scratch folder, `src` and `world` but the session's own tree
 * there (its `.git` file aside), the work broker's trees and records
 * but the trees the session may write (their `.git` files aside), a
 * browsed entry of the home folder but the one the session works in, or
 * the home folder itself, where only an entry already there and bound
 * back writable may be written.
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
	const inside = (folder: string) =>
		path === folder || path.startsWith(`${folder}/`);
	const caches = cachesWithin(place.home);
	// A tree the broker lets this session write, though pi's state holds it.
	const inTrees = brokerTreesRefuseWrite(path, place.trees, place.cwd, disk);
	if (kept.some(inside) && !caches.some(inside) && inTrees !== false) {
		return true;
	}
	if (dirname(path) === place.home && readOnlyEntry(basename(path))) {
		return true;
	}
	const scratch = place.scratch;
	if (scratch && inside(scratch.root)) {
		return !(scratch.own && inside(scratch.own));
	}
	if (keptHomes(place.home, disk).some(inside)) {
		const tree = place.ownGitFolder ? place.cwd : undefined;
		return !(tree && inside(tree) && path !== join(tree, ".git"));
	}
	if (inTrees !== undefined) return inTrees;
	if (path === place.home) return true;
	const first = relative(place.home, path).split(sep)[0] ?? "";
	const inHome = first !== "" && first !== "..";
	if (inHome && browsed(first) && first !== workingEntry(place)) return true;
	if (dirname(path) !== place.home) return false;
	const kind = disk.kind(path);
	return kind === undefined || kind === "link";
}

/**
 * Whether a path, already resolved, lies where the fence keeps pi's own
 * file tools from reading: another process's files in `/proc`, a hidden
 * key (`HIDDEN`), npm's settings, which hold registry tokens (commands
 * read a copy without them), or where either is a link, the place it
 * leads; or the runtime folder, which holds the clipboard's pictures
 * and the desktop's sockets.
 */
export function fenceRefusesRead(
	path: string,
	place: FencePlace,
	disk: Disk = DISK,
): boolean {
	// pi's own /proc/self resolves to its pid, so it is refused too: its
	// open files are pipes and sockets no fenced command could reach.
	if (/^\/proc\/(\d+|thread-self)(\/|$)/.test(path)) return true;
	const refused = refusedIn(place.home, disk).some(({ path: at, folder }) =>
		folder ? path === at || path.startsWith(`${at}/`) : path === at,
	);
	if (refused) return true;
	const runtime = place.runtimeDir;
	return (
		runtime !== undefined &&
		(path === runtime || path.startsWith(`${runtime}/`))
	);
}
