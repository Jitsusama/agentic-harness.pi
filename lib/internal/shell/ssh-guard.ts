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
 * takes one edit and no restart. Off, nothing is put on PATH. It is a
 * guard against a mistake, not a wall: a command can name the real ssh
 * by its path, which the fence for everyone will close (ISXEG8 and
 * WCJQSG, 17 November).
 */

import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { askAt, nodeSocket } from "../../mesh/node.ts";
import { loadPackageConfig } from "../config/loader.ts";
import { thisMachine } from "../machine.ts";
import { isRecord } from "../record.ts";

/** The folder of stand-ins for ssh, scp, sftp and rsync. */
export const SSH_GUARD_BIN = fileURLToPath(
	new URL("../../../scripts/ssh-guard/bin", import.meta.url),
);

/** The package config's section for the guard. */
export const SSH_GUARD_SECTION = "ssh-guard";

/** The variable the stand-ins read the realm's machines from, space apart. */
export const SSH_GUARD_MACHINES = "PI_SSH_GUARD_MACHINES";

/** How long the node may take to name the realm's machines. */
const MACHINES_PATIENCE_MS = 2000;

/** How often the setting and the machines are read again. */
export const SSH_GUARD_EVERY_MS = 60_000;

/** What the guard does now: whether it refuses, and which machines. */
export interface SshGuard {
	readonly refuse: boolean;
	readonly machines: readonly string[];
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
		isRecord(one) && typeof one.name === "string" && /^[\w.-]+$/.test(one.name)
			? [one.name]
			: [],
	);
}

/**
 * The guard as the config and the node say it now. With no node
 * answering, this machine is still one of the person's, so it is named.
 */
export async function readSshGuard(
	env: NodeJS.ProcessEnv = process.env,
): Promise<SshGuard> {
	const loaded = await loadPackageConfig();
	const refuse =
		loaded.ok && refusesBySetting(loaded.config.sections[SSH_GUARD_SECTION]);
	if (!refuse) return SSH_GUARD_OFF;
	const named = machinesFrom(
		await askAt(nodeSocket(env), "Machines", MACHINES_PATIENCE_MS),
	);
	const machines = new Set([...named, thisMachine(env)]);
	return { refuse, machines: [...machines] };
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
	read: () => Promise<SshGuard> = readSshGuard,
	everyMs: number = SSH_GUARD_EVERY_MS,
): SshGuardWatch {
	let guard = SSH_GUARD_OFF;
	let timer: ReturnType<typeof setInterval> | undefined;
	const again = () => {
		read().then(
			(read) => {
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
	};
}
