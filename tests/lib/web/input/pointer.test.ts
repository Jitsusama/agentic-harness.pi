/**
 * Pointer composition. The tests are about ordering and about
 * the events a handler needs to see, not about arithmetic.
 */

import { describe, expect, it } from "vitest";
import {
	composeClick,
	composeDrag,
	interpolate,
} from "../../../../lib/web/input/pointer.js";

describe("interpolate", () => {
	it("lands exactly on the destination", () => {
		const points = interpolate({ x: 0, y: 0 }, { x: 100, y: 50 }, 5);
		expect(points.at(-1)).toEqual({ x: 100, y: 50 });
	});

	it("makes as many points as asked for", () => {
		expect(interpolate({ x: 0, y: 0 }, { x: 10, y: 0 }, 4)).toHaveLength(4);
	});

	it("travels in order", () => {
		const xs = interpolate({ x: 0, y: 0 }, { x: 10, y: 0 }, 5).map((p) => p.x);
		expect(xs).toEqual([...xs].sort((a, b) => a - b));
	});

	it("still arrives when asked for no steps at all", () => {
		expect(interpolate({ x: 0, y: 0 }, { x: 7, y: 7 }, 0)).toEqual([
			{ x: 7, y: 7 },
		]);
	});
});

describe("composeDrag", () => {
	const drag = composeDrag({ x: 10, y: 10 }, { x: 90, y: 40 }, { steps: 4 });

	it("arrives before it presses, so it grabs the right element", () => {
		expect(drag[0]).toMatchObject({ type: "mouseMoved", x: 10, y: 10 });
		expect(drag[1]).toMatchObject({ type: "mousePressed", x: 10, y: 10 });
	});

	it("moves while the button is down", () => {
		const moving = drag.filter(
			(step) => step.type === "mouseMoved" && step.button === "left",
		);
		expect(moving).toHaveLength(4);
	});

	it("releases at the destination", () => {
		expect(drag.at(-1)).toMatchObject({
			type: "mouseReleased",
			x: 90,
			y: 40,
		});
	});

	it("presses no button on the approach", () => {
		expect(drag[0]?.button).toBe("none");
	});

	it("takes several steps by default, so a handler runs more than once", () => {
		const moves = composeDrag({ x: 0, y: 0 }, { x: 50, y: 0 }).filter(
			(step) => step.type === "mouseMoved",
		);
		expect(moves.length).toBeGreaterThan(2);
	});

	it("drags with another button when told to", () => {
		const right = composeDrag(
			{ x: 0, y: 0 },
			{ x: 5, y: 5 },
			{
				button: "right",
			},
		);
		expect(right[1]?.button).toBe("right");
	});
});

describe("composeClick", () => {
	it("moves to the point before pressing", () => {
		expect(composeClick({ x: 4, y: 8 })[0]).toMatchObject({
			type: "mouseMoved",
			x: 4,
			y: 8,
		});
	});

	it("presses and releases once", () => {
		const click = composeClick({ x: 1, y: 1 });
		expect(click.filter((s) => s.type === "mousePressed")).toHaveLength(1);
		expect(click.filter((s) => s.type === "mouseReleased")).toHaveLength(1);
	});

	it("raises the count across a double click, which is what dblclick reads", () => {
		const counts = composeClick({ x: 1, y: 1 }, { count: 2 })
			.filter((step) => step.type === "mousePressed")
			.map((step) => step.clickCount);
		expect(counts).toEqual([1, 2]);
	});

	it("never composes a click with no press", () => {
		expect(
			composeClick({ x: 1, y: 1 }, { count: 0 }).filter(
				(s) => s.type === "mousePressed",
			),
		).toHaveLength(1);
	});
});
