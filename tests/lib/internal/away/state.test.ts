import { beforeEach, describe, expect, it } from "vitest";
import {
	awayGoal,
	comeBack,
	decide,
	fingerprintOf,
	goAway,
	hold,
	isAway,
	onAwayChange,
	planProgress,
	resetAway,
	restore,
	setProgressSource,
	snapshot,
} from "../../../../lib/internal/away/state.ts";

beforeEach(() => {
	resetAway();
});

describe("an absence", () => {
	it("starts once and ends with what waited", () => {
		expect(goAway("finish the plan", new Date("2026-10-12T22:00:00Z"))).toBe(
			true,
		);
		expect(isAway()).toBe(true);

		hold({ guard: "slack", title: "Send", body: "hi" });
		decide({ question: "Which?", answer: "a", by: "recommendation" });
		const back = comeBack();

		expect(isAway()).toBe(false);
		expect(back?.since).toBe("2026-10-12T22:00:00.000Z");
		expect(back?.goal).toBe("finish the plan");
		expect(back?.held.map((h) => [h.id, h.title])).toEqual([[1, "Send"]]);
		expect(back?.decided.map((d) => d.answer)).toEqual(["a"]);
		expect(comeBack()).toBeUndefined();
	});

	it("takes a goal said again as the newer one, without starting over", () => {
		goAway("first");
		hold({ guard: "slack", title: "Send" });

		expect(goAway("second")).toBe(false);
		expect(awayGoal()).toBe("second");
		expect(snapshot().held).toHaveLength(1);
	});

	it("starts the next absence with nothing held", () => {
		goAway();
		hold({ guard: "slack", title: "Send" });
		comeBack();
		goAway();

		expect(hold({ guard: "slack", title: "Other" }).id).toBe(1);
	});

	it("holds the same call once", () => {
		goAway();
		const first = hold({ guard: "slack", title: "Send", body: "hi" });
		const again = hold({ guard: "slack", title: "Send", body: "hi" });

		expect(again.id).toBe(first.id);
		expect(snapshot().held).toHaveLength(1);
	});
});

describe("fingerprints", () => {
	it("tell calls apart by guard, title and body", () => {
		const base = fingerprintOf("slack", "Send", "hi");

		expect(fingerprintOf("google", "Send", "hi")).not.toBe(base);
		expect(fingerprintOf("slack", "Reply", "hi")).not.toBe(base);
		expect(fingerprintOf("slack", "Send", "bye")).not.toBe(base);
		expect(fingerprintOf("slack", "Send")).toBe(
			fingerprintOf("slack", "Send", ""),
		);
	});
});

describe("plan progress", () => {
	it("comes from whoever registered it, and is absent otherwise", () => {
		expect(planProgress()).toBeUndefined();

		setProgressSource(() => ({ document: "PLAN-1", done: 1, total: 3 }));

		expect(planProgress()).toEqual({ document: "PLAN-1", done: 1, total: 3 });
	});

	it("is absent when the source throws", () => {
		setProgressSource(() => {
			throw new Error("stale");
		});

		expect(planProgress()).toBeUndefined();
	});
});

describe("persistence", () => {
	it("survives a snapshot and restore", () => {
		goAway("asleep");
		hold({ guard: "slack", title: "Send", body: "hi" });
		const saved = snapshot();
		resetAway();

		restore(saved);

		expect(isAway()).toBe(true);
		expect(snapshot()).toEqual(saved);
	});

	it("tells listeners about every change, and survives one that throws", () => {
		const seen: boolean[] = [];
		const disposeBroken = onAwayChange(() => {
			throw new Error("stale pi");
		});
		const dispose = onAwayChange((now) => seen.push(now.since !== undefined));

		goAway();
		comeBack();
		dispose();
		disposeBroken();
		goAway();

		expect(seen).toEqual([true, false]);
	});
});
