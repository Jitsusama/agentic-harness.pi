/**
 * The ssh guard: an agent's command may not run a command on one of the
 * person's own machines over ssh, scp, sftp or rsync, past the fence the
 * node lays there, and is told to ask the node with `mycelium run`.
 *
 * On 17 November a session's script ran on Joel's work Mac over ssh, its
 * `cd` failed, and `find . -type f -exec touch {} +` ran from his home,
 * changing the times of his files. The ssh ran inside a quest tool, so
 * no check of the command's text could see it. The guard sits where the
 * program is found instead: a folder of stand-ins put first on the
 * agent's `PATH` (scripts/ssh-guard/bin), which refuse a realm machine
 * and hand everything else to the real program after them. scp and sftp
 * run the ssh they were built with rather than PATH's, so each has its
 * own stand-in.
 *
 * It is a setting, off unless the package config's `ssh-guard` section
 * says `"refuse": true`, read again each minute, so turning it off again
 * takes one edit and no restart. Off, nothing is put on PATH. It routes
 * agents rather than confining them: ssh named by its full path, or git
 * over ssh (`GIT_SSH`, `core.sshCommand`), passes it, and the agent can
 * edit the setting. The fence for every session is the bound (ISXEG8
 * and WCJQSG, 17 November).
 */

import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { askAt, nodeSocket } from "../../mesh/node.ts";
import { loadPackageConfig } from "../config/loader.ts";
import { isMachineName, thisMachine } from "../machine/machine.ts";
import { isRecord } from "../record.ts";

/** The folder of stand-ins for ssh, scp, sftp and rsync. */
export const SSH_GUARD_BIN = fileURLToPath(
	new URL("../../../scripts/ssh-guard/bin", import.meta.url),
);

/** The package config's section for the guard. */
export const SSH_GUARD_SECTION = "ssh-guard";

/** The variable the stand-ins read the realm's machines from, space apart. */
export const SSH_GUARD_MACHINES = "PI_SSH_GUARD_MACHINES";

/** The variable naming this machine, which `localhost` reaches too. */
export const SSH_GUARD_HERE = "PI_SSH_GUARD_HERE";

/** How long the node may take to name the realm's machines. */
const MACHINES_PATIENCE_MS = 2000;

/** How often the setting and the machines are read again. */
export const SSH_GUARD_EVERY_MS = 60_000;

/** What the guard does now: whether it refuses, and which machines. */
export interface SshGuard {
	readonly refuse: boolean;
	readonly machines: readonly string[];
	/** This machine, among them, which `localhost` reaches too. */
	readonly here?: string;
}

/** The guard as it starts, and as a config naming nothing leaves it. */
export const SSH_GUARD_OFF: SshGuard = { refuse: false, machines: [] };

/** Whether the config's section turns the guard on; anything else is off. */
export function refusesBySetting(section: unknown): boolean {
	return isRecord(section) && section.refuse === true;
}

/** The machines named in a node's answer to `Machines`, or none. */
export function machinesFrom(line: string | undefined): string[] {
	if (line === undefined) return [];
	let reply: unknown;
	try {
		reply = JSON.parse(line);
	} catch {
		// Not an answer this reader knows: it names no machine.
		return [];
	}
	const machines =
		isRecord(reply) && isRecord(reply.Ok) ? reply.Ok.Machines : undefined;
	if (!Array.isArray(machines)) return [];
	return machines.flatMap((one) =>
		isRecord(one) && isMachineName(one.name) ? [one.name] : [],
	);
}

/** Where the guard reads its setting and the realm's machines. */
export interface SshGuardSources {
	/** The package config's `ssh-guard` section; throws when unreadable. */
	readonly section: () => Promise<unknown>;
	/** The node's answer to `Machines`, or nothing when none answers. */
	readonly machines: () => Promise<string | undefined>;
	/** This machine's name. */
	readonly here: string;
}

/** The config file and this machine's node. */
function sourcesOf(env: NodeJS.ProcessEnv): SshGuardSources {
	return {
		section: async () => {
			const loaded = await loadPackageConfig();
			if (!loaded.ok) throw new Error(loaded.error);
			return loaded.config.sections[SSH_GUARD_SECTION];
		},
		machines: () => askAt(nodeSocket(env), "Machines", MACHINES_PATIENCE_MS),
		here: thisMachine(env),
	};
}

/**
 * The guard as the config and the node say it now, after `before`. A
 * config that can't be read throws, so the guard stays as it stood. A
 * node that doesn't answer keeps the machines read before, and this
 * machine is always one of the person's. Off, no node is asked.
 */
export async function readSshGuard(
	before: SshGuard = SSH_GUARD_OFF,
	sources: SshGuardSources = sourcesOf(process.env),
): Promise<SshGuard> {
	if (!refusesBySetting(await sources.section())) return SSH_GUARD_OFF;
	const answer = await sources.machines();
	const named = answer === undefined ? before.machines : machinesFrom(answer);
	const machines = new Set([...named, sources.here]);
	return { refuse: true, machines: [...machines], here: sources.here };
}

/** The guard as last read, kept current while watched. */
export interface SshGuardWatch {
	/** The guard as last read; off until the first read lands. */
	current(): SshGuard;
	/** Read it now, and again each minute until stopped. */
	start(): void;
	/** Stop reading it again. */
	stop(): void;
}

/**
 * Watch the guard, read by `read`. A read that fails keeps what was
 * last read, so a config being rewritten leaves the guard as it stood.
 */
export function watchSshGuard(
	read: (before: SshGuard) => Promise<SshGuard> = readSshGuard,
	everyMs: number = SSH_GUARD_EVERY_MS,
): SshGuardWatch {
	let guard = SSH_GUARD_OFF;
	let timer: ReturnType<typeof setInterval> | undefined;
	// Each read is counted, so one that lands after a later one is dropped.
	let asked = 0;
	let landed = 0;
	const again = () => {
		const mine = ++asked;
		read(guard).then(
			(read) => {
				if (mine < landed) return;
				landed = mine;
				guard = read;
			},
			() => {
				// Kept as last read: the next minute's read tries again.
			},
		);
	};
	return {
		current: () => guard,
		start() {
			again();
			if (timer) return;
			timer = setInterval(again, everyMs);
			timer.unref?.();
		},
		stop() {
			clearInterval(timer);
			timer = undefined;
		},
	};
}

/**
 * A command's environment with the stand-ins first on its `PATH` and the
 * machines they refuse, while the guard refuses; as it was otherwise.
 */
export function guardedEnvironment(
	env: NodeJS.ProcessEnv,
	guard: SshGuard,
): NodeJS.ProcessEnv {
	if (!guard.refuse || guard.machines.length === 0) return env;
	const path = env.PATH ?? "";
	const rest = path
		.split(delimiter)
		.filter((part) => part && part !== SSH_GUARD_BIN);
	return {
		...env,
		PATH: [SSH_GUARD_BIN, ...rest].join(delimiter),
		[SSH_GUARD_MACHINES]: guard.machines.join(" "),
		...(guard.here ? { [SSH_GUARD_HERE]: guard.here } : {}),
	};
}
