import { describe, expect, it } from "vitest";
import { placementFence } from "../../../../extensions/quest-workflow/verbs/spawn-stage.ts";

const declared = { kind: "fence", from: "spawn" } as const;
const unfenced = { kind: "none", from: "default" };
const session = "019a0000-0000-7000-8000-000000000001";

describe("the fence a spawn tells the node when asking where it runs", () => {
	it("is the one declared for a fresh spawn", () => {
		expect(
			placementFence(declared, { resumes: false }),
			"nothing to resume",
		).toEqual(declared);
		expect(
			placementFence(declared, { command: "pi --model x", resumes: true }),
			"a command of the caller's own resumes nothing",
		).toEqual(declared);
	});

	it("is none for one that may reopen, which is given no sandbox", () => {
		expect(
			placementFence(declared, {
				command: `pi --session ${session}`,
				resumes: false,
			}),
			"a command that reopens",
		).toEqual(unfenced);
		expect(
			placementFence(declared, { resumes: true }),
			"a session it would resume",
		).toEqual(unfenced);
	});
});
