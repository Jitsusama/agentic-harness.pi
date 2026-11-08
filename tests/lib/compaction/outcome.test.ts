import { describe, expect, it } from "vitest";
import {
	COMPACTION_OUTCOME,
	emitOutcome,
	isCompactionOutcome,
} from "../../../lib/compaction/index.ts";

const unused = {
	kind: "ahead-unused",
	sessionId: "s1",
	reason: "the summariser called a tool",
} as const;

describe("a compaction's outcome on the bus", () => {
	it("is said on its versioned channel", () => {
		const said: Array<[string, unknown]> = [];
		emitOutcome(
			{ emit: (channel, data) => said.push([channel, data]) },
			unused,
		);
		expect(said).toEqual([[COMPACTION_OUTCOME, unused]]);
		expect(COMPACTION_OUTCOME).toBe("compaction:outcome:v1");
	});

	it("costs the compaction nothing when a listener throws", () => {
		const throwing = {
			emit: () => {
				throw new Error("a listener broke");
			},
		};
		expect(() => emitOutcome(throwing, unused)).not.toThrow();
	});

	it("is recognised by its kind and session, and nothing else is", () => {
		expect(isCompactionOutcome(unused), "an unused outcome is one").toBe(true);
		expect(
			isCompactionOutcome({ ...unused, kind: "exploded" }),
			"an unknown kind is not an outcome",
		).toBe(false);
		expect(
			isCompactionOutcome({ kind: "failed" }),
			"a kind without a session is not an outcome",
		).toBe(false);
		expect(isCompactionOutcome(null), "null is not an outcome").toBe(false);
	});
});
