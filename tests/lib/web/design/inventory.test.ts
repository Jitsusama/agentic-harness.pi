/**
 * The design inventory, and the clustering that makes it worth
 * reading. The colour values are ones a live page produced.
 */

import { describe, expect, it } from "vitest";
import {
	canonicalLengths,
	clusterUsage,
	coloursAreNear,
	exactlyEqual,
	lengthsAreNear,
	renderInventory,
	type StyleSample,
	takeInventory,
	tallyUsage,
	type Usage,
} from "../../../../lib/web/design/inventory.js";

const sample = (
	selector: string,
	values: Record<string, string>,
): StyleSample => ({ selector, values });

/** Four greys one step apart, which is the classic drift. */
const GREYS = [
	sample("p.g1", { color: "rgb(118, 118, 118)" }),
	sample("p.g2", { color: "rgb(119, 119, 119)" }),
	sample("p.g3", { color: "rgb(117, 117, 117)" }),
	sample("p.g4", { color: "rgb(120, 120, 120)" }),
	sample("p.g1b", { color: "rgb(118, 118, 118)" }),
];

describe("sub-pixel noise is not a design decision", () => {
	// Measured on a real page: the same authored line height came
	// back as both "24px" and "24.0001px", the report clustered
	// them, and check design warned about drift between a number and
	// itself. Nobody chose 24.0001px.
	it("counts one authored length once, however it was computed", () => {
		const usages = tallyUsage(
			[
				sample("p.a", { "line-height": "24px" }),
				sample("p.b", { "line-height": "24.0001px" }),
				sample("p.c", { "line-height": "24.000000001px" }),
			],
			"line-height",
		);
		expect(usages).toHaveLength(1);
		expect(usages[0]?.value).toBe("24px");
		expect(usages[0]?.count).toBe(3);
	});

	it("keeps a difference a person could have meant", () => {
		// A third of a pixel is small but authored, so it survives.
		expect(
			tallyUsage(
				[
					sample("p.a", { "line-height": "24px" }),
					sample("p.b", { "line-height": "24.33px" }),
				],
				"line-height",
			),
		).toHaveLength(2);
	});

	it("canonicalises every length in a compound value", () => {
		expect(canonicalLengths("0px 2.0001px 4px rgba(0, 0, 0, 0.1)")).toBe(
			"0px 2px 4px rgba(0, 0, 0, 0.1)",
		);
	});

	it("leaves a value with no lengths alone", () => {
		expect(canonicalLengths("rgb(118, 118, 118)")).toBe("rgb(118, 118, 118)");
		expect(canonicalLengths("none")).toBe("none");
	});

	it("does not invent a trailing zero as a third spelling", () => {
		expect(canonicalLengths("24.10px")).toBe("24.1px");
	});
});

describe("tallyUsage", () => {
	it("counts each value and orders by how often it appears", () => {
		const usages = tallyUsage(GREYS, "color");
		expect(usages[0]?.value).toBe("rgb(118, 118, 118)");
		expect(usages[0]?.count).toBe(2);
	});

	it("remembers a few places each value was used", () => {
		expect(tallyUsage(GREYS, "color")[0]?.examples).toEqual(["p.g1", "p.g1b"]);
	});

	it("keeps at most three examples, however many there are", () => {
		const many = Array.from({ length: 20 }, (_, index) =>
			sample(`p${index}`, { color: "red" }),
		);
		expect(tallyUsage(many, "color")[0]?.examples).toHaveLength(3);
	});

	it("ignores a property the sample does not carry", () => {
		expect(tallyUsage(GREYS, "box-shadow")).toEqual([]);
	});
});

describe("coloursAreNear", () => {
	it("calls two greys one step apart the same intent", () => {
		expect(coloursAreNear("rgb(118, 118, 118)", "rgb(119, 119, 119)")).toBe(
			true,
		);
	});

	it("keeps genuinely different colours apart", () => {
		expect(coloursAreNear("rgb(0, 85, 204)", "rgb(204, 51, 0)")).toBe(false);
	});

	it("does not treat transparent as a near-black", () => {
		// Both parse to zeroes, and a channel comparison would call
		// them the same thing, which they emphatically are not.
		expect(coloursAreNear("rgba(0, 0, 0, 0)", "rgb(0, 0, 0)")).toBe(false);
	});

	it("says nothing about a value it cannot read", () => {
		expect(coloursAreNear("oklch(0.7 0.1 200)", "rgb(0, 0, 0)")).toBe(false);
	});
});

describe("lengthsAreNear", () => {
	it("calls 16px and 15px one intent", () => {
		expect(lengthsAreNear("16px", "15px")).toBe(true);
	});

	it("keeps 16px and 24px apart", () => {
		expect(lengthsAreNear("16px", "24px")).toBe(false);
	});

	it("keeps a deliberate type step apart", () => {
		// 14 and 16 are a step in any type scale. A purely relative
		// threshold called them one value, which is what sent me
		// looking for a second, absolute one.
		expect(lengthsAreNear("14px", "16px")).toBe(false);
	});

	it("still catches drift at the small end", () => {
		// 4 and 5 pixels of radius is a fifth apart in relative
		// terms and obviously the same intent in real ones.
		expect(lengthsAreNear("4px", "5px")).toBe(true);
	});

	it("catches drift at the large end that relative terms hide", () => {
		expect(lengthsAreNear("32px", "30px")).toBe(true);
		expect(lengthsAreNear("32px", "24px")).toBe(false);
	});

	it("gives zero no neighbours, since nothing is nearly nothing", () => {
		expect(lengthsAreNear("0px", "1px")).toBe(false);
	});

	it("reads the first length out of a shadow", () => {
		expect(
			lengthsAreNear(
				"rgba(0, 0, 0, 0.1) 0px 1px 2px 0px",
				"rgba(0, 0, 0, 0.12) 0px 1px 3px 0px",
			),
		).toBe(true);
	});
});

describe("clusterUsage", () => {
	const usage = (value: string, count: number): Usage => ({
		value,
		count,
		examples: [],
	});

	it("gathers the near values around the most used one", () => {
		const clusters = clusterUsage(
			[
				usage("rgb(118, 118, 118)", 40),
				usage("rgb(119, 119, 119)", 2),
				usage("rgb(117, 117, 117)", 1),
			],
			coloursAreNear,
		);
		expect(clusters[0]?.leader.count).toBe(40);
		expect(clusters[0]?.nearby).toHaveLength(2);
		expect(clusters[0]?.total).toBe(43);
	});

	it("reports nothing when every value stands alone", () => {
		expect(
			clusterUsage(
				[usage("rgb(0, 0, 0)", 5), usage("rgb(255, 255, 255)", 5)],
				coloursAreNear,
			),
		).toEqual([]);
	});

	it("does not put one value in two clusters", () => {
		// A chain of near neighbours must resolve to one group, or
		// the counts stop adding up.
		const clusters = clusterUsage(
			[usage("16px", 10), usage("15px", 5), usage("17px", 3), usage("48px", 1)],
			lengthsAreNear,
		);
		const named = clusters.flatMap((cluster) => [
			cluster.leader.value,
			...cluster.nearby.map((one) => one.value),
		]);
		expect(new Set(named).size).toBe(named.length);
	});

	it("finds nothing when values must match exactly", () => {
		expect(
			clusterUsage([usage("Georgia", 1), usage("system-ui", 9)], exactlyEqual),
		).toEqual([]);
	});
});

describe("takeInventory", () => {
	it("reports a dimension per property that was sampled", () => {
		const inventory = takeInventory(GREYS);
		expect(inventory).toHaveLength(1);
		expect(inventory[0]?.property).toBe("color");
		expect(inventory[0]?.distinct).toBe(4);
	});

	it("finds the drift in the greys", () => {
		const [colour] = takeInventory(GREYS);
		expect(colour?.clusters).toHaveLength(1);
		expect(colour?.clusters[0]?.total).toBe(5);
	});

	it("leaves out a property nothing used", () => {
		expect(
			takeInventory(GREYS).some(
				(dimension) => dimension.property === "border-radius",
			),
		).toBe(false);
	});
});

describe("renderInventory", () => {
	it("says plainly when nothing was sampled", () => {
		expect(renderInventory([])).toContain("Nothing was sampled");
	});

	it("leads with a verdict and how many properties look like drift", () => {
		const out = renderInventory(takeInventory(GREYS));
		expect(out).toContain("1 of 1 properties hold values close enough");
		// Drift is a question rather than a failure: two blues a
		// step apart may well be a hover state.
		expect(out.startsWith("WARN")).toBe(true);
	});

	it("passes a page whose values all stand apart", () => {
		const clean = takeInventory([
			sample("a", { color: "rgb(0, 0, 0)" }),
			sample("b", { color: "rgb(255, 255, 255)" }),
		]);
		expect(renderInventory(clean).startsWith("PASS")).toBe(true);
	});

	it("says what it sampled, so a clean pass is not a shrug", () => {
		expect(renderInventory(takeInventory(GREYS))).toContain(
			"Sampled 4 distinct values",
		);
	});

	it("says outright when nothing looks accidental", () => {
		const clean = takeInventory([
			sample("a", { color: "rgb(0, 0, 0)" }),
			sample("b", { color: "rgb(255, 255, 255)" }),
		]);
		expect(renderInventory(clean)).toContain("No two values were close");
	});

	it("names the leader and what sits beside it", () => {
		const out = renderInventory(takeInventory(GREYS));
		expect(out).toContain("rgb(118, 118, 118) (2) sits beside");
	});

	it("gives one property in full when asked", () => {
		const out = renderInventory(takeInventory(GREYS), { property: "color" });
		expect(out).toContain("p.g1");
		expect(out).not.toContain("Name a property");
	});

	it("lists what was sampled when asked for something absent", () => {
		expect(
			renderInventory(takeInventory(GREYS), { property: "nonsense" }),
		).toContain("color");
	});

	it("summarises a long tail rather than printing all of it", () => {
		const many = Array.from({ length: 40 }, (_, index) =>
			sample(`p${index}`, { "font-family": `Face${index}` }),
		);
		const out = renderInventory(takeInventory(many));
		expect(out).toContain("and 32 more");
	});
});

describe("nearness is about how two values look", () => {
	it("does not call pure red and a mid grey one colour", () => {
		// Contrast compares relative luminance and nothing else, so
		// it rates this pair at about 1.001 and any sameness
		// threshold accepted it. Delta E puts them 104 apart.
		expect(coloursAreNear("rgb(255, 0, 0)", "rgb(127, 127, 127)")).toBe(false);
	});

	it("still clusters two greys a step apart", () => {
		expect(coloursAreNear("rgb(102, 102, 102)", "rgb(104, 104, 104)")).toBe(
			true,
		);
	});

	it("leaves a deliberate palette step alone", () => {
		// Two neighbouring blues from a real scale.
		expect(coloursAreNear("rgb(59, 130, 246)", "rgb(37, 99, 235)")).toBe(false);
	});

	it("keeps a colour apart from its own translucent version", () => {
		expect(coloursAreNear("rgba(0, 0, 0, 1)", "rgba(0, 0, 0, 0.5)")).toBe(
			false,
		);
	});

	it("compares every length in a value, not just the first", () => {
		// Reading only the first number made every shadow whose x
		// offset is 0px cluster with every other, which is all of
		// them, and called two different paddings one value.
		expect(lengthsAreNear("0px 1px 2px", "0px 2px 4px")).toBe(false);
		expect(lengthsAreNear("8px 16px", "8px 4px")).toBe(false);
	});

	it("still clusters a shadow that drifted slightly", () => {
		expect(lengthsAreNear("0px 1px 2px", "0px 1px 2.5px")).toBe(true);
	});

	it("does not cluster values with different numbers of parts", () => {
		expect(lengthsAreNear("8px", "8px 8px")).toBe(false);
	});
});
