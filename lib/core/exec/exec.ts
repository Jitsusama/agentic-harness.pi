/**
 * The one impure thing a library here needs: running a command.
 *
 * Taking it as a dependency rather than importing pi's own exec keeps every caller
 * testable, and keeps these libraries usable by anything that can run a command.
 *
 * It lived under the review providers until two libraries needed it. Review reaches
 * a backend by running its CLI and work reaches git the same way, so `lib/work`
 * imported the type out of `lib/review/providers`, which said the working layer
 * depended on the reviewing one when the only thing it wanted was the shape of a
 * subprocess. Neither owns this. It sits at the level that matches what it is.
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
 *
 * Both streams are kept when both said something, because they carry
 * different halves of the same answer and the useful half was being thrown
 * away. `gh api` writes its own summary to stderr and the server's response
 * body to stdout, so preferring stderr reduced a 422 that named the exact
 * offending field to `gh: Unprocessable Entity (HTTP 422)`. That is a
 * complete sentence about nothing: the field name is what tells you the
 * request was wrong rather than the change.
 */
export async function run(
	exec: Exec,
	command: string,
	args: string[],
	what: string,
): Promise<string> {
	const result = await exec(command, args);
	if (result.code !== 0) {
		throw new Error(`${what} failed: ${failureDetail(result, command)}`);
	}
	return result.stdout;
}

/**
 * How much of a stream to keep in a failure message.
 *
 * An error body is a line or two; a command that fails after writing real
 * output can put a whole diff on stdout, and a message nobody will read to
 * the end is its own kind of silence.
 */
const DETAIL_LIMIT = 2000;

/** As much of both streams as says something, in the order they matter. */
function failureDetail(result: ExecResult, command: string): string {
	const said = [result.stderr.trim(), result.stdout.trim()]
		.filter((stream) => stream !== "")
		// The same words on both streams read like two problems.
		.filter((stream, at, all) => all.indexOf(stream) === at)
		.map((stream) =>
			stream.length > DETAIL_LIMIT
				? `${stream.slice(0, DETAIL_LIMIT)}\u2026`
				: stream,
		);
	return said.join("\n") || `${command} exited nonzero`;
}
