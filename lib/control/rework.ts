/**
 * Deterministic detectors need to exclude appraisal, not just find a
 * repeat. A verification pass re-reading a file is cost-of-quality
 * preventing a failure that costs ten to a hundred times more; cutting
 * it lowers measured cost and raises total cost, the best-documented
 * failure mode in the literature this plan keeps citing. So a repeated
 * call is only rework, the genuine waste bucket, when nothing
 * verify-classified ran between the two occurrences. One that follows
 * a verification pass is appraisal instead: the model checking its own
 * work, not asking twice for the same thing.
 */

export interface CallOccurrence {
	readonly argsDigest: string;
	/** Whether this call itself is classified as a verifier (test, build, typecheck, lint or a chained verify). */
	readonly isVerify: boolean;
}

export type RepeatClass = "appraisal" | "rework";

export interface ClassifiedRepeat {
	readonly argsDigest: string;
	readonly classification: RepeatClass;
}

/**
 * Classify every repeat past the first occurrence of each argument
 * digest, in the order the calls actually happened.
 */
export function classifyRepeats(
	occurrences: readonly CallOccurrence[],
): ClassifiedRepeat[] {
	const lastSeenIndex = new Map<string, number>();
	let lastVerifyIndex = -1;
	const classified: ClassifiedRepeat[] = [];

	for (let i = 0; i < occurrences.length; i++) {
		const occurrence = occurrences[i];
		if (occurrence.isVerify) lastVerifyIndex = i;

		const previous = lastSeenIndex.get(occurrence.argsDigest);
		if (previous !== undefined) {
			classified.push({
				argsDigest: occurrence.argsDigest,
				classification: lastVerifyIndex > previous ? "appraisal" : "rework",
			});
		}
		lastSeenIndex.set(occurrence.argsDigest, i);
	}

	return classified;
}
