/**
 * Fast-layer decision logic: from the errors found on the
 * files touched this turn, the active TDD phase and how many
 * times we have already asked the agent to fix them, decide
 * whether to stay quiet, inject a fix request, or give up and
 * hand the failure back to the user.
 *
 * The loop defers entirely while a TDD loop runs, since that
 * already governs verification for the code under test, and
 * caps its attempts so a run that cannot reach green does not
 * thrash.
 */

/** One error-severity diagnostic on a touched file. */
export interface FileError {
	readonly path: string;
	readonly line: number;
	readonly character: number;
	readonly message: string;
}

export interface FastLayerInput {
	readonly tddPhase: string;
	readonly attempts: number;
	readonly maxAttempts: number;
	readonly errors: readonly FileError[];
}

export type FastLayerVerdict =
	| { action: "skip"; reason: string }
	| { action: "inject"; message: string; attempt: number }
	| { action: "giveUp"; message: string };

export function fastLayerVerdict(input: FastLayerInput): FastLayerVerdict {
	if (input.tddPhase !== "idle") {
		return { action: "skip", reason: "a TDD loop is active" };
	}
	if (input.errors.length === 0) {
		return { action: "skip", reason: "no errors on touched files" };
	}
	if (input.attempts >= input.maxAttempts) {
		return {
			action: "giveUp",
			message:
				`Verification still reports ${input.errors.length} error(s) on files ` +
				`changed this turn after ${input.attempts} fix attempts. I could not ` +
				"get them green:\n" +
				formatErrors(input.errors),
		};
	}
	return {
		action: "inject",
		attempt: input.attempts + 1,
		message:
			`Verification found ${input.errors.length} error(s) in files you changed ` +
			"this turn. Fix them before yielding:\n" +
			formatErrors(input.errors),
	};
}

function formatErrors(errors: readonly FileError[]): string {
	return errors
		.map((e) => `- ${e.path}:${e.line}:${e.character} ${e.message}`)
		.join("\n");
}
