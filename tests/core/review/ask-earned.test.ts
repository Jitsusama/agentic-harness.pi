import { describe, expect, it } from "vitest";
import type { AskRun } from "../../../lib/core/review/index.ts";
import {
	COUNCILS_BEFORE_ASKING_WHY,
	councilNotEarned,
} from "../../../lib/core/review/index.ts";

function council(witness: string, over: Partial<AskRun> = {}): AskRun {
	return {
		id: `council-${witness}`,
		round: "council",
		startedAt: "2026-11-05T00:00:00.000Z",
		participants: [],
		outcomes: [],
		witness,
		...over,
	};
}

describe("councilNotEarned", () => {
	it("lets a change's first councils go ahead, each at a new commit", () => {
		expect(councilNotEarned([], "aaa", undefined)).toBeUndefined();
		expect(
			councilNotEarned([council("aaa"), council("bbb")], "ccc", undefined),
		).toBeUndefined();
	});

	it("refuses a council at a commit a council already read, naming it", () => {
		const refusal = councilNotEarned([council("aaa")], "aaa", undefined);
		expect(refusal).toContain("council-aaa");
		expect(refusal).toContain("action judge");
		expect(refusal).toContain("intent");
	});

	it("refuses a council past the change's third, at a new commit too", () => {
		const three = ["aaa", "bbb", "ccc"].map((head) => council(head));
		expect(three).toHaveLength(COUNCILS_BEFORE_ASKING_WHY);
		const refusal = councilNotEarned(three, "ddd", undefined);
		expect(refusal).toContain("3 councils");
		expect(refusal).toContain("intent");
	});

	it("lets any council go ahead that says what it is for", () => {
		const three = ["aaa", "bbb", "ccc"].map((head) => council(head));
		expect(
			councilNotEarned(three, "ccc", "the error paths the fix added"),
		).toBeUndefined();
		expect(councilNotEarned(three, "ccc", "  ")).toBeDefined();
	});

	it("counts no round a person closed, nor any other kind of round", () => {
		const earlier = [
			council("aaa", { closed: true }),
			council("bbb", { round: "judge" }),
			council("ccc", { round: "critique" }),
			council("ddd"),
		];
		expect(councilNotEarned(earlier, "aaa", undefined)).toBeUndefined();
		expect(councilNotEarned(earlier, "eee", undefined)).toBeUndefined();
	});
});
