/**
 * What every terminal driver driven through a cli is built with: the
 * clock each call ends at, how long typing waits for a prompt, and
 * where the session's environment is read from.
 *
 * Said once because the four drivers took the same three options with
 * the same defaults, each spelling them out for itself.
 */

import { TERMINAL_CLI_TIMEOUT_MS } from "../cli.ts";
import { PROMPT_WAIT_MS } from "./shared.ts";

/** A session's environment, as a driver reads it. */
export type DriverEnvironment = Readonly<Record<string, string | undefined>>;

/** What a terminal driver driven through a cli can be built with. */
export interface CliDriverOptions {
	/** How long one cli call may take. */
	readonly cliTimeoutMs?: number;
	/** How long typing waits for a new shell's prompt. */
	readonly promptWaitMs?: number;
	/** Where the session's environment is read from. */
	readonly env?: () => DriverEnvironment;
}

/** A driver's options with every one it left out set to its default. */
export interface CliDriverSettings {
	readonly timeout: number;
	readonly promptWait: number;
	readonly env: () => DriverEnvironment;
}

/**
 * The settings a driver runs on: what it was given, else the shared
 * cli clock (or the driver's own, where it has one), the prompt wait,
 * and this process's environment.
 */
export function cliDriverSettings(
	options: CliDriverOptions,
	cliTimeoutMs: number = TERMINAL_CLI_TIMEOUT_MS,
): CliDriverSettings {
	return {
		timeout: options.cliTimeoutMs ?? cliTimeoutMs,
		promptWait: options.promptWaitMs ?? PROMPT_WAIT_MS,
		env: options.env ?? (() => process.env),
	};
}
