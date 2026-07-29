/**
 * The one impure thing a provider needs.
 *
 * Providers reach their backends by running a CLI, which is
 * the only seam between this library and a process. Taking it
 * as a dependency rather than importing pi's own exec keeps
 * every provider testable, and keeps the library usable by
 * anything that can run a command.
 */

/** What running a command returns. */
export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs a command and returns its result rather than throwing. */
export type Exec = (command: string, args: string[]) => Promise<ExecResult>;

/** What every provider factory takes. */
export interface ProviderDeps {
	exec: Exec;
}

/**
 * Run a command, throwing with the backend's own words when it
 * fails. A CLI's stderr is usually the most useful diagnostic
 * available, so it is preserved rather than replaced.
 */
export async function run(
	exec: Exec,
	command: string,
	args: string[],
	what: string,
): Promise<string> {
	const result = await exec(command, args);
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim();
		throw new Error(`${what} failed: ${detail || `${command} exited nonzero`}`);
	}
	return result.stdout;
}
