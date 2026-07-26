/**
 * Target size, including the exception that decides most real
 * cases: a small target with room around it passes, and the
 * same target crowded by neighbours does not.
 */

import { describe, expect, it } from "vitest";
import {
	type CapturedTarget,
	ENHANCED_TARGET_PX,
	type HitTarget,
	judgeTarget,
	judgeTargets,
	MINIMUM_TARGET_PX,
	renderTargets,
	targetFindings,
} from "../../../../lib/web/audit/target.js";

const at = (
	id: string,
	x: number,
	y: number,
	width = 20,
	height = 20,
	extra: Partial<HitTarget> = {},
): HitTarget => ({ id, rect: { x, y, width, height }, ...extra });

describe("judgeTarget", () => {
	it("passes a target at exactly the minimum", () => {
		const button = at("b", 0, 0, MINIMUM_TARGET_PX, MINIMUM_TARGET_PX);
		expect(judgeTarget(button, [button]).passes).toBe(true);
	});

	it("treats a target too short in one dimension as undersized", () => {
		// Wide but 20 tall, with a neighbour close enough to crowd it.
		const button = at("b", 0, 0, 100, 20);
		const verdict = judgeTarget(button, [button, at("c", 40, 5)]);
		expect(verdict.passes).toBe(false);
	});

	it("measures a full size neighbour by its box, not its centre", () => {
		// A large button's centre can be far away while its edge is
		// right against the small target. Treating every neighbour as
		// a circle passes exactly the crowding this rule is for.
		const small = at("small", 0, 0);
		const wide: HitTarget = {
			id: "wide",
			rect: { x: 12, y: 0, width: 400, height: 40 },
		};
		const verdict = judgeTarget(small, [small, wide]);
		expect(verdict.passes).toBe(false);
		expect(verdict.crowdedBy).toEqual(["wide"]);
	});

	it("clears a full size neighbour whose box is far enough off", () => {
		const small = at("small", 0, 0);
		const wide: HitTarget = {
			id: "wide",
			rect: { x: 100, y: 0, width: 400, height: 40 },
		};
		expect(judgeTarget(small, [small, wide]).passes).toBe(true);
	});

	it("passes a small target with open space around it", () => {
		// This is the spacing exception, and skipping it is what
		// makes a naive checker fail every link in a paragraph.
		const lonely = at("lonely", 0, 0);
		const distant = at("distant", 500, 500);
		const verdict = judgeTarget(lonely, [lonely, distant]);
		expect(verdict.passes).toBe(true);
		expect(verdict.exception).toBe("spacing");
	});

	it("fails a small target crowded by a neighbour, and names it", () => {
		const first = at("first", 0, 0);
		const second = at("second", 22, 0);
		const verdict = judgeTarget(first, [first, second]);
		expect(verdict.passes).toBe(false);
		expect(verdict.crowdedBy).toEqual(["second"]);
	});

	it("measures crowding centre to centre, not edge to edge", () => {
		// Two 20px targets 5px apart have centres 25px apart, which
		// clears a 24px circle even though the boxes nearly touch.
		const first = at("first", 0, 0);
		const second = at("second", 25, 0);
		expect(judgeTarget(first, [first, second]).passes).toBe(true);
	});

	it("does not count itself as a crowding neighbour", () => {
		const only = at("only", 0, 0);
		expect(judgeTarget(only, [only]).passes).toBe(true);
	});

	it("excepts a target sitting in a line of text", () => {
		const link = at("link", 0, 0, 30, 18, { inline: true });
		const verdict = judgeTarget(link, [link, at("other", 5, 0)]);
		expect(verdict.passes).toBe(true);
		expect(verdict.exception).toBe("inline");
	});

	it("excepts a control the browser sizes itself", () => {
		const box = at("box", 0, 0, 13, 13, { userAgentControlled: true });
		expect(judgeTarget(box, [box, at("n", 5, 0)]).exception).toBe("user-agent");
	});

	it("excepts one with the same action available larger elsewhere", () => {
		const small = at("small", 0, 0, 16, 16, { hasLargerAlternative: true });
		expect(judgeTarget(small, [small, at("n", 5, 0)]).exception).toBe(
			"alternative",
		);
	});

	it("excepts one whose exact size is the point", () => {
		const pin = at("pin", 0, 0, 8, 8, { essential: true });
		expect(judgeTarget(pin, [pin, at("n", 2, 0)]).exception).toBe("essential");
	});

	it("checks the outright exceptions before measuring spacing", () => {
		// An inline link crowded on all sides is still excepted, so
		// the verdict must not report it as crowded.
		const link = at("link", 20, 0, 30, 18, { inline: true });
		const verdict = judgeTarget(link, [
			link,
			at("before", 0, 0),
			at("after", 40, 0),
		]);
		expect(verdict.crowdedBy).toBeUndefined();
	});

	it("holds a target to 44 pixels at AAA", () => {
		const button = at("b", 0, 0, 30, 30);
		const verdict = judgeTarget(button, [button], "AAA");
		expect(verdict.required).toBe(ENHANCED_TARGET_PX);
		expect(verdict.passes).toBe(false);
	});

	it("gives AAA no spacing exception, since it has none", () => {
		const lonely = at("lonely", 0, 0, 30, 30);
		const verdict = judgeTarget(lonely, [lonely], "AAA");
		expect(verdict.passes).toBe(false);
		expect(verdict.exception).toBeUndefined();
	});
});

describe("judgeTargets", () => {
	it("judges a crowded row as failing on both sides", () => {
		const row = [at("a", 0, 0), at("b", 20, 0), at("c", 40, 0)];
		const verdicts = judgeTargets(row);
		expect(verdicts.every((verdict) => !verdict.passes)).toBe(true);
		expect(verdicts[1]?.crowdedBy).toEqual(["a", "c"]);
	});
});

describe("renderTargets", () => {
	it("says so when there is nothing to measure", () => {
		expect(renderTargets([])).toContain("No targets");
	});

	it("reports a clean sweep as a measured fact", () => {
		const big = at("b", 0, 0, 40, 40);
		expect(renderTargets(judgeTargets([big]))).toContain("All 1 targets meet");
	});

	it("counts the excepted ones rather than hiding them", () => {
		const lonely = at("lonely", 0, 0);
		expect(renderTargets(judgeTargets([lonely]))).toContain("excepted");
	});

	it("names what crowded each failure", () => {
		const out = renderTargets(judgeTargets([at("a", 0, 0), at("b", 20, 0)]));
		expect(out).toContain("crowded by b");
	});

	it("summarises the tail rather than listing forty of them", () => {
		const many = Array.from({ length: 40 }, (_, at_) =>
			at(`t${at_}`, at_ * 10, 0),
		);
		const out = renderTargets(judgeTargets(many));
		expect(out).toContain("and 30 more");
		expect(out.split("\n").length).toBeLessThan(16);
	});
});

describe("target verdicts reach the accessibility report", () => {
	// Measured off the fixture: three 16 by 16 buttons two pixels
	// apart, one inline link in a sentence, one 48 by 48 button.
	const captured: CapturedTarget[] = [
		{
			id: "t0",
			selector: "a",
			rect: { x: 139.8, y: 108.9, width: 88.6, height: 18 },
			inline: true,
		},
		{
			id: "t1",
			selector: "button.tiny",
			rect: { x: 28, y: 160.9, width: 16, height: 16 },
		},
		{
			id: "t2",
			selector: "button.tiny",
			rect: { x: 46, y: 160.9, width: 16, height: 16 },
		},
		{
			id: "t3",
			selector: "button.tiny",
			rect: { x: 64, y: 160.9, width: 16, height: 16 },
		},
		{
			id: "t4",
			selector: "button.big",
			rect: { x: 28, y: 186.9, width: 48, height: 48 },
		},
	];

	it("reports the crowded undersized targets and nothing else", () => {
		// 2.5.8 was measured by nothing at all: axe ships
		// target-size disabled and this arithmetic had no caller.
		const findings = targetFindings(captured);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.criteria).toEqual(["2.5.8"]);
		expect(findings[0]?.nodes.map((node) => node.selector)).toEqual([
			"button.tiny",
			"button.tiny",
			"button.tiny",
		]);
	});

	it("says nothing when every target is big enough or excepted", () => {
		const roomy = captured.filter((target) => target.id === "t4");
		expect(targetFindings(roomy)).toEqual([]);
	});

	it("excepts a link inside a sentence", () => {
		const inline = captured.filter((target) => target.inline);
		expect(targetFindings(inline)).toEqual([]);
	});
});
