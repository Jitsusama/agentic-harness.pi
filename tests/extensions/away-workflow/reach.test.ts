import { describe, expect, it } from "vitest";
import {
	blockedNotice,
	freshReach,
	heldAsk,
	heldNotice,
	MOST_SAID,
	stopNotice,
} from "../../../extensions/away-workflow/reach.ts";

describe("reaching the absent person", () => {
	it("says held calls once an absence, and again in the next absence", () => {
		const memory = freshReach();
		expect(heldNotice("PLAN-1", "a", 0, memory)).toBeUndefined();
		expect(heldNotice("PLAN-1", "a", 1, memory)?.urgency).toBe("normal");
		expect(heldNotice("PLAN-1", "a", 2, memory)).toBeUndefined();
		expect(heldNotice("PLAN-1", "b", 1, memory)).toBeDefined();
	});

	it("says each thing a run is blocked on once, and a new thing again", () => {
		const memory = freshReach();
		expect(blockedNotice("q", "a", "Blocked: x", memory)?.body).toBe("x");
		expect(blockedNotice("q", "a", "Blocked: x", memory)).toBeUndefined();
		expect(blockedNotice("q", "a", "Blocked: y", memory)?.body).toBe("y");
		expect(blockedNotice("q", "a", "All good.", memory)).toBeUndefined();
	});

	it("still says something when Blocked names nothing", () => {
		const notice = blockedNotice("q", "a", "Blocked:", freshReach());
		expect(notice?.body).toBe("Everything left needs you.");
	});

	it("keeps a long Blocked line to one notification's worth", () => {
		const long = `Blocked: ${"word ".repeat(100)}`;
		const body = blockedNotice("q", "a", long, freshReach())?.body ?? "";
		expect(body.length).toBe(MOST_SAID);
		expect(body).toMatch(/…$/);
	});

	it("lists every held call for the want, beside a line naming the latest", () => {
		expect(heldAsk([])).toBeUndefined();
		expect(heldAsk([{ title: "Open PR #1" }])).toBeUndefined();
		expect(heldAsk([{ title: "Open PR #1" }, { title: "Push main" }])).toBe(
			"Holds 2 calls for you:\n- Open PR #1\n- Push main",
		);
	});

	it("says a rest once an absence, quietly", () => {
		const memory = freshReach();
		expect(stopNotice("q", "a", "stopped", memory)?.urgency).toBe("low");
		expect(stopNotice("q", "a", "stopped", memory)).toBeUndefined();
	});
});
