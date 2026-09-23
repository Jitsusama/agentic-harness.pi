import { shortDigest } from "../internal/digest.ts";

/**
 * Turning a demotion candidate into what actually gets sent in its
 * place: a stub naming what was there and how to ask for it back. The
 * digest is the entire reversibility story: as long as something on
 * the other end can look a digest up, cutting the bytes here loses
 * nothing that a later turn could not still recover.
 */

export interface DemotionInput {
	readonly index: number;
	readonly toolName: string;
	readonly text: string;
}

export interface Demotion {
	readonly index: number;
	readonly digest: string;
	readonly originalChars: number;
	readonly stubText: string;
}

function stubText(toolName: string, chars: number, digest: string): string {
	return `[${toolName} result demoted: ${chars} chars, digest ${digest}. Call expand_demoted with this digest to see it again.]`;
}

/** Plan a stub for each demotion candidate, keyed to its original position. */
export function planDemotions(inputs: readonly DemotionInput[]): Demotion[] {
	return inputs.map((input) => {
		const digest = shortDigest(input.text);
		return {
			index: input.index,
			digest,
			originalChars: input.text.length,
			stubText: stubText(input.toolName, input.text.length, digest),
		};
	});
}
