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
 * A small, stable, non-cryptographic string hash (djb2). Used to
 * fingerprint the artifact so the signature can be scoped to it
 * without storing the whole body. A collision only ever causes a
 * benign spurious relent, never a wrong block, so 32 bits is
 * ample.
 */
function hashString(text: string): string {
	let hash = 5381;
	for (let i = 0; i < text.length; i++) {
		hash = (Math.imul(hash, 33) + text.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

/**
 * A stable, order-independent signature of a violation set,
 * scoped to the artifact it was found in. The found text is
 * lower-cased so a recurrence that only changes case is still
 * recognized as the same violation, and the artifact is folded
 * in (as a hash) so the same violation shape in two different
 * bodies signs differently. Without the artifact scope, every
 * single-emdash body collapses to the signature `emdash:—`, so
 * blocking one artifact would relent the next unrelated one on
 * its first fire. The relent is meant to break a loop on the
 * identical resubmission, not to wave through a fresh artifact
 * that happens to share a violation shape.
 */
export function violationSignature(
	violations: Violation[],
	artifact?: string,
): string {
	const body = violations
		.map((v) => `${v.kind}:${v.found.toLowerCase()}`)
		.sort()
		.join("|");
	return artifact ? `${hashString(artifact)}#${body}` : body;
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
	artifact: string,
): GateDecision {
	if (violations.length === 0) {
		return { action: "allow", signature: "", message: "" };
	}

	const signature = violationSignature(violations, artifact);
	if (priorSignatures.includes(signature)) {
		return {
			action: "relent",
			signature,
			message: relentPrefix + format(violations),
		};
	}

	return { action: "block", signature, message: format(violations) };
}
