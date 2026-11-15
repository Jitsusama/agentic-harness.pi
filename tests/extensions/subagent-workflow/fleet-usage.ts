/** What the fleet run tests beside this share. */

import type { SubagentUsage } from "../../../lib/subagent/subagent.ts";

/** A subagent's usage of so many tokens in and out, at a tenth of a cent a token. */
export function makeUsage(input: number, output: number): SubagentUsage {
	return {
		tokens: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			total: input + output,
		},
		cost: {
			input: input * 0.001,
			output: output * 0.001,
			cacheRead: 0,
			cacheWrite: 0,
			total: (input + output) * 0.001,
		},
	};
}
