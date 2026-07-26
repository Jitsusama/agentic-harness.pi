/**
 * Gesture composition. Pinch is the interesting one: two
 * fingers whose distance changes is something no single event
 * can express.
 */

import { describe, expect, it } from "vitest";
import {
	composeLongPress,
	composePinch,
	composeSwipe,
	composeTap,
	LONG_PRESS_MS,
} from "../../../../lib/web/input/touch.js";

describe("composeTap", () => {
	it("puts one finger down and lifts it", () => {
		const tap = composeTap({ x: 20, y: 30 });
		expect(tap.map((step) => step.type)).toEqual(["touchStart", "touchEnd"]);
		expect(tap[0]?.points).toEqual([{ x: 20, y: 30, id: 0 }]);
	});

	it("lifts with no points, since a lifted finger has no place", () => {
		expect(composeTap({ x: 1, y: 1 }).at(-1)?.points).toEqual([]);
	});
});

describe("composeLongPress", () => {
	it("holds before lifting", () => {
		const press = composeLongPress({ x: 5, y: 5 });
		expect(press[0]?.pauseMs).toBe(LONG_PRESS_MS);
	});

	it("holds for as long as asked", () => {
		expect(composeLongPress({ x: 5, y: 5 }, 1200)[0]?.pauseMs).toBe(1200);
	});

	it("holds long enough for a context menu to notice", () => {
		expect(LONG_PRESS_MS).toBeGreaterThanOrEqual(500);
	});
});

describe("composeSwipe", () => {
	const swipe = composeSwipe(
		{ x: 200, y: 400 },
		{ x: 200, y: 100 },
		{
			steps: 5,
		},
	);

	it("starts where the finger lands", () => {
		expect(swipe[0]).toMatchObject({ type: "touchStart" });
		expect(swipe[0]?.points[0]).toMatchObject({ x: 200, y: 400 });
	});

	it("moves in between, which is what tells a swipe from a tap", () => {
		expect(swipe.filter((step) => step.type === "touchMove")).toHaveLength(5);
	});

	it("ends at the destination", () => {
		const lastMove = swipe.filter((step) => step.type === "touchMove").at(-1);
		expect(lastMove?.points[0]).toMatchObject({ x: 200, y: 100 });
	});

	it("keeps the same finger throughout", () => {
		const ids = new Set(
			swipe.flatMap((step) => step.points.map((point) => point.id)),
		);
		expect([...ids]).toEqual([0]);
	});
});

describe("composePinch", () => {
	const pinch = composePinch({ x: 100, y: 100 }, 40, 200, { steps: 4 });

	it("uses two fingers", () => {
		expect(pinch[0]?.points).toHaveLength(2);
		expect(pinch[0]?.points.map((point) => point.id)).toEqual([0, 1]);
	});

	it("places them either side of the centre", () => {
		expect(pinch[0]?.points[0]?.x).toBe(80);
		expect(pinch[0]?.points[1]?.x).toBe(120);
	});

	it("spreads them apart to zoom in", () => {
		const last = pinch.filter((step) => step.type === "touchMove").at(-1);
		const [left, right] = last?.points ?? [];
		expect((right?.x ?? 0) - (left?.x ?? 0)).toBe(200);
	});

	it("brings them together to zoom out", () => {
		const out = composePinch({ x: 100, y: 100 }, 200, 40, { steps: 3 });
		const last = out.filter((step) => step.type === "touchMove").at(-1);
		const [left, right] = last?.points ?? [];
		expect((right?.x ?? 0) - (left?.x ?? 0)).toBe(40);
	});

	it("keeps the centre still while the spread changes", () => {
		for (const step of pinch) {
			if (step.points.length !== 2) continue;
			const [left, right] = step.points;
			expect(((left?.x ?? 0) + (right?.x ?? 0)) / 2).toBe(100);
		}
	});

	it("lifts both fingers at the end", () => {
		expect(pinch.at(-1)).toMatchObject({ type: "touchEnd", points: [] });
	});
});
