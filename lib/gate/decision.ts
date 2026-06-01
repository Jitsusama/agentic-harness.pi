/**
 * The generalized loop breaker. A gate blocks a violation set
 * the first time it sees it, but relents if the identical set
 * comes back, on the theory that an author who could not satisfy
 * the rule after one specific, skill-grounded retry will not
 * satisfy it on the next either. Relenting surfaces the
 * violations to the human gate rather than trapping the author
 * in a loop.
 *
 * The mechanism is domain-neutral: prose violations and section
 * violations both flow through it, each supplying its own
 * detection, its own block message and its own relent wording.
 */

/** A single convention violation that can be signed and gated. */
export interface Violation {
	/** Which rule was broken (the signature's namespace). */
	readonly kind: string;
	/** The offending text, used in the signature and the message. */
	readonly found: string;
}

/** allow: clean. block: first offence. relent: already blocked once. */
export type GateAction = "allow" | "block" | "relent";

/** The gate's verdict on one artifact. */
export interface GateDecision {
	readonly action: GateAction;
	/** Stable signature of this violation set, for the caller to persist. */
	readonly signature: string;
	/** Message for the AI (block) or the user (relent); empty when allowed. */
	readonly message: string;
}

/**
 * A stable, order-independent signature of a violation set. The
 * found text is lower-cased so a recurrence that only changes
 * case is still recognized as the same violation.
 */
export function violationSignature(violations: Violation[]): string {
	return violations
		.map((v) => `${v.kind}:${v.found.toLowerCase()}`)
		.sort()
		.join("|");
}

/**
 * Decide whether to block, relent or allow a violation set given
 * the signatures already blocked this session. format renders
 * the block body; relentPrefix is prepended to that body when
 * the gate relents, to explain why the violation is being let
 * through.
 */
export function decideGate<T extends Violation>(
	violations: T[],
	priorSignatures: string[],
	format: (violations: T[]) => string,
	relentPrefix: string,
): GateDecision {
	if (violations.length === 0) {
		return { action: "allow", signature: "", message: "" };
	}

	const signature = violationSignature(violations);
	if (priorSignatures.includes(signature)) {
		return {
			action: "relent",
			signature,
			message: relentPrefix + format(violations),
		};
	}

	return { action: "block", signature, message: format(violations) };
}
