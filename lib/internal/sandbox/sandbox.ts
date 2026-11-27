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
 *   in, since a session's environment holds tokens too. The one exception
 *   is GitHub's: where the machine's github-broker gives one, a command
 *   gets an hour's token that reads code and writes pull requests and
 *   issues, nothing more, as `GH_TOKEN` and git's helper for github.com;
 *   the broker's socket stays out of reach, so it can't mint its own.
 *   Where the machine names a cloud account for its agents, gcloud gets
 *   that account's hour token and one project, from gcloud-broker, and a
 *   settings folder of its own, never the person's cloud login.
 * - **No sockets but one:** no session or system bus (the way into the
 *   keyring and root), SSH or signing agent, terminal remote control or
 *   abstract socket. Nix answers through its sandboxes' door, which takes
 *   callers as untrusted, since the daemon's own socket hands over root.
 * - **Writes only to the work:** the working folder, and a temporary
 *   folder and cache of its own, as `TMPDIR` and `XDG_CACHE_HOME`. The
 *   person's cache and `/tmp` stay out of reach both ways: they hold
 *   tokens, code their shell runs at each start, and scripts other
 *   sessions run unfenced. No signal reaches a process outside.
 * - **The network,** since fetching is most of what such a session does.
 *
 * Landlock alone does this in 20 to 35 ms a command, with no namespaces,
 * so the person's tools run as they do, and unlike bwrap alone it refuses
 * abstract Unix sockets, which a mount namespace leaves open while the
 * network is shared. Asked for where it can't be had (not Linux, or no
 * landrun), it runs no command rather than one unfenced, save on a Mac
 * whose pi already runs in a sandbox (`offLinux`).
 *
 * A working folder that is or holds the home folder would hand over the
 * person's startup files, and one holding its repository's git folder the
 * hooks and settings git runs outside, so neither runs a command; a
 * worktree keeps its git folder elsewhere. Its repository is readable, so
 * git works, but never writable: a worktree's folder there names the
 * repository and may hold its settings, handing over the person's next git
 * command in that tree. Code written in the work can still run later
 * outside, an `.envrc` once the person allows it: the sandbox narrows what
 * a command reaches now, not what the person later runs from what it wrote.
 *
 * pi's own file tools run in pi's process, outside Landlock, so
 * `sandbox/sandbox-files.ts` holds them to the same paths for the
 * `sandbox-file-interceptor` extension, less `/proc` and the devices.
 *
 * `PI_SANDBOX=fence` asks for the agent fence instead (`fence/fence.ts`):
 * every session's commands kept off the person's desktop, with the
 * work, the network and the environment as they were, and Delta's token
 * from mint, which answers only outside (`delta-token.ts`).
 */

import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import {
	agentProxy,
	FENCE,
	fenceArgs,
	fenceDisplay,
	fenceRules,
	guardsGitFolder,
	nixDoor,
} from "../fence/fence.ts";
import {
	type ArgsFile,
	BWRAP_MOST_ARGS,
	bwrapArgsFile,
	guardedListFile,
} from "../fence/fence-args-file.ts";
import { fenceShims } from "../fence/fence-clipboard.ts";
import {
	bwrapWords,
	fencedCommand,
	isHandedName,
} from "../fence/fence-command.ts";
import { fenceDevCopies, gitGlobalIn } from "../fence/fence-dev.ts";
import { DIRENV_VARIABLE, fencedDirenv } from "../fence/fence-direnv.ts";
import { dockerHoldsCredentials } from "../fence/fence-docker.ts";
import {
	fenceGcloudSsh,
	GCLOUD_KEY,
	hasPublicHalf,
} from "../fence/fence-gcloud-ssh.ts";
import {
	guardedFolders,
	guardedIn,
	plantStopped,
	withAfterCheckIn,
} from "../fence/fence-git-root.ts";
import { githubDoorFolder } from "../fence/fence-github.ts";
import {
	fenceFolders,
	foldersMadeFirst,
	OWN_HOMES,
} from "../fence/fence-home.ts";
import { recordedInShell } from "../fence/fence-log.ts";
import { fenceNpmrc } from "../fence/fence-npmrc.ts";
import { seedOwnHomes } from "../fence/fence-seed.ts";
import { fenceSshConfig } from "../fence/fence-ssh.ts";
import { askedSandbox, inFirstStage } from "../fence/fence-stage.ts";
import { plantedCache, setAsidePlanted } from "../fence/fence-temp-caches.ts";
import {
	fencedWorkerSocket,
	type SocketDisk,
	workerSocketPassed,
} from "../fence/fence-worker-socket.ts";
import {
	inStore,
	type Offload,
	offloadAt,
	offloadedOutside,
	offloadKeptIn,
} from "../fence/offload-exemption.ts";
import { removeTree } from "../files/remove-tree.ts";
import { withSecretNote } from "../secrets/secret-ask.ts";
import { cutTreeDir } from "../work-records.ts";
import {
	type DeltaTokenSource,
	deltaTokens,
	deltaVariables,
} from "./delta-token.ts";
import {
	type CloudGrant,
	type CloudGrantSource,
	cloudGrants,
	namesTheCloud,
} from "./gcloud-broker.ts";
import { brokerTokens, type GitHubTokenSource } from "./github-broker.ts";
import { insideMacSandbox, macSandboxExec } from "./mac-sandbox.ts";
import {
	direnvTrusts,
	makeScratches,
	makeShares,
	questScratch,
} from "./quest-folders.ts";
import { quoted, SANDBOXED_COMMAND } from "./sandbox-shell.ts";
import { folderGit, heldTree, sessionWorktrees } from "./sandbox-trees.ts";
import { type Rule, sandboxFolders, strictRules } from "./strict-rules.ts";
import { notKept, systemProgram } from "./system-program.ts";
import { type GitRules, real, worktreeRepository } from "./tree-git.ts";
import { unfencedFolder } from "./unfenced-folder.ts";

/** The variable that asks for the sandbox, and the strict profile's value. */
export const SANDBOX_VARIABLE = "PI_SANDBOX";
export const STRICT = "strict";
/** The sandboxes there are, and the one a stray value reads as. */
export const SANDBOX_NAMES = { fence: FENCE, known: [FENCE, STRICT] };

/**
 * What git that pi runs outside the sandbox holds to for this session
 * (`tree-git.ts`): a repository the fence guards, when its commands run
 * fenced or sandboxed, since they could have set what git runs elsewhere.
 */
export function gitRules(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): GitRules {
	return {
		home: real(home),
		fenced: askedSandbox(env, SANDBOX_NAMES).name !== undefined,
		trees: cutTreeDir(),
	};
}

/**
 * The longest fenced command text that starts: Linux takes 128 KiB in one
 * string (MAX_ARG_STRLEN), less room for the variable's name pi's shell
 * passes it under, and the lines the machine's queue and the move into
 * jobs put around it after it is wrapped.
 */
const LONGEST_TEXT = 128 * 1024 - 4 * 1024;

/**
 * Why a fenced command's `text` is refused as too long, or nothing when
 * it starts: the fence's lists written into it, when pi's runtime folder
 * couldn't hold them, or else the `command` itself. `listedInline` says
 * whether other lists went in it too, asked only of a text too long.
 * pi-fence's strict fence (`fence-run.ts`) is held to it as well.
 */
export function tooLong(
	text: string,
	command: string,
	args: readonly string[] | ArgsFile,
	listedInline: () => boolean = () => false,
): string | undefined {
	if (Buffer.byteLength(text) <= LONGEST_TEXT) return undefined;
	// Quoted, as it goes into the text, each quote it holds taking four.
	const own = Buffer.byteLength(quoted(command));
	const said = `The fenced command's text is ${Buffer.byteLength(text)} bytes, past the ${LONGEST_TEXT} Linux passes in one string, ${own} of them the command's own`;
	// The lists are blamed only when they, not the command, are most of it.
	return (!("path" in args) || listedInline()) && own < LONGEST_TEXT / 2
		? `${said}, since pi's runtime folder couldn't hold the fence's lists; check that XDG_RUNTIME_DIR names a folder pi can write, and that it isn't full.`
		: `${said}; put it in a script and run that.`;
}

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
	"PI_SSH_GUARD_*",
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

/** Whether `name` holds one of `NEVER`'s words, so no fenced command may keep it. */
export function neverKept(name: string): boolean {
	return NEVER.some((glob) => name.includes(glob.slice(1, -1)));
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
	const handed = Object.entries(passed).filter(([name]) => isHandedName(name));
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

/**
 * Variables a strict command keeps on a Mac beside `KEPT`, where pi's
 * own sandbox, not landrun, decides what it reaches: none is a
 * credential, and a Mac's programs write their scratch where `TMPDIR`
 * says, which that sandbox may let them write when `/tmp` it may not.
 */
const KEPT_ON_A_MAC = [
	"TMPDIR",
	"NIX_REMOTE",
	"XDG_CACHE_HOME",
	"COMMAND_MODE",
	"__CF_USER_TEXT_ENCODING",
] as const;

/**
 * The shell text that runs `command` with only the variables a strict
 * command keeps, where no landrun can pass them: on a Mac, inside the
 * sandbox pi itself runs in. A shell of its own is started with an
 * empty environment and handed only the exported variables `KEPT` or
 * `KEPT_ON_A_MAC` allow and `NEVER` doesn't match, so a session's
 * tokens, agent socket, `BASH_ENV` and exported functions never reach
 * the command's shell, not even where a Mac lets a process of the same
 * user read another's environment as it was started (`ps -E`). pi's own
 * environment can still be read that way, and files the command reaches
 * are still the outer sandbox's to decide. The work happens in a
 * subshell, so what a queue runs after it keeps the session's
 * environment and its variables. The command travels in a variable, as
 * through landrun, and is unset before it runs, so it sits only briefly
 * in what `env` is started with. `env` is named by its path, so an
 * `env` ahead on PATH is never handed the session's environment, and a
 * shell with no `BASH` runs nothing rather than whatever `-c` finds.
 */
export function heldBackCommand(command: string): string {
	const never = NEVER.join("|");
	const kept = [...KEPT, ...KEPT_ON_A_MAC].join("|");
	const inner = `eval "unset ${SANDBOXED_COMMAND}; $${SANDBOXED_COMMAND}"`;
	return [
		"(",
		"__pi_kept=();",
		`for __pi_name in $(compgen -e); do case $__pi_name in ${never}) ;; ${kept}) __pi_kept+=("$__pi_name=\${!__pi_name}");; esac; done;`,
		`exec /usr/bin/env -i "\${__pi_kept[@]}" ${SANDBOXED_COMMAND}=${quoted(command)} "\${BASH:?the strict hold-back needs bash}" -c ${quoted(inner)}`,
		")",
	].join(" ");
}

/** The shell text that refuses to run a command, saying why. */
export function refusedCommand(reason: string): string {
	return `printf '%s\\n' ${quoted(reason)} >&2; exit 126`;
}

/** The one cloud name a fenced command is handed, counted before it is made. */
const CLOUD_COUNTED: Readonly<Record<string, string>> = {
	CLOUDSDK_CONFIG: "",
};

/** Delta's names a fenced command may be handed, counted the same way. */
const DELTA_COUNTED: Readonly<Record<string, string>> = deltaVariables("x");

/**
 * What the agent fence hands a command for gcloud, whatever the session
 * or the machine: no token, only the reason (`NO_CLOUD_IN_THE_FENCE`) and
 * an empty settings folder in the fence's own place (`fenceFolders`),
 * which no strict command can write. The fence's type holds no source to
 * ask, so no caller can hand it a token by mistake.
 */
export function fenceCloud(
	home: string,
	env: NodeJS.ProcessEnv,
): { grant: CloudGrant; passed: Record<string, string> } {
	const grant = NO_CLOUD_IN_THE_FENCE();
	return {
		grant,
		passed: cloudVariables(grant, home, env, fenceFolders(home).gcloud),
	};
}

/**
 * How a session's commands run: as they are, fenced, or not at all. A
 * strict command is handed a GitHub token from `github`, and a cloud
 * token and project from `gcloud`, when they give them; a command in
 * the agent fence only the reason it has none (`NO_CLOUD_IN_THE_FENCE`).
 */
export type Sandbox =
	| {
			readonly kind: "none";
			/** Said once in the session, when a fence it asked for can't be had here. */
			readonly note?: string;
			/**
			 * The fence asked for, where commands run as they are inside the
			 * sandbox pi runs in: what the host's record names, so the node
			 * judges where the session may go by it, beside its process.
			 */
			readonly asked?: "fence" | "strict";
	  }
	| (Logged & {
			readonly kind: "strict";
			readonly landrun: string;
			readonly github?: GitHubTokenSource;
			readonly gcloud?: CloudGrantSource;
			/** Drawn for a language server, with no way to gcloud's settings. */
			readonly served?: boolean;
			/** The disk the node's worker socket is judged on, unless the real one. */
			readonly workerSockets?: SocketDisk;
	  })
	| (Logged & {
			readonly kind: "fence";
			readonly bwrap: string;
			readonly landrun: string;
			readonly offload?: Offload;
			/** The GitHub door's program, where the machine runs the door. */
			readonly githubDoor?: string;
			/** Delta's token, minted outside, for dt and `devx ci`. */
			readonly delta?: DeltaTokenSource;
			/** Said once in the session, when the fence wasn't what it asked. */
			readonly note?: string;
			/** Drawn for a language server, with nothing that acts as the person. */
			readonly served?: boolean;
			/** The disk the node's worker socket is judged on, unless the real one. */
			readonly workerSockets?: SocketDisk;
	  })
	| (Logged & {
			readonly kind: "seatbelt";
			/**
			 * The fence asked for, which a Mac with no sandbox around pi lays
			 * around each command as `pi-fence` would (`fence-mac-command.ts`).
			 */
			readonly asked: "fence" | "strict";
			/** The sandbox-exec that lays it. */
			readonly sandboxExec: string;
			/** Said once in the session, when the fence wasn't what it asked. */
			readonly note?: string;
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

/** Delta's tokens from mint, asked for once a quarter hour for the session. */
const sessionDelta = deltaTokens();

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
 * or a stranger's text, left there. It lies in `parent`: strict's own
 * folder, or the agent fence's, which no strict command can write.
 */
export function cloudVariables(
	grant: CloudGrant | undefined,
	home: string,
	env: NodeJS.ProcessEnv,
	parent: string = sandboxFolders(home).gcloud,
): Record<string, string> {
	const settings = join(parent, sessionFolderName(env));
	if (!freshSettings.has(settings)) {
		removeTree(settings);
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
 * Starts a strict session's broker minting its first cloud token now,
 * rather than at its first command, so the commands a first turn runs
 * side by side don't all meet a token still on its way. The agent fence
 * asks no broker (`NO_CLOUD_IN_THE_FENCE`), so nothing is started for it.
 */
export function askTheCloudAhead(sandbox: Sandbox): void {
	if (sandbox.kind === "strict") sandbox.gcloud?.();
}

/**
 * What the agent fence's gcloud is given: never a token, only why. The
 * agents' account may change the cloud's machines, and a fenced session
 * reads strangers' text, so a token in reach would let that text take
 * over a machine. The fence keeps its own empty settings folder, so
 * gcloud says it has no credentialed account rather than calling its
 * install corrupt, until an account that only reads is named for it.
 */
export const NO_CLOUD_IN_THE_FENCE: CloudGrantSource = () => ({
	reason:
		"the agent fence hands no command the agents' cloud account, which can change machines; run it from an unfenced session",
});

/**
 * `command`, preceded by a note on stderr when it runs gcloud's ssh or
 * scp and the session's copies of gcloud's ssh files couldn't be made,
 * so the agent reads why `gcloud compute ssh` fails on `~/.ssh` beside
 * gcloud's own complaint, rather than taking the fence for one that never
 * made them. gsutil, bq and gcloud's other commands never write there, so
 * they aren't told. `unmade` says why, or nothing where they were made;
 * `asked` is the command as the agent asked it, read for gcloud's ssh,
 * since `text` may already carry other notes that name gcloud.
 */
export function withGcloudSshNote(
	text: string,
	unmade: string | undefined,
	asked: string = text,
): string {
	if (unmade === undefined || !runsGcloudSsh(asked)) return text;
	return `printf 'pi: %s\\n' ${quoted(gcloudSshUnmade(unmade))} >&2\n${text}`;
}

/** Whether a command names gcloud and its ssh or scp, which write `~/.ssh`. */
function runsGcloudSsh(command: string): boolean {
	return (
		/(^|[^\w.-])gcloud($|[^\w.-])/.test(command) &&
		/(^|[^\w.-])(ssh|scp)($|[^\w.-])/.test(command)
	);
}

/** What the note says when gcloud's ssh can't work in this session, for `why`. */
export function gcloudSshUnmade(why: string): string {
	return `gcloud's ssh can't work in this session (fence-gcloud-ssh.ts): ${why}. So gcloud compute ssh fails on the read-only ~/.ssh here; mend that, or run it from an unfenced session`;
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

/** What the agent fence needs of this machine, or why it can't be had. */
function fenceFor(
	platform: NodeJS.Platform,
	find: (program: string) => string | undefined,
	inside: () => boolean,
	seatbelt: () => string | undefined,
	delta: DeltaTokenSource,
): Sandbox {
	if (platform !== "linux") {
		return offLinux(
			"fence",
			"bubblewrap and Landlock",
			platform,
			inside,
			seatbelt,
		);
	}
	const bwrap = find("bwrap");
	const landrun = find("landrun");
	if (!bwrap || !landrun) {
		const missing = [bwrap ? [] : "bwrap", landrun ? [] : "landrun"].flat();
		return {
			kind: "refused",
			reason: `${SANDBOX_VARIABLE}=${FENCE} needs bwrap and landrun, but ${notKept(missing.join(" and "))}, so no command runs unfenced.`,
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
		...(program && env ? { offload: offloadAt(program, env) } : {}),
		delta,
	};
}

/**
 * The sandbox this pi's commands run in, by name, as `sandboxFor` reads
 * it, the stage included; none when they run as they are.
 */
export function sandboxName(
	env: NodeJS.ProcessEnv = process.env,
	staged: (env: NodeJS.ProcessEnv) => boolean = inFirstStage,
): string | undefined {
	return askedSandbox(env, SANDBOX_NAMES, staged).name;
}

/** What the session asked for, and whether this machine can give it. */
export function sandboxFor(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	// Never PATH: a fenced command can write to folders on it (system-program.ts).
	find: (program: string) => string | undefined = systemProgram,
	github: GitHubTokenSource = sessionTokens,
	gcloud: CloudGrantSource = sessionGrants,
	staged: (env: NodeJS.ProcessEnv) => boolean = inFirstStage,
	inside: () => boolean = insideMacSandbox,
	seatbelt: () => string | undefined = macSandboxExec,
	delta: DeltaTokenSource = sessionDelta,
): Sandbox {
	// The stage's default and a stray value are worked out, never written
	// back, so nothing a reload or a record keeps carries them (fence-stage.ts).
	const { name, note } = askedSandbox(env, SANDBOX_NAMES, staged);
	if (!name) return { kind: "none" };
	const logger = find("logger");
	const asked = askedFor(
		name,
		platform,
		find,
		github,
		gcloud,
		{ inside, seatbelt },
		delta,
	);
	// A refusal carries the stray value's note too, the way back to a
	// fence that runs.
	const sandbox =
		note &&
		(asked.kind === "fence" ||
			asked.kind === "none" ||
			asked.kind === "seatbelt")
			? { ...asked, note: asked.note ? `${note} ${asked.note}` : note }
			: note && asked.kind === "refused"
				? { ...asked, reason: `${note} ${asked.reason}` }
				: asked;
	return logger && sandbox.kind !== "none" ? { ...sandbox, logger } : sandbox;
}

/** The sandbox `asked` names, and whether this machine can give it. */
function askedFor(
	asked: string,
	platform: NodeJS.Platform,
	find: (program: string) => string | undefined,
	github: GitHubTokenSource,
	gcloud: CloudGrantSource,
	mac: {
		readonly inside: () => boolean;
		readonly seatbelt: () => string | undefined;
	},
	delta: DeltaTokenSource,
): Sandbox {
	// Strict is never handed Delta's token: it writes as the person, more
	// than strict's GitHub token, which can't merge.
	if (asked === FENCE) {
		return fenceFor(platform, find, mac.inside, mac.seatbelt, delta);
	}
	if (platform !== "linux") {
		return offLinux("strict", "Landlock", platform, mac.inside, mac.seatbelt);
	}
	const landrun = find("landrun");
	if (!landrun) {
		return {
			kind: "refused",
			reason: `${SANDBOX_VARIABLE}=${STRICT} asks for a sandbox, but ${notKept("landrun")}, so no command runs unfenced.`,
		};
	}
	return { kind: "strict", landrun, github, gcloud };
}

/**
 * A fence asked for where its programs can't run, a Mac. Where pi
 * itself runs inside a sandbox, its commands run inside that one as
 * they are, rather than not at all, since a session that can run
 * nothing does no work. pi can't run inside `pi-fence`, whose Mac
 * profile hides pi's own state, so that sandbox is another's, and
 * it may reach more than the one asked for (ISXEG8 [038ae722] took
 * that risk). A strict command still has the session's credentials held
 * back from its environment (`heldBackCommand`), though not from the
 * files that sandbox lets it read, nor from a command that reads pi's
 * own environment, as a Mac lets one of the same user do. The host
 * is still told the fence asked for, so the node, which reads the
 * sandbox pi runs in, judges where the session may go. Where pi finds
 * no sandbox around it, each command runs in the fence's own profile,
 * laid by sandbox-exec as `pi-fence` lays it (`fence-mac-command.ts`), and
 * where sandbox-exec is missing too, no command runs, so a stranger's
 * text never runs as the person (`mac-sandbox.ts`).
 */
function offLinux(
	kind: "fence" | "strict",
	needs: string,
	platform: NodeJS.Platform,
	inside: () => boolean,
	seatbelt: () => string | undefined,
): Sandbox {
	const asked = kind === "fence" ? "agent fence" : "strict fence";
	if (!inside()) {
		// macOS lays no profile inside another, so only a pi no sandbox
		// holds lays its own around each command; one that couldn't tell
		// lays it too, and a command whose profile doesn't apply is
		// refused (`seatbeltText`).
		const sandboxExec = platform === "darwin" ? seatbelt() : undefined;
		if (sandboxExec) return { kind: "seatbelt", asked: kind, sandboxExec };
		return {
			kind: "refused",
			reason: `The ${asked} needs ${needs}, which only Linux has, and pi found no sandbox of its own here to run commands inside instead, nor sandbox-exec to lay the fence's own profile around each command, so no command runs unfenced.`,
		};
	}
	return {
		kind: "none",
		asked: kind,
		note: `The ${asked} needs ${needs}, which only Linux has, so commands run here as they are, inside the sandbox pi itself runs in. pi can't tell which sandbox that is, and it may reach more than the ${asked} would.${kind === "strict" ? " Each command still runs without the session's tokens and agent socket in its environment, though it may read whatever files that sandbox allows, and pi's own environment, which a Mac lets a process of the same user read." : ""}`,
	};
}

/**
 * Makes each folder the fence keeps within a home entry, where that
 * entry is there: the deeper read-only paths and the caches within
 * read-only entries, which nothing inside could make.
 */
export function makeFoldersFirst(home: string): void {
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
	// Made for every kind, so a quest shares on a machine whatever fence
	// its sessions run in, and no fenced command finds the root missing.
	makeScratches();
	const scratch = questScratch(place.env.TMPDIR);
	const share = makeShares(scratch);
	switch (sandbox.kind) {
		case "none":
			return sandbox.asked === "strict" ? heldBackCommand : undefined;
		case "refused":
			return () => refused(sandbox.reason);
		// Laid per command by `commandWrapFor` (fence-mac-command.ts), which this
		// module can't import; asked here, nothing runs rather than unfenced.
		case "seatbelt":
			return () =>
				refused(
					"this session's fence is laid around each command by its own profile, which this caller didn't lay, so nothing runs",
				);
		case "fence": {
			const session = place.env.PI_SESSION_ID;
			const stopped = plantStopped(session);
			if (stopped) return () => refused(stopped);
			const worktrees = sessionWorktrees(place.cwd, session);
			const watched = guardedFolders(worktrees, session, (root) =>
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
			const direnv = fencedDirenv(home, place.env, direnvTrusts());
			// dev's setup writes its settings and git's global ones on every
			// call, so the session writes copies of its own (fence-dev.ts).
			const devCopies = fenceDevCopies(home, place.env, session);
			const served = sandbox.served === true;
			// gcloud's ssh writes its known hosts and wants its key's two
			// halves in ~/.ssh, which the fence keeps read-only and empties of
			// private keys, so the session has copies (fence-gcloud-ssh.ts).
			// Every caller wraps afresh for each command, so this brings them
			// up to date just before the one command it wraps.
			let gcloudUnmade: string | undefined;
			const gcloudSsh = served
				? undefined
				: fenceGcloudSsh(
						place.env.XDG_RUNTIME_DIR,
						home,
						sessionFolderName(place.env),
						(why) => {
							gcloudUnmade = `its files couldn't be copied: ${why}`;
						},
					);
			// With no public half as a plain file the fence binds no stand-in,
			// so gcloud finds no key and makes one, which the read-only ~/.ssh
			// refuses.
			if (gcloudSsh && !hasPublicHalf(join(home, ".ssh"))) {
				gcloudUnmade = `~/.ssh/${GCLOUD_KEY}.pub is missing or not a plain file, so gcloud would make a new key, which it can't write here; make it once outside the fence`;
			}
			// A language server runs no one's ask, so it reaches no node.
			const workerSocket = served
				? undefined
				: fencedWorkerSocket(place.env, sandbox.workerSockets);
			const fence = {
				home,
				runtimeDir: place.env.XDG_RUNTIME_DIR,
				...(served ? { served } : {}),
				...(workerSocket ? { workerSocket } : {}),
				...(direnv ? { direnv } : {}),
				...(githubFolder ? { githubDoor: githubFolder } : {}),
				...worktrees,
				scratch,
				share,
				sshConfig: fenceSshConfig(place.env.XDG_RUNTIME_DIR),
				npmrc: fenceNpmrc(home, place.env.XDG_RUNTIME_DIR),
				docker: dockerHoldsCredentials(home),
				...(devCopies ? { devCopies } : {}),
				...(gcloudSsh ? { gcloudSsh } : {}),
			};
			makeFoldersFirst(home);
			setAsidePlanted();
			const planted = plantedCache();
			if (planted) return () => refused(planted);
			const own = fenceFolders(home).homes;
			// Never waited on: a command started first finds what the own
			// homes held already.
			void seedOwnHomes(home, own);
			const args = fenceArgs(fence);
			const made = {
				bwrap: sandbox.bwrap,
				landrun: sandbox.landrun,
				// Read from a file, since in the text they can pass the 128 KiB
				// Linux takes in one string; in it only where no file can be had.
				args: bwrapArgsFile(fence.runtimeDir, args) ?? args,
				rules: fenceRules(fence),
				door: nixDoor(fence.runtimeDir),
				...(served
					? {}
					: {
							agent: agentProxy(fence.runtimeDir),
							shims: fenceShims(home),
							display: fenceDisplay(fence.runtimeDir),
						}),
				homes: [
					...OWN_HOMES.map(
						([name, folder]) => [name, join(own, folder)] as const,
					),
					...(direnv ? [[DIRENV_VARIABLE, direnv] as const] : []),
					...(devCopies
						? [["GIT_CONFIG_GLOBAL", gitGlobalIn(devCopies.git)] as const]
						: []),
				],
				...(github ? { github } : {}),
			};
			// Said only for a command the fence would run, never one sent
			// outside it. Those it can count are counted here; the shell
			// counts the variables it passes as well, before bubblewrap starts.
			// gcloud's settings folder is counted here before it is made.
			const counted = bwrapWords({
				...made,
				passed: { ...CLOUD_COUNTED, ...DELTA_COUNTED },
			});
			const tooMany =
				counted > BWRAP_MOST_ARGS
					? `The fence would hand bubblewrap at least ${counted} arguments, past the ${BWRAP_MOST_ARGS} it takes; they grow with the trees this session holds, so release the ones it is done with.`
					: undefined;
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
				if (tooMany) return refused(tooMany);
				// The person's cloud login stays hidden (fence-hidden.ts), and
				// gcloud gets an empty settings folder of its own and no token
				// (`NO_CLOUD_IN_THE_FENCE`).
				const { grant, passed } = fenceCloud(home, place.env);
				// dt and `devx ci` read Delta's token from these, in place of
				// any the person's shell names (`delta-token.ts`).
				const delta = deltaVariables(sandbox.delta?.());
				const cloud = {
					...made,
					passed: { ...passed, ...delta, ...workerSocketPassed(workerSocket) },
				};
				const guarded = guardedIn(watched);
				const planted = recordedInShell(
					{ kind: "plant", tool: "git", sandbox: FENCE, session },
					sandbox.logger,
				);
				const text = withAfterCheckIn(
					fence.runtimeDir,
					fencedCommand(
						withGcloudSshNote(
							withCloudNote(withSecretNote(command), grant),
							gcloudUnmade,
							command,
						),
						cloud,
					),
					guarded,
					planted,
				);
				// What can't go in a file is said rather than left to fail with
				// a bare E2BIG.
				const long = tooLong(
					text,
					command,
					cloud.args,
					() =>
						guarded.length > 0 &&
						guardedListFile(fence.runtimeDir, guarded) === undefined,
				);
				return long === undefined ? text : refused(long);
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
			const served = sandbox.served === true;
			// A language server runs no one's ask, so it reaches no node.
			const workerSocket = served
				? undefined
				: fencedWorkerSocket(place.env, sandbox.workerSockets);
			const rules = strictRules({
				home,
				runtimeDir: place.env.XDG_RUNTIME_DIR,
				cwd: place.cwd,
				repository: worktreeRepository(place.cwd, home),
				...(served ? { served } : {}),
				...(workerSocket ? { workerSocket } : {}),
			});
			// gh reads GH_TOKEN, and git asks its helper for it.
			const token = sandbox.github?.();
			const given = token ? [...rules, ...githubRules()] : rules;
			// gcloud reads its token, project and settings folder from these.
			const grant = sandbox.gcloud?.();
			// A server's sandbox has neither, and its own gcloud settings would
			// be ones the session's next granted command reads.
			const passed: Record<string, string> = {
				...(token ? { GH_TOKEN: token } : {}),
				...(served ? {} : cloudVariables(grant, home, place.env)),
				...workerSocketPassed(workerSocket),
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
