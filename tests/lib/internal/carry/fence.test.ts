/**
 * The fence a session carries: read from its `PI_SANDBOX`, and arriving
 * only under the same one, unless it ran unfenced.
 */

import { describe, expect, it } from "vitest";
import {
	fenceKindOf,
	isFenceKind,
	looserFence,
} from "../../../../lib/internal/carry/fence.ts";

describe("a carried session's fence", () => {
	it("is what its PI_SANDBOX asks for", () => {
		expect(fenceKindOf({ PI_SANDBOX: "strict" })).toBe("strict");
		expect(fenceKindOf({ PI_SANDBOX: "fence" })).toBe("fence");
		expect(fenceKindOf({ PI_SANDBOX: "off" })).toBe("none");
	});

	it("arrives under its own kind, and an unfenced one under any", () => {
		expect(looserFence("fence", "fence")).toBeUndefined();
		expect(looserFence("strict", "strict")).toBeUndefined();
		expect(looserFence("none", "fence")).toBeUndefined();
		expect(looserFence("none", "none")).toBeUndefined();
	});

	it("never arrives under another, saying which to start it with", () => {
		expect(looserFence("fence", "none")).toBe(
			"It ran under PI_SANDBOX=fence, but would start here under no fence, and a move never changes a session's fence. Start it with PI_SANDBOX=fence.",
		);
		expect(looserFence("strict", "fence")).toMatch(
			/under PI_SANDBOX=strict, but would start here under PI_SANDBOX=fence.*Start it with PI_SANDBOX=strict\.$/,
		);
	});

	it("is named only as a harness names it", () => {
		expect(["none", "fence", "strict"].filter(isFenceKind)).toHaveLength(3);
		expect(isFenceKind("loose"), "a stray word").toBe(false);
		expect(isFenceKind(undefined), "nothing at all").toBe(false);
	});
});
