/**
 * The variables, as a session was started with them, that say how it
 * runs its commands: in the agent fence and through the spawner. Each
 * way back into a session hands them on: a holder's restart, and the
 * launcher reopening it from its record after the machine restarted.
 * Without them, on 11 November, a session started fenced came back
 * from a park, and from a reboot, unfenced.
 */

import { SANDBOX_VARIABLE } from "../sandbox.ts";
import { SPAWNER_VARIABLE } from "../shell/spawner-variable.ts";

/** The variables carried, by name. */
export const CARRIED_VARIABLES: readonly string[] = [
	SANDBOX_VARIABLE,
	SPAWNER_VARIABLE,
];

/**
 * A value that is a word alone, safe to hand on in a command line or a
 * file another program reads into one.
 */
const PLAIN_VALUE = /^[A-Za-z0-9._-]+$/;

/** The carried variables and their values, as one environment holds them. */
export type CarriedEnvironment = Readonly<Record<string, string>>;

/**
 * The carried variables `env` sets to a plain word, or nothing when it
 * sets none: a value that isn't one is left behind rather than handed
 * on, since no setting of these needs more.
 */
export function carriedEnvironment(
	env: NodeJS.ProcessEnv,
): CarriedEnvironment | undefined {
	const carried = Object.fromEntries(
		CARRIED_VARIABLES.flatMap((name) => {
			const value = env[name];
			return value !== undefined && PLAIN_VALUE.test(value)
				? [[name, value]]
				: [];
		}),
	);
	return Object.keys(carried).length === 0 ? undefined : carried;
}

/**
 * `value` as a carried environment, as a record or a file another
 * program wrote may hold one, or nothing when it is anything else.
 */
export function asCarriedEnvironment(
	value: unknown,
): CarriedEnvironment | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const entries = Object.entries(value);
	const carried = entries.every(
		([name, set]) =>
			CARRIED_VARIABLES.includes(name) &&
			typeof set === "string" &&
			PLAIN_VALUE.test(set),
	);
	return carried && entries.length > 0
		? Object.fromEntries(entries)
		: undefined;
}
