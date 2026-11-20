/**
 * This machine, as the other machines of its realm name it: the name its
 * mycelium node recorded in `<state>/mycelium/machine`, else its
 * hostname's short form, the first label, as mycelium names a machine
 * (`penelope`, never `penelope.local`). A node goes by `--machine`,
 * else that record, else the hostname (KP0L6A, mycelium #204).
 *
 * A quest's handover folder is named for the machine that wrote it,
 * and the machine taking it up names that folder from what mycelium
 * says, so both ends must write the name the same way.
 */

import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

/** What a machine's name may be: letters, digits, dots and dashes, never a leading dash. */
const MACHINE_NAME = /^[A-Za-z0-9.][A-Za-z0-9.-]*$/;

/**
 * This machine's name: what its mycelium node recorded, when that can
 * name a machine, else `system`'s first label.
 */
export function thisMachine(
	env: NodeJS.ProcessEnv = process.env,
	system: string = hostname(),
): string {
	const kept = recordedMachine(env);
	return kept ?? (system.split(".")[0] || system);
}

/**
 * This machine's name as `thisMachine` reads it, with its record read
 * by `readOff`, off the thread, for a reader a stalled disk must not
 * hold. Where the record is there but can't be read, or names no
 * machine, it fails, rather than answer the hostname for a node that
 * may go by another name.
 */
export async function thisMachineOff(
	readOff: (path: string) => Promise<string>,
	env: NodeJS.ProcessEnv = process.env,
	system: string = hostname(),
): Promise<string> {
	const kept = await readOff(machineRecordOf(env)).then(
		namedStrictly,
		(error: unknown) => {
			if (!isMissing(error)) throw error;
			// No node has named this machine, so its hostname does.
			return undefined;
		},
	);
	return kept ?? (system.split(".")[0] || system);
}

/**
 * This machine's name as `thisMachineOff` reads it, on the thread: where
 * the record is there but can't be read, it fails too.
 */
export function thisMachineRead(
	env: NodeJS.ProcessEnv = process.env,
	system: string = hostname(),
): string {
	let kept: string | undefined;
	try {
		kept = namedStrictly(readFileSync(machineRecordOf(env), "utf8"));
	} catch (error) {
		if (!isMissing(error)) throw error;
		// No node has named this machine, so its hostname does.
	}
	return kept ?? (system.split(".")[0] || system);
}

/**
 * Whether `error` says a file isn't there, and nothing else: not there,
 * or a file where a folder on its way goes, which holds no record either.
 */
function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

/** Where this machine's mycelium node records its name. */
export function machineRecordOf(env: NodeJS.ProcessEnv = process.env): string {
	const state = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(state, "mycelium", "machine");
}

/**
 * The machine a record's text names, failing where it names none (empty,
 * half written or stray text), since the node may go by a name the
 * hostname isn't.
 */
function namedStrictly(kept: string): string {
	const name = namedIn(kept);
	if (name === undefined) {
		throw Object.assign(new Error("it names no machine"), {
			code: "it names no machine",
		});
	}
	return name;
}

/** The machine a record's text names, if it can name one. */
function namedIn(kept: string): string | undefined {
	const name = kept.trim();
	return isMachineName(name) ? name : undefined;
}

/** The name this machine's mycelium node recorded, if it can be one. */
function recordedMachine(env: NodeJS.ProcessEnv): string | undefined {
	try {
		return namedIn(readFileSync(machineRecordOf(env), "utf8"));
	} catch {
		// No node has named this machine, so its hostname does.
		return undefined;
	}
}

/**
 * Whether `name` can name a machine, as a hostname can: it becomes a
 * folder's name and a word on a command line, so nothing else is taken.
 */
export function isMachineName(name: unknown): name is string {
	return (
		typeof name === "string" &&
		MACHINE_NAME.test(name) &&
		name !== "." &&
		name !== ".."
	);
}
