/**
 * What came back from running an expression in the page.
 *
 * An exception is a result, not an error to swallow: running
 * code against a live page to find out how it fails is the whole
 * point of being able to run code against a live page.
 */

/** One frame of a page-side stack. */
export interface EvalFrame {
	readonly functionName: string;
	readonly url: string;
	readonly lineNumber: number;
	readonly columnNumber: number;
}

/** The page threw. */
export interface EvalThrew {
	readonly message: string;
	readonly className?: string;
	readonly frames: readonly EvalFrame[];
	/** Whether it came out of a promise rather than directly. */
	readonly fromPromise: boolean;
}

/** The page answered. */
export interface EvalValue {
	readonly type: string;
	readonly value: unknown;
	/** Whether anything was left out to keep the answer a size. */
	readonly clipped: boolean;
}

/** How an evaluation ended. */
export type EvalOutcome =
	| { readonly ok: true; readonly result: EvalValue }
	| { readonly ok: false; readonly threw: EvalThrew }
	| { readonly ok: false; readonly refused: string };

/** Runtime.exceptionDetails, as the protocol sends it. */
export interface RawExceptionDetails {
	readonly text?: string;
	readonly lineNumber?: number;
	readonly columnNumber?: number;
	readonly exception?: {
		readonly className?: string;
		readonly description?: string;
	};
	readonly stackTrace?: {
		readonly callFrames?: readonly {
			readonly functionName?: string;
			readonly url?: string;
			readonly lineNumber?: number;
			readonly columnNumber?: number;
		}[];
	};
}

/**
 * Read the protocol's account of a thrown exception.
 *
 * The useful message is on the exception's description, not on
 * the details' text, which is only ever "Uncaught" or "Uncaught
 * (in promise)". Reporting the text would tell the caller
 * nothing they did not already know.
 */
export function describeThrow(details: RawExceptionDetails): EvalThrew {
	const description = details.exception?.description;
	const message = description ?? details.text ?? "Something threw.";
	return {
		// The description carries its own stack after the first
		// line, which the frames already say more precisely.
		message: message.split("\n")[0] ?? message,
		...(details.exception?.className === undefined
			? {}
			: { className: details.exception.className }),
		frames: (details.stackTrace?.callFrames ?? []).map((frame) => ({
			functionName: frame.functionName || "(anonymous)",
			url: frame.url ?? "",
			lineNumber: frame.lineNumber ?? 0,
			columnNumber: frame.columnNumber ?? 0,
		})),
		fromPromise: (details.text ?? "").includes("in promise"),
	};
}

/** How much of a rendered value to inline before diverting it. */
export const MAX_INLINE_RESULT = 4096;

/** Say what happened. */
export function renderEvaluation(outcome: EvalOutcome): string {
	if (!outcome.ok && "refused" in outcome) return outcome.refused;

	if (!outcome.ok) {
		const { threw } = outcome;
		const lines = [
			threw.fromPromise
				? `The page rejected: ${threw.message}`
				: `The page threw: ${threw.message}`,
		];
		// A stack of one anonymous frame at the top of the
		// expression says only what the message already said.
		const useful = threw.frames.filter(
			(frame) => frame.url !== "" || frame.functionName !== "(anonymous)",
		);
		if (useful.length > 0) {
			lines.push("");
			for (const frame of useful) {
				lines.push(
					`  ${frame.functionName} ${frame.url}:` +
						`${frame.lineNumber + 1}:${frame.columnNumber}`,
				);
			}
		}
		return lines.join("\n");
	}

	const { result } = outcome;
	if (result.type === "undefined" || result.value === "[undefined]") {
		return "The expression returned undefined.";
	}

	const body =
		typeof result.value === "string"
			? result.value
			: JSON.stringify(result.value, null, 2);

	const head = `${result.type}:`;
	if (body.length <= MAX_INLINE_RESULT) {
		return result.clipped
			? `${head} ${body}\n\n(Parts were left out to keep this a size.)`
			: `${head} ${body}`;
	}
	return (
		`${head} ${body.slice(0, MAX_INLINE_RESULT)}\n\n` +
		`... ${body.length - MAX_INLINE_RESULT} more characters. Narrow the ` +
		`expression, or pick out the part you want.`
	);
}
