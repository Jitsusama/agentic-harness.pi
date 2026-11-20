/**
 * The agent fence on macOS: a sandbox-exec profile that keeps the
 * promises bubblewrap keeps on Linux (fence.ts), read from the same
 * mounts, so one list says what a fenced command may write and see on
 * both systems.
 *
 * sandbox-exec is Apple's own signed program, so nothing new is
 * installed and Santa judges every program a command starts, as
 * before. A profile holds for the command and everything it starts,
 * and nothing inside lifts it. Its rules are read in order and the
 * last that matches wins, as a later mount covers an earlier one, so
 * each mount becomes a rule or two in the order bubblewrap takes them
 * (tried on a Mac on 16 November). Beyond files, which stay as they
 * are but for the mounts, the Mac's own secrets (`MAC_HIDDEN`), what
 * runs later as the person (`MAC_READ_ONLY`, `MAC_PROGRAMS` and the
 * folders on `PATH`) and their preferences:
 *
 * - **Mach services only by name** (`MACH_ALLOWED`): LaunchServices
 *   (`open -a Terminal`), Apple Events (`osascript`) and launchd
 *   (`launchctl submit`) each run a command outside any profile, so a
 *   list of what to refuse would miss the next one (ISXEG8, 16
 *   November). The list grows from the refusals the unified log names.
 * - **Its own processes only:** no signal to, or reading of, a process
 *   outside its sandbox, as Linux's pid namespace keeps.
 * - **The sockets and local ports it is given:** every other unix
 *   socket and every port on this machine refused, as Landlock refuses
 *   on Linux.
 */

import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { quoted } from "../sandbox/sandbox-shell.ts";

/** Where macOS keeps sandbox-exec, the one program trusted to run it. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * The mach services a command-line program needs: names, users and
 * groups (opendirectoryd), the network's settings and DNS, trust in a
 * certificate, notifications, logging, preferences and file events.
 * Never LaunchServices, Apple Events, launchd's job submission, the
 * pasteboard, the window server or the keychain.
 */
export const MACH_ALLOWED = [
	"com.apple.system.opendirectoryd.libinfo",
	"com.apple.system.opendirectoryd.membership",
	"com.apple.system.DirectoryService.libinfo_v1",
	"com.apple.SystemConfiguration.configd",
	"com.apple.SystemConfiguration.DNSConfiguration",
	"com.apple.dnssd.service",
	"com.apple.networkd",
	"com.apple.trustd",
	"com.apple.trustd.agent",
	"com.apple.ocspd",
	"com.apple.system.notification_center",
	"com.apple.logd",
	"com.apple.diagnosticd",
	"com.apple.system.logger",
	"com.apple.cfprefsd.daemon",
	"com.apple.cfprefsd.agent",
	"com.apple.FSEvents",
] as const;

/**
 * The Mac's own secrets in the home folder, beyond Linux's hidden list:
 * the keychains, 1Password's group container, browsers' profiles and
 * cookies, Mail and Messages, and gh's and op's settings. A terminal
 * may hold Full Disk Access, which a command it runs inherits, so
 * macOS's own privacy prompts are no guard (ISXEG8, 16 November).
 */
export const MAC_HIDDEN = [
	"Library/Keychains",
	"Library/Group Containers/2BUA8C4S2C.com.1password",
	"Library/Application Support/1Password",
	"Library/Application Support/Google/Chrome",
	"Library/Application Support/Firefox",
	"Library/Application Support/BraveSoftware",
	"Library/Safari",
	"Library/Cookies",
	"Library/Mail",
	"Library/Messages",
	".config/gh",
	".config/op",
	// Every realm's messages, steers and sessions, which a run's output
	// would carry to whoever asked it (ISXEG8, 16 November).
	".local/state/pi",
	".pi/agent",
	".local/state/mycelium",
] as const;

/**
 * What in the home folder runs later as the person, kept from writes
 * beyond Linux's read-only list: launchd's agents, which start at the
 * next login unfenced, preferences, login items, services, scripts,
 * apps' containers and the person's own apps (ISXEG8, 16 November).
 */
export const MAC_READ_ONLY = [
	"Library/LaunchAgents",
	"Library/Preferences",
	"Library/Application Support/com.apple.backgroundtaskmanagementagent",
	"Library/Services",
	"Library/Scripts",
	"Library/Application Scripts",
	"Library/Containers",
	"Library/Group Containers",
	"Applications",
] as const;

/**
 * Where the person's programs live outside the home folder, which an
 * admin can write on a Mac, unlike Linux's read-only store: Homebrew's,
 * the system's local one and the apps.
 */
export const MAC_PROGRAMS = [
	"/opt/homebrew",
	"/usr/local",
	"/Applications",
] as const;

/**
 * The system's own sockets every command needs: mDNSResponder's, which
 * answers each name lookup, so with none no host resolves (tried on a
 * Mac on 16 November).
 */
export const MAC_SOCKETS = ["/var/run/mDNSResponder"] as const;

/** A copy bound over a file, which the command reads in its place. */
export interface StoodIn {
	readonly copy: string;
	readonly over: string;
}

/** The profile, and the copies it can't bind, which a caller points the command at. */
export interface Seatbelt {
	readonly profile: string;
	readonly stoodIn: readonly StoodIn[];
}

/** What the profile lets through beyond its mounts. */
export interface SeatbeltReach {
	/**
	 * The unix sockets a command may connect to beyond `MAC_SOCKETS`:
	 * Nix's, the SSH agent's proxy's, the doors. Each is named past its
	 * links, since a rule on a link matches nothing.
	 */
	readonly sockets: readonly string[];
	/** The ports on this machine a command may connect to, none when left out. */
	readonly ports?: readonly number[];
	/** The home folder, whose `MAC_HIDDEN` the profile hides and `MAC_READ_ONLY` keeps. */
	readonly home?: string;
	/** The folders on `PATH`, kept from writes but those within `folder`. */
	readonly path?: readonly string[];
	/** Where the command works and writes, whose own programs it may write. */
	readonly folder?: string;
	/** A path as the kernel names it, past its links (`/tmp` is `/private/tmp`). */
	readonly real?: (path: string) => string;
	/**
	 * Trees granted again after every hide, a broker's tree inside pi's
	 * state: each read whole, written only where its kind writes (the whole
	 * tree for fence, the folder for strict), with the fence's own rules
	 * inside it laid again after, and the folders above it named, so a
	 * program can find its way down.
	 */
	readonly regranted?: readonly Regrant[];
	/**
	 * Paths outside the home whose rules must hold however the folders
	 * above them are named: the temporary folder's code caches
	 * (fence-temp-caches.ts). A Mac's own temporary folder is the
	 * person's, so a command could otherwise rename it and leave a link in
	 * its place, past every rule that names the caches in it.
	 */
	readonly heldFromRoot?: readonly string[];
}

/** A tree granted again after every hide, and the folder in it a command writes. */
export interface Regrant {
	readonly tree: string;
	readonly writes: string;
}

/** bubblewrap's options that say nothing of files on a Mac, with how many values each takes. */
const UNSAID: Readonly<Record<string, number>> = {
	"--die-with-parent": 0,
	"--new-session": 0,
	"--unshare-pid": 0,
	"--dev": 1,
	"--proc": 1,
	"--perms": 1,
	"--dev-bind": 2,
};

/**
 * The sandbox-exec profile for a fenced command with bubblewrap's
 * `args`: allow by default, mach services only by name, its own
 * processes, `reach`'s sockets and ports, then each mount as a rule in
 * its order and the Mac's secrets last. A mount it can't say refuses
 * the whole, rather than leaving a path open.
 *
 * Every hide is laid again after the last mount, with what a hidden
 * folder lets back read-only (ssh's settings and known hosts), so no
 * grant can reopen one: the last rule wins, and a writable folder laid
 * after the hides once read ~/.ssh's keys (04TNWT, 16 November).
 */
export function seatbeltProfile(
	args: readonly string[],
	reach: SeatbeltReach,
): Seatbelt {
	const real = reach.real ?? realPath;
	const path = (raw: string) => quotedPath(real(raw));
	const mounts: string[] = [];
	const stoodIn: StoodIn[] = [];
	// Each hide's rule, and each read-only path with its rules, to lay
	// again once the mounts are done.
	const hides: string[] = [];
	// Every rule that closes something, with its path, to lay again inside
	// a folder granted after it.
	const closing: { to: string; rule: string }[] = [];
	const close = (to: string, rule: string) => {
		mounts.push(rule);
		closing.push({ to, rule });
	};
	const hiddenFolders: { to: string; at: number }[] = [];
	const readOnly: { to: string; rules: string[]; at: number }[] = [];
	for (let at = 0; at < args.length; ) {
		const option = args[at] ?? "";
		const values = (count: number): string[] => {
			const taken = args.slice(at + 1, at + 1 + count);
			if (taken.length < count) {
				throw new Error(
					`${option} wants ${count} paths, the fence gave ${taken.length}`,
				);
			}
			at += 1 + count;
			return taken;
		};
		const unsaid = UNSAID[option];
		if (unsaid !== undefined) {
			values(unsaid);
			continue;
		}
		switch (option) {
			case "--bind":
			case "--ro-bind":
			case "--ro-bind-try": {
				const [from = "", to = ""] = values(2);
				const writable = option === "--bind";
				if (from === "/" && to === "/") break;
				if (from === "/dev/null" || from !== to) {
					if (from !== "/dev/null") stoodIn.push({ copy: from, over: to });
					const hide = `(deny file-read* file-write* (literal ${path(to)}))`;
					close(to, hide);
					hides.push(hide);
				} else if (writable) {
					mounts.push(`(allow file-read* file-write* (subpath ${path(to)}))`);
				} else {
					const rules = [
						`(allow file-read* (subpath ${path(to)}))`,
						`(deny file-write* (subpath ${path(to)}))`,
					];
					readOnly.push({ to, rules, at: mounts.length });
					mounts.push(rules[0] ?? "");
					close(to, rules[1] ?? "");
				}
				break;
			}
			case "--overlay-src": {
				// A folder whose writes go to a tmpfs of the fence's own
				// (fence-temp-caches.ts). Seatbelt has no overlay, so it is
				// read-only here: a write fails rather than reaching outside.
				const [from = "", over = "", to = ""] = values(3);
				if (over !== "--tmp-overlay" || from !== to) {
					throw new Error(
						`the Mac's fence can't say bubblewrap's ${option} ${over}`,
					);
				}
				const rules = [
					`(allow file-read* (subpath ${path(to)}))`,
					`(deny file-write* (subpath ${path(to)}))`,
				];
				readOnly.push({ to, rules, at: mounts.length });
				mounts.push(rules[0] ?? "");
				close(to, rules[1] ?? "");
				break;
			}
			case "--tmpfs": {
				const [to = ""] = values(1);
				const hide = `(deny file-read* file-write* (subpath ${path(to)}))`;
				hiddenFolders.push({ to, at: mounts.length });
				close(to, hide);
				hides.push(hide);
				break;
			}
			case "--remount-ro": {
				const [to = ""] = values(1);
				close(to, `(deny file-write* (subpath ${path(to)}))`);
				break;
			}
			default:
				throw new Error(`the Mac's fence can't say bubblewrap's ${option}`);
		}
	}
	const home = reach.home;
	const hidden = home
		? MAC_HIDDEN.map(
				(secret) =>
					`(deny file-read* file-write* (subpath ${path(join(home, secret))}))`,
			)
		: [];
	const within = (entry: string, folder: string | undefined) =>
		folder !== undefined &&
		(entry === folder || entry.startsWith(`${folder}/`));
	// Only what was let back after its folder was hidden, as bubblewrap
	// would have it: a mount laid before the hide stays hidden.
	const keptInHidden = readOnly
		.filter((kept) =>
			hiddenFolders.some(
				(hidden) => kept.at > hidden.at && within(kept.to, hidden.to),
			),
		)
		.flatMap(({ rules }) => rules);
	const programFolders = [
		...(home ? MAC_READ_ONLY.map((kept) => join(home, kept)) : []),
		...MAC_PROGRAMS,
		...(reach.path ?? []).filter(
			(entry) => entry.startsWith("/") && !within(entry, reach.folder),
		),
	];
	const programs = programFolders.map(
		(kept) => `(deny file-write* (subpath ${path(kept)}))`,
	);
	const profile = [
		"(version 1)",
		"(allow default)",
		"(deny mach-lookup)",
		`(allow mach-lookup (global-name ${MACH_ALLOWED.map((name) => `"${name}"`).join(" ")}))`,
		// A second wall behind mach-lookup's: no Apple Event reaches an app,
		// which could act as the person (Finder, Terminal, System Events).
		"(deny appleevent-send)",
		"(deny process-info* (target others))",
		"(allow process-info* (target same-sandbox))",
		"(deny signal (target others))",
		"(allow signal (target same-sandbox))",
		"(deny network-outbound (remote unix-socket))",
		...[...MAC_SOCKETS, ...reach.sockets].map(
			(socket) =>
				`(allow network-outbound (remote unix-socket (path-literal ${path(socket)})))`,
		),
		'(deny network-outbound (remote ip "localhost:*"))',
		...(reach.ports ?? []).map(
			(port) => `(allow network-outbound (remote ip "localhost:${port}"))`,
		),
		// No quote mark, so the shell quotes the profile in one piece.
		";; Mounts, in the order bubblewrap takes them, last wins.",
		...mounts,
		";; Every hide again, so no mount laid after it reopens one.",
		...hides,
		// And each held cache kept from writes again, so a strict run whose
		// folder holds one, a temporary folder, can't write it.
		...readOnly
			.filter(({ to }) => (reach.heldFromRoot ?? []).includes(to))
			.flatMap(({ rules }) => rules),
		...keptInHidden,
		...hidden,
		...(reach.regranted ?? []).flatMap(({ tree, writes }) => [
			...wayDown(tree, home).map(
				(folder) => `(allow file-read-metadata (literal ${path(folder)}))`,
			),
			`(allow file-read* (subpath ${path(tree)}))`,
			`(allow file-write* (subpath ${path(writes)}))`,
			...closing
				.filter(({ to }) => within(to, tree) && to !== tree)
				.map(({ rule }) => rule),
		]),
		// A rule names a path, not what lies there, so a folder holding a
		// closed one moved aside would carry it out from under its rule:
		// none of them may be renamed or removed.
		...[
			...new Set(
				[
					...closing.map(({ to }) => to),
					...(home ? MAC_HIDDEN.map((secret) => join(home, secret)) : []),
					// Nor one holding a program, swapped for a folder planting one.
					...programFolders,
				]
					.flatMap((to) => above(to, home))
					// Nor any folder between the root and a held cache, which a
					// rename would carry out from under its read-only rule.
					.concat((reach.heldFromRoot ?? []).flatMap((to) => between("/", to))),
			),
		]
			// As named too, so a folder that is a link can't be removed and
			// one planted in its place.
			.flatMap((folder) => [...new Set([quotedPath(folder), path(folder)])])
			.map((folder) => `(deny file-write-unlink (literal ${folder}))`),
		...[...new Set(programs)],
		// What cfprefsd writes for a command, past every file rule:
		// `defaults write com.apple.Terminal` would set a startup command.
		"(deny user-preference-write)",
	].join("\n");
	return { profile, stoodIn };
}

/**
 * The folders between `home` and `tree`, nearest the home first: those
 * that, moved, would take it along; none for a tree outside the home.
 */
function above(tree: string, home: string | undefined): string[] {
	if (!home || !tree.startsWith(`${home}/`)) return [];
	return between(home, tree);
}

/**
 * The folders a program steps through finding its way down to a held
 * tree: from the home, or from the root for a tree whose real path left
 * the home through a linked folder on the way.
 */
function wayDown(tree: string, home: string | undefined): string[] {
	return between(home && tree.startsWith(`${home}/`) ? home : "/", tree);
}

/** The folders strictly between `from` and `to`, nearest `from` first. */
function between(from: string, to: string): string[] {
	const steps = to.slice(from.length).split("/").filter(Boolean).slice(0, -1);
	return steps.map((_, at) => join(from, ...steps.slice(0, at + 1)));
}

/** The status pi-fence exits with when it refuses, as a shell's for a command it can't run. */
const REFUSED = 126;

/**
 * The shell text that runs `command` under `profile` with
 * `sandboxExec`, given inline so nothing inside can reach or change it.
 * The profile is first tried on `true`, and one that doesn't apply
 * exits 126 saying so, so nothing runs unfenced because the profile
 * failed (ISXEG8, 16 November). The SSH agent's socket goes unnamed,
 * since a Mac has no proxy that signs only for named hosts.
 */
export function seatbeltText(
	command: string,
	profile: string,
	sandboxExec: string = SANDBOX_EXEC,
): string {
	const run = (words: string) =>
		`${quoted(sandboxExec)} -p ${quoted(profile)} ${words}`;
	return [
		"unset SSH_AUTH_SOCK",
		`${run("/usr/bin/true")} || { echo "pi-fence: sandbox-exec didn't apply the fence's profile, so nothing runs" >&2; exit ${REFUSED}; }`,
		`exec ${run(`/bin/bash -c ${quoted(command)}`)}`,
	].join("\n");
}

/**
 * `path` as the kernel names it: its links followed, or, for one not
 * there yet, its folder's, since a rule on `/tmp/x` never matches what
 * the kernel calls `/private/tmp/x`.
 */
function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// Not there yet: its folder names where it will be.
		const folder = dirname(path);
		return folder === path
			? path
			: join(realPath(folder), path.slice(folder.length + 1));
	}
}

/** `path` as a profile's string, so no name can close it early. */
function quotedPath(path: string): string {
	return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
