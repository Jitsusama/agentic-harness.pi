/**
 * This machine, as the other machines of its realm name it: its
 * hostname's short form, the first label, as mycelium names a machine
 * (`penelope`, never `penelope.local`).
 *
 * A quest's handover folder is named for the machine that wrote it,
 * and the machine taking it up names that folder from what mycelium
 * says, so both ends must write the name the same way.
 */

import { hostname } from "node:os";

/** What a machine's name may be: letters, digits, dots and dashes, never a leading dash. */
const MACHINE_NAME = /^[A-Za-z0-9.][A-Za-z0-9.-]*$/;

/** This machine's name, from its hostname's first label. */
export function thisMachine(name: string = hostname()): string {
	return name.split(".")[0] || name;
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
