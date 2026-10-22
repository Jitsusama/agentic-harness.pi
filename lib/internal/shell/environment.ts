/**
 * What the agent's shell runs with, offered by the extensions that know.
 *
 * The shell workflow builds the bash tool, but it does not know which
 * quest is loaded, and the quest workflow should not have to build a
 * shell to say where scratch goes. So an extension offers variables
 * here under its own name, and the shell reads every offer as each
 * command starts. An offer is a function rather than a value, so it
 * describes the session as it stands when the command runs: loading
 * another quest moves the next command's scratch with it.
 *
 * Only the agent's commands see these. pi itself, the person's shell
 * and anything a command exports for itself are left as they were.
 */

import { processGlobal } from "../process-global.ts";

/** Variables for the next command, or undefined to offer none now. */
export type ShellEnvironmentOffer = () =>
	| Readonly<Record<string, string>>
	| undefined;

const offers = () =>
	processGlobal(
		"pi:shell-environment:v1",
		() => new Map<string, ShellEnvironmentOffer>(),
	);

/** Offer variables under `name`, or withdraw the offer with undefined. */
export function offerShellEnvironment(
	name: string,
	offer: ShellEnvironmentOffer | undefined,
): void {
	if (offer) offers().set(name, offer);
	else offers().delete(name);
}

/**
 * Every offer's variables, merged in the order they were offered. An
 * offer that throws is left out: a command runs without one variable
 * rather than not at all.
 */
export function offeredShellEnvironment(): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const offer of offers().values()) {
		try {
			Object.assign(merged, offer());
		} catch {
			// One extension's broken offer must not stop every command.
		}
	}
	return merged;
}
