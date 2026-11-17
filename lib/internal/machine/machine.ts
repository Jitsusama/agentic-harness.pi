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

/** The name this machine's mycelium node recorded, if it can be one. */
function recordedMachine(env: NodeJS.ProcessEnv): string | undefined {
	const state = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	try {
		const kept = readFileSync(join(state, "mycelium", "machine"), "utf8");
		const name = kept.trim();
		return isMachineName(name) ? name : undefined;
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
