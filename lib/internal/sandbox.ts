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
 *   in, since a session's environment holds tokens too. The one
 *   exception is GitHub's: where the machine's github-broker gives one,
 *   a command gets a token, an hour long, that can read code and write
 *   pull requests and issues, and nothing more, as `GH_TOKEN` and git's
 *   helper for github.com. The broker's socket stays out of reach, so a
 *   command can't mint one of its own. Where the machine names a cloud
 *   account for its agents, gcloud is handed that account's hour token
 *   and its one project, from gcloud-broker, and a settings folder of
 *   its own for the session, never the person's cloud login.
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
 * `sandbox-files.ts` holds them to the same paths for the
 * `sandbox-file-interceptor` extension, less `/proc` and the devices.
 *
 * `PI_SANDBOX=fence` asks for the agent fence instead (`fence.ts`):
 * every session's commands kept off the person's desktop, with the
 * work, the network and the environment as they were.
 */

import { mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import {
	agentProxy,
	FENCE,
	fenceArgs,
	fenceRules,
	guardsGitFolder,
	nixDoor,
} from "./fence.ts";
import { fencedCommand } from "./fence-command.ts";
import {
	afterCheck,
	guardedIn,
	plantStopped,
	sharedRootFor,
} from "./fence-git-root.ts";
import { githubDoorFolder } from "./fence-github.ts";
import { foldersMadeFirst, OWN_HOMES } from "./fence-home.ts";
import { recordedInShell } from "./fence-log.ts";
import { fenceNpmrc } from "./fence-npmrc.ts";
import { seedOwnHomes } from "./fence-seed.ts";
import { fenceSshConfig } from "./fence-ssh.ts";
import {
	type CloudGrant,
	type CloudGrantSource,
	cloudGrants,
	namesTheCloud,
} from "./gcloud-broker.ts";
import { brokerTokens, type GitHubTokenSource } from "./github-broker.ts";
import {
	inStore,
	type Offload,
	offloadedOutside,
	offloadKeptIn,
	takesLentOnly,
} from "./offload-exemption.ts";
import { questWorkspacesRoot } from "./quest/workspace-root.ts";
import { quoted, SANDBOXED_COMMAND } from "./sandbox-shell.ts";
import {
	brokerTrees,
	folderGit,
	heldTree,
	worktreeFolder,
} from "./sandbox-trees.ts";
import { systemProgram } from "./system-program.ts";
import { type GitRules, real, within, worktreeRepository } from "./tree-git.ts";
import { cutTreeDir } from "./work-records.ts";

/** The variable that asks for the sandbox, and the strict profile's value. */
export const SANDBOX_VARIABLE = "PI_SANDBOX";
export const STRICT = "strict";

/**
 * What git that pi runs outside the sandbox holds to for this session
 * (`tree-git.ts`): a repository the fence guards, when its commands run
 * fenced or sandboxed, since they could have set what git runs anywhere
 * else.
 */
export function gitRules(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): GitRules {
	const asked = env[SANDBOX_VARIABLE]?.trim();
	return {
		home: real(home),
		fenced: asked === FENCE || asked === STRICT,
		trees: cutTreeDir(),
	};
}

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
		own.gcloud,
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

/**
 * The shell text that runs `command` under landrun with `rules`.
 *
 * landrun passes only the variables it is told to, so the shell names
 * each one it exports that `KEPT` allows, as it stands once the queue has
 * had its say, less those withheld and any whose name `NEVER` matches. The command travels in a variable, as it does through
 * the shell, so `pkill -f` matches only what it names (see
 * `command-line.ts`), and it is unset before it runs. Each of `passed`
 * travels the same way, set for landrun alone and named to it, so a
 * token handed in shows on no command line.
 */
export function sandboxedCommand(
	command: string,
	rules: readonly Rule[],
	landrun: string,
	passed: Readonly<Record<string, string>> = {},
): string {
	const refused = [...WITHHELD, ...NEVER].join("|");
	const kept = KEPT.join("|");
	const flags = rules.map(([flag, value]) => `${flag} ${quoted(value)}`);
	const stub = `eval "unset ${SANDBOXED_COMMAND}; $${SANDBOXED_COMMAND}"`;
	const handed = Object.entries(passed).filter(([name]) =>
		/^[A-Z_][A-Z0-9_]*$/.test(name),
	);
	return [
		`__pi_env=(); for __pi_name in $(compgen -e); do case $__pi_name in ${refused}) ;; ${kept}) __pi_env+=(--env "$__pi_name");; esac; done`,
		[
			`${SANDBOXED_COMMAND}=${quoted(command)}`,
			...handed.map(([name, value]) => `${name}=${quoted(value)}`),
			quoted(landrun),
			...flags,
			"--unrestricted-network --ignore-missing",
			...handed.map(([name]) => `--env ${name}`),
			`"\${__pi_env[@]}" --env ${SANDBOXED_COMMAND}`,
			`-- bash -c ${quoted(stub)}`,
		].join(" "),
	].join("\n");
}

/** The shell text that refuses to run a command, saying why. */
export function refusedCommand(reason: string): string {
	return `printf '%s\\n' ${quoted(reason)} >&2; exit 126`;
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
 * Where quests' scratch folders live, and the one `temporary` (a
 * session's `TMPDIR`, a link into its quest's) lies in, if it does.
 */
export function questScratch(
	temporary: string | undefined,
	root: string = questWorkspacesRoot(),
): { root: string; own?: string } {
	const top = real(root);
	const at = temporary ? relative(top, real(temporary)) : "..";
	const first = at.split(sep)[0] ?? "";
	const outside = first === "" || first === ".." || isAbsolute(at);
	return outside ? { root: top } : { root: top, own: join(top, first) };
}

/**
 * How a session's commands run: as they are, fenced, or not at all. A
 * fenced command is handed a GitHub token from `github`, and a cloud
 * token and project from `gcloud`, when they give them.
 */
export type Sandbox =
	| { readonly kind: "none" }
	| (Logged & {
			readonly kind: "strict";
			readonly landrun: string;
			readonly github?: GitHubTokenSource;
			readonly gcloud?: CloudGrantSource;
	  })
	| (Logged & {
			readonly kind: "fence";
			readonly bwrap: string;
			readonly landrun: string;
			readonly offload?: Offload;
			/** The GitHub door's program, where the machine runs the door. */
			readonly githubDoor?: string;
	  })
	| (Logged & { readonly kind: "refused"; readonly reason: string });

/**
 * What a sandbox writes its refusals to the system's log with
 * (`fence-log.ts`): the system's own `logger`, or none, when the
 * refusal says the log didn't take it.
 */
interface Logged {
	readonly logger?: string;
}

/** The broker's tokens, asked for once every few minutes for the session. */
const sessionTokens = brokerTokens();

/** The cloud broker's tokens, asked for in the background from the first fenced command. */
const sessionGrants = cloudGrants();

/** A session's name as a folder may take it, or the process's where there is none. */
function sessionFolderName(env: NodeJS.ProcessEnv): string {
	const session = env.PI_SESSION_ID ?? "";
	return /^[A-Za-z0-9-]{1,64}$/.test(session) ? session : `pid-${process.pid}`;
}

/** The settings folders this process has made fresh, so each is emptied once. */
const freshSettings = new Set<string>();

/**
 * What a fenced command is told for gcloud, given `grant`: the session's
 * own settings folder always, and the token and project when there is a
 * grant. gcloud reads a token from its environment before any login, so a
 * command acts as the account the broker minted for. Without one, the
 * empty folder makes gcloud say it has no credentialed account, where the
 * person's own folder, which the fence refuses, made it die calling its
 * install corrupt. The folder is emptied the first time a process hands
 * it on, so a session resumed starts from no settings an earlier command,
 * or a stranger's text, left there.
 */
export function cloudVariables(
	grant: CloudGrant | undefined,
	home: string,
	env: NodeJS.ProcessEnv,
): Record<string, string> {
	const settings = join(sandboxFolders(home).gcloud, sessionFolderName(env));
	if (!freshSettings.has(settings)) {
		rmSync(settings, { recursive: true, force: true });
		freshSettings.add(settings);
	}
	mkdirSync(settings, { recursive: true, mode: 0o700 });
	if (!grant || "reason" in grant) return { CLOUDSDK_CONFIG: settings };
	return {
		CLOUDSDK_AUTH_ACCESS_TOKEN: grant.token,
		CLOUDSDK_CORE_PROJECT: grant.project,
		CLOUDSDK_CONFIG: settings,
	};
}

/**
 * Starts a fenced session's broker minting its first cloud token now,
 * rather than at its first command, so the commands a first turn runs
 * side by side don't all meet a token still on its way.
 */
export function askTheCloudAhead(sandbox: Sandbox): void {
	if (sandbox.kind === "strict") sandbox.gcloud?.();
}

/**
 * `command`, preceded by a note on stderr saying why gcloud has no token
 * when it names the cloud's programs and `grant` gives none, so the agent
 * reads the reason beside gcloud's own complaint.
 */
export function withCloudNote(
	command: string,
	grant: CloudGrant | undefined,
): string {
	if (!grant || !("reason" in grant) || !namesTheCloud(command)) return command;
	return `printf 'pi: gcloud has no token in the sandbox: %s\\n' ${quoted(grant.reason)} >&2\n${command}`;
}

/**
 * What git is told in a command handed a GitHub token: for github.com, no
 * helper but one answering with the token, so git fetches the App's
 * private repositories (and pushes nowhere, which the App can't). The
 * empty helper drops those the person's settings name,
 * which run outside the sandbox's reach and would fail or prompt.
 */
const TOKEN_HELPER = `!f() { test "$1" = get || return 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f`;

/** The rules telling git, through its environment, to use `TOKEN_HELPER`. */
export function githubRules(): Rule[] {
	const key = "credential.https://github.com.helper";
	return [
		["--env", "GIT_CONFIG_COUNT=2"],
		["--env", `GIT_CONFIG_KEY_0=${key}`],
		["--env", "GIT_CONFIG_VALUE_0="],
		["--env", `GIT_CONFIG_KEY_1=${key}`],
		["--env", `GIT_CONFIG_VALUE_1=${TOKEN_HELPER}`],
	];
}

/** Why a sandbox that isn't there is refused, for what it would fence. */
export function noSuchSandbox(asked: string, what: string): string {
	return `${SANDBOX_VARIABLE}=${asked} names no sandbox; the ones there are are "${FENCE}" and "${STRICT}". No ${what} runs until it is set right or unset.`;
}

/** What the agent fence needs of this machine, or why it can't be had. */
function fenceFor(
	platform: NodeJS.Platform,
	find: (program: string) => string | undefined,
): Sandbox {
	if (platform !== "linux") {
		return {
			kind: "refused",
			reason: `${SANDBOX_VARIABLE}=${FENCE} asks for bubblewrap and Landlock, which only Linux has, so no command runs unfenced here.`,
		};
	}
	const bwrap = find("bwrap");
	const landrun = find("landrun");
	if (!bwrap || !landrun) {
		const missing = [bwrap ? [] : "bwrap", landrun ? [] : "landrun"].flat();
		return {
			kind: "refused",
			reason: `${SANDBOX_VARIABLE}=${FENCE} needs bwrap and landrun, but ${missing.join(" and ")} isn't in the system's own profile, where only root puts programs, so no command runs unfenced.`,
		};
	}
	const program = inStore(find("nix-offload"));
	const env = inStore(find("env"));
	const githubDoor = find("pi-github-door");
	return {
		kind: "fence",
		bwrap,
		landrun,
		...(githubDoor ? { githubDoor } : {}),
		...(program && env
			? { offload: { program, env, lentOnly: takesLentOnly(program) } }
			: {}),
	};
}

/** What the session asked for, and whether this machine can give it. */
export function sandboxFor(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	// Never PATH: a fenced command can write to folders on it (system-program.ts).
	find: (program: string) => string | undefined = systemProgram,
	github: GitHubTokenSource = sessionTokens,
	gcloud: CloudGrantSource = sessionGrants,
): Sandbox {
	const asked = env[SANDBOX_VARIABLE]?.trim();
	if (!asked) return { kind: "none" };
	const logger = find("logger");
	const sandbox = askedFor(asked, platform, find, github, gcloud);
	return logger && sandbox.kind !== "none" ? { ...sandbox, logger } : sandbox;
}

/** The sandbox `asked` names, and whether this machine can give it. */
function askedFor(
	asked: string,
	platform: NodeJS.Platform,
	find: (program: string) => string | undefined,
	github: GitHubTokenSource,
	gcloud: CloudGrantSource,
): Sandbox {
	if (asked === FENCE) return fenceFor(platform, find);
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
			reason: `${SANDBOX_VARIABLE}=${STRICT} asks for a sandbox, but landrun isn't in the system's own profile, where only root puts programs, so no command runs unfenced.`,
		};
	}
	return { kind: "strict", landrun, github, gcloud };
}

/**
 * Makes each folder the fence keeps within a home entry, where that
 * entry is there: the deeper read-only paths and the caches within
 * read-only entries, which nothing inside could make.
 */
function makeFoldersFirst(home: string): void {
	for (const path of foldersMadeFirst(home)) {
		const entry = join(home, relative(home, path).split(sep)[0] ?? "");
		if (!statSync(entry, { throwIfNoEntry: false })?.isDirectory()) continue;
		try {
			mkdirSync(path, { recursive: true, mode: 0o700 });
		} catch {
			// A folder that can't be made is left unbound: a cache's program
			// fails to write it inside as it would have anyway, and pi's file
			// tools still refuse a read-only path that isn't there.
		}
	}
}

/**
 * The wrap a sandbox puts around each command, for the place it runs in,
 * or nothing when the session runs commands as they are. A command it
 * refuses leaves a line in the system's log first (`fence-log.ts`),
 * naming the session but never the command.
 */
export function wrapFor(
	sandbox: Sandbox,
	place: { cwd: string; env: NodeJS.ProcessEnv },
	home: string,
): ((command: string) => string) | undefined {
	const refused = (reason: string) =>
		`${recordedInShell(
			{
				kind: "program",
				tool: "bash",
				sandbox: place.env[SANDBOX_VARIABLE],
				session: place.env.PI_SESSION_ID,
			},
			sandbox.kind === "none" ? undefined : sandbox.logger,
		)}; ${refusedCommand(reason)}`;
	switch (sandbox.kind) {
		case "none":
			return undefined;
		case "refused":
			return () => refused(sandbox.reason);
		case "fence": {
			const session = place.env.PI_SESSION_ID;
			const stopped = plantStopped(session);
			if (stopped) return () => refused(stopped);
			const ownGitFolder = worktreeFolder(place.cwd);
			const sharedRoot = sharedRootFor(ownGitFolder, session, (root) =>
				guardsGitFolder(root, real(home)),
			);
			// Only where the machine runs the door and the session's id can
			// name its folder; elsewhere gh inside fails as it always did.
			const githubFolder = sandbox.githubDoor
				? githubDoorFolder(place.env.XDG_RUNTIME_DIR, session)
				: undefined;
			const github =
				sandbox.githubDoor && session && githubFolder
					? { program: sandbox.githubDoor, session, folder: githubFolder }
					: undefined;
			const fence = {
				home,
				runtimeDir: place.env.XDG_RUNTIME_DIR,
				...(githubFolder ? { githubDoor: githubFolder } : {}),
				cwd: place.cwd,
				ownGitFolder,
				sharedRoot,
				scratch: questScratch(place.env.TMPDIR),
				sshConfig: fenceSshConfig(place.env.XDG_RUNTIME_DIR),
				npmrc: fenceNpmrc(home, place.env.XDG_RUNTIME_DIR),
				trees: brokerTrees(session),
			};
			makeFoldersFirst(home);
			const own = sandboxFolders(home).cache;
			// Never waited on: a command started first finds what the own
			// homes held already.
			void seedOwnHomes(home, own);
			const made = {
				bwrap: sandbox.bwrap,
				landrun: sandbox.landrun,
				args: fenceArgs(fence),
				rules: fenceRules(fence),
				door: nixDoor(fence.runtimeDir),
				agent: agentProxy(fence.runtimeDir),
				homes: OWN_HOMES.map(
					([name, folder]) => [name, join(own, folder)] as const,
				),
				...(github ? { github } : {}),
			};
			return (command) => {
				const out = offloadedOutside(command, sandbox.offload, {
					home,
					env: place.env,
					heldTree: (folder) => heldTree(folder, home, place.env.PI_SESSION_ID),
					cwd: place.cwd,
					folderGit: (folder) =>
						folderGit(folder, home, place.env.PI_SESSION_ID),
				});
				if (out !== undefined) return out;
				const keptIn = sandbox.offload ? offloadKeptIn(command) : undefined;
				if (keptIn !== undefined) return refused(keptIn);
				const guarded = guardedIn(
					sharedRoot && ownGitFolder ? [sharedRoot, ownGitFolder] : [],
				);
				const planted = recordedInShell(
					{ kind: "plant", tool: "git", sandbox: FENCE, session },
					sandbox.logger,
				);
				return [fencedCommand(command, made), afterCheck(guarded, planted)]
					.filter(Boolean)
					.join("\n");
			};
		}
		case "strict": {
			const unfenced = unfencedFolder(place.cwd, home);
			if (unfenced) return () => refused(unfenced);
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
			// gh reads GH_TOKEN, and git asks its helper for it.
			const token = sandbox.github?.();
			const given = token ? [...rules, ...githubRules()] : rules;
			// gcloud reads its token, project and settings folder from these.
			const grant = sandbox.gcloud?.();
			const passed: Record<string, string> = {
				...(token ? { GH_TOKEN: token } : {}),
				...cloudVariables(grant, home, place.env),
			};
			return (command) =>
				sandboxedCommand(
					withCloudNote(command, grant),
					given,
					sandbox.landrun,
					passed,
				);
		}
	}
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
	const { runnable, readable, writable } = strictPaths(place);
	const ours = (path: string) => path !== "/proc" && !path.startsWith("/dev/");
	const written = writable.filter(ours);
	if (use === "write") return written;
	return [...runnable, ...readable.filter(ours), ...written];
}
